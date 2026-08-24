# ADR-019: Logical Model vs. Instance Split

## Status

Accepted. Refines [ADR-014](adr-014-inference-recency-tracking.md) (inference recency stays
per-logical-model, not per-instance). Additive within [ADR-005](adr-005-openapi-contracts.md)
(new/changed schemas and paths in `control-plane.yaml` / `worker-agent.yaml`; the Rust-mirrored
`proxy-control-plane.yaml` is unchanged). Premise: [#121](https://github.com/rh-aiservices-bu/school-of-sardeenz/issues/121)'s
option A — `models` is the configuration registry, not a running-instance record.

## Context

Before this change, the control plane treated "model" and "instance" as the same entity: one model
name mapped to exactly one runner on one worker. Postgres enforced `name text UNIQUE NOT NULL`; the
Redis lifecycle blob (`ModelState`) held exactly one `workerId`/`runnerHost`/`runnerPort` per model;
deploying an already-deployed model name returned `409`. This blocked two v1-parity objectives:
running N replicas of one model with the proxy balancing across them, and moving a model between
workers by deploying elsewhere, shifting traffic, then stopping the old placement.

The data path was already built for this. `RoutingEntry.endpoints` is an array with per-endpoint
`weight`/`healthy` fields (`proxy-control-plane.yaml`), and the proxy's weighted balancer
(`proxy/src/forwarding/balancer.rs`) already selects among `endpoints.some(e => e.healthy && e.weight

> 0)`. Only the control plane's model of the world — and the worker agent's, which independently
enforced one-runner-per-model-name via `modelToRunner: Map<string, string>` — prevented it.

## Decision

Split "model" into two concepts:

- **Logical model** — the name clients request and the proxy routes on; a row in Postgres `models`
  holding configuration only (`runner_type`, `model_path`, `required_memory`, `device_type`,
  `tensor_parallel`, `engine_config`, `runtime_module`, `pinned`). Nothing moves out of `models`;
  every existing column was already configuration, not runtime state.
- **Instance** — one runner process on one worker, with its own lifecycle state, VRAM reservation,
  and routing endpoint. Identified by a control-plane-minted `instanceId` (`"inst-" +
randomUUID().replace(/-/g,'').slice(0,12)`), chosen over a derived id (e.g. `modelName-N`) to
  avoid a coordination point where two concurrent creates could pick the same suffix.

Concretely:

1. **Redis lifecycle state moves from one key per model to one key per instance** —
   `{prefix}:models:{modelName}:{instanceId}`, holding the renamed `InstanceState` (former
   `ModelState`, same fields, plus `instanceId`). The separator is unambiguous because model names
   cannot contain `:` (`MODEL_NAME_PATTERN`) and instance ids are `inst-<hex>` (no `:`/glob chars).
   `ModelLifecycleService` gains `getInstance`, `getInstancesForModel`, `getAllInstances`,
   `createInstance`, `removeInstance`, all instance-scoped; `transition` and `setRunnerEndpoint`
   take `instanceId` as well as `modelName`. `getAllInstances` requires two `:`-delimited segments
   after the `models:` prefix (`models:*:*`, not a bare `models:*`) — see point 12 below.
2. **The logical model's state is derived on read**, never stored: `deriveAggregateState` ranks a
   model's instances by precedence `ACTIVE > STARTING > DRAINING > SLEEPING > PENDING > STOPPING >
ERROR` and returns the highest-ranked one present (STOPPED instances don't count — they're a
   transient artifact between an instance's stop sequence finishing and its Redis key being
   deleted); a model with no live instances is `STOPPED`. ACTIVE outranks ERROR deliberately: one
   healthy replica must mask a broken one (M7 acceptance criterion 4). This is exactly the rule
   `GET /api/v1/models` and `GET /api/v1/models/{modelName}` apply, and the one
   `refreshModelRoutingState` (new helper in `sleep-wake.ts`, used by deploy orchestration,
   sleep/wake, and reconciliation) applies to keep the routing map's per-model `state` field
   consistent with the instance set — replacing the old pattern of stamping a fixed `ModelState`
   value on every model-level operation, which would have been wrong the moment a second instance
   existed (e.g. sleeping one of two ACTIVE replicas must not flip the model to SLEEPING).
3. **Postgres gains an `instances` table** (migration `003-instances.sql`): `instance_id` (PK),
   `model_name` (FK → `models(name)` `ON DELETE CASCADE`), `worker_id`, `device_indices`,
   timestamps. No `UNIQUE(model_name, worker_id)` — same-worker replicas are in scope. Additive,
   empty-start migration; existing rows become logical models with zero recorded instances,
   repopulated by future deploys (no backfill from Redis — that would couple a SQL migration to
   runtime state that reconciliation already owns). The table is written **synchronously at instance
   create/delete**, the same low cadence as the `models` row today — not on every Redis state
   transition. Redis stays authoritative for runtime state; a reconciliation step
   (`reconcileInstanceTable`) prunes Postgres rows whose Redis state has vanished (a stop/evict/
   dead-worker/stuck-instance cleanup that completed on the Redis side but not the Postgres side).
   Role: durable identity/placement ledger + FK anchor + `createdAt` per instance (surfaced in
   `InstanceDetail`) + substrate for M8 scale-out/move and more precise per-module uninstall
   guarding. Mirrors the existing `models` (config) / Redis (state) split.
4. **API surface** (`control-plane.yaml`, breaking): `ModelInfo` gains `instanceCount` and documents
   `state` as the aggregate; `workerId` is populated only when `instanceCount === 1`. `ModelDetail`
   drops its per-instance fields (`workerId`, `deviceIndices`, `runnerEndpoint`, `currentMemory`,
   `progress`, `stateChangedAt`, `errorMessage`) in favor of a required `instances: InstanceDetail[]`
   array holding them per replica; `lastInferenceAt` stays top-level (per ADR-014, refined below).
   New paths: `POST /api/v1/models/{modelName}/instances` (create a replica from the stored config,
   never `409`s on an already-deployed model — this is the "add instance" / "deploy new" move
   step), `DELETE .../instances/{instanceId}` (stop one instance, others unaffected — the
   independent-stop criterion and the "stop old" move step), `POST .../instances/{instanceId}/sleep`
   and `.../wake` (thin instance-scoped wrappers). `POST /api/v1/models` keeps its original meaning
   (create the logical model + first instance, `409` on a true duplicate name).
5. **Model-level operations generalize to "all instances"**: stop drains and removes every instance
   but keeps the config record; sleep sleeps every ACTIVE instance; wake wakes every SLEEPING
   instance; delete stops every instance and removes the record (Postgres `CASCADE` cleans any
   instance rows a background failure left behind); start is valid only when the model has zero
   instances (unchanged from pre-#120 semantics) and mints one.
6. **Wake-on-request** (`POST /api/v1/wake`, the proxy's cold-start trigger) gets a **minimal**
   multi-instance policy: if any instance is already ACTIVE or STARTING, the trigger is satisfied
   without touching anything else; otherwise wake exactly **one** instance — the most-recently-active
   SLEEPING one (max `lastInferenceAt`, tiebreak max `stateChangedAt`). Load-aware multi-instance
   wake fan-out is explicitly out of scope for M7 (see Non-goals).
7. **Eviction candidates become instances** (`EvictionCandidate` gains `instanceId`); `pinnedModels`
   and per-model configured size stay keyed by **model name** (pinning and size are model-level
   config, inherited by every instance) while eviction picks a specific instance to stop. LRU
   ordering still uses `lastInferenceAt`, which point 8 keeps per-model — replicas of the same model
   therefore share recency and the strategy picks a replica of the least-recently-used _model_
   first, which is judged acceptable for M7 (see Non-goals; refined ranking is future work).
8. **Inference recency stays per logical model, not per instance** (refining
   [ADR-014](adr-014-inference-recency-tracking.md)): the dedicated `inference:last:{modelName}`
   key is unchanged. A model's recency reflects inference against _any_ of its replicas — correct
   for the eviction LRU signal, which asks "is this model still being used," not "is this specific
   replica still being used."
9. **VRAM reservations move from model-keyed to instance-keyed**
   (`MemoryBudgetService.reserveCapacity`/`releaseInstanceReservations`, inner map
   `${workerId}:${deviceIndex} -> instanceId -> bytes`), so two replicas of one model co-located on
   one device reserve independently and releasing one doesn't touch the other's reservation.
10. **The worker agent's one-runner-per-model-name rule is replaced with one-runner-per-instanceId.**
    `RunnerManager` changes `modelToRunner: Map<string, string>` to `modelRunners: Map<string,
Set<string>>` (a model name may now resolve to several runners) plus a new `instanceRunners:
Map<string, string>` (the unambiguous conflict/lookup key). `StartRunnerRequest.instanceId` is
    optional in the contract, back-compat: the worker falls back to a self-generated id when absent,
    but the control plane always sends one. `GET /runners/by-model/{modelName}/logs` now resolves
    to the **most-recently-started** runner for that model (documented ambiguity, unchanged route,
    still used to watch a first-instance cold start from the deploy modal); a new
    `GET /runners/by-instance/{instanceId}/logs` is unambiguous and is what the control plane uses
    once it has minted an instance id (i.e., for every deploy/replica/move going forward). Port
    allocation (`allocatePorts`, lowest-free-`(management, engine)`-pair scan) is unchanged — it
    already assigns each of N same-model runners its own pair.
11. **Move-model is a scripted composition on top of these primitives, not a new endpoint.** Deploy
    a new instance elsewhere (`POST .../instances`) → shift traffic via a new internal-only
    `RoutingMapService.updateEndpointWeight(modelName, host, port, weight)` primitive (Lua, mirrors
    `updateEndpointHealth`; sets an **existing** `RunnerEndpoint.weight` field, so the Rust-mirrored
    `proxy-control-plane.yaml` needs no change) → wait for the balancer to stop selecting the old
    endpoint (`weight === 0`) → drain → `DELETE .../instances/{oldInstanceId}`. `updateEndpointWeight`
    has no HTTP route in M7 — its only consumer is the scripted-move integration test; a move-model
    UI/route is M8 (tracked separately).
12. **In-place upgrade over pre-#120 Redis state is self-healing, not a hazard.** The old lifecycle
    key shape was a single segment, `{prefix}:models:{modelName}` (no instance id) — a bare
    `models:*` SCAN also matches that shape (glob `*` matches `:` too), which would surface it as a
    phantom instance with `instanceId === undefined` in `getAllInstances` while
    `getInstancesForModel` (anchored to `models:{modelName}:*`) never matches it, disagreeing with
    per-model detail reads. `getAllInstances` is anchored to two `:`-delimited segments
    (`models:*:*`) so these orphans are structurally invisible to every read path, and a
    reconciliation step (`pruneLegacyInstanceKeys`, `ModelLifecycleService`) separately SCANs the
    broader `models:*` pattern, deletes any key with no second segment, and logs once per key —
    self-healing the orphan away rather than requiring a manual flush. The scan runs once (on the
    leader's first reconciliation tick after startup, guarded by an in-memory flag), not on every
    tick — the migration is one-time and this project has no released pre-#120 version, so a
    permanent per-tick `models:*` SCAN would be a standing cost for a condition that can never
    occur again once it has been checked once.

## Consequences

- **Breaking `control-plane.yaml` response shapes** (`ModelDetail`, `ModelInfo`, `ModelActionResponse`,
  `ModelDeploymentResponse`) — every consumer updates in the same diff: dashboard (`api/client.ts`
  type aliases via regenerated types, `hooks/useModels.ts`, `pages/Models/*`), the dashboard BFF
  (`server/clients/control-plane.ts`, `server/routes/models.ts`), and the hand-written e2e mock
  fixtures (`dashboard/e2e/mocks/control-plane.ts`). No external consumers exist.
- **`proxy-control-plane.yaml` and the Rust proxy are untouched.** `RoutingEntry.endpoints` was
  already an array and `RunnerEndpoint.weight` already existed and was already honored by the
  balancer — the strongest evidence that "the data path was already designed for this."
- **Wake-on-request fans out to exactly one instance per trigger.** A cold cluster with N sleeping
  replicas of a popular model still wakes them one request at a time rather than all at once;
  load-aware fan-out is deferred (see Non-goals).
- **Scale-out auto-balancing** (deciding how many replicas to run, or automatically rebalancing
  across workers) is not part of this change — operators explicitly create/delete instances.
- **#140** (a concurrent-delete race on the routing map's add/remove-endpoint path) is not fixed by
  this restructure; the scripted move exercises that path (add new endpoint, later remove old) but
  does not close the race. Tracked separately.
- **Eviction's LRU ordering shares recency across a model's replicas** (point 8) rather than ranking
  individual instances by their own idle time — acceptable for M7, revisit if replica-level LRU
  becomes necessary.

## Non-goals (M7)

- Load-aware / multi-instance wake-on-request fan-out.
- Scale-out auto-balancing (how many replicas, automatic rebalancing).
- Move-model UI or a dedicated `/move` endpoint — M8, built on `updateEndpointWeight` +
  `POST .../instances` + `DELETE .../instances/{id}`.
- Per-instance replica-level LRU eviction ordering.
- Fixing #140 (endpoint add/remove race) — pre-existing, separately tracked.

## References

- [#120](https://github.com/rh-aiservices-bu/school-of-sardeenz/issues/120) — Model = single instance
  everywhere in the control plane.
- [#121](https://github.com/rh-aiservices-bu/school-of-sardeenz/issues/121) — `models` table registry
  semantics (option A), the premise this ADR builds on.
- [ADR-005](adr-005-openapi-contracts.md) — OpenAPI contracts as source of truth; Rust types
  hand-maintained only for `proxy-control-plane.yaml`.
- [ADR-009](adr-009-state-and-persistence.md) — the Postgres-config/Redis-state split this ADR
  mirrors for instances.
- [ADR-014](adr-014-inference-recency-tracking.md) — inference recency tracking; refined by point 8.
- `packages/contracts/specs/proxy-control-plane.yaml` — `RoutingEntry.endpoints`,
  `RunnerEndpoint.weight` (unchanged; the evidence the data path was ready).
- `proxy/src/forwarding/balancer.rs` — the weighted balancer's `healthy && weight > 0` predicate that
  `updateEndpointWeight` and the scripted move rely on.
