# Phase 5 — kvcached Oversubscription & Co-location Policy

## Implementation Status

#276 and #278 are **implemented and fully verified here** (typecheck / unit tests / contract
validation / codegen / migration reviewed): #276 co-location placement policy (placement +
memory-budget + sleep-wake suites, migration `008-add-allow-co-location.sql`,
`control-plane.yaml` + regenerated types, dashboard deploy-form switch,
`SARDEENZ_COLOCATION_MAX_POOL_HEADROOM_PERCENT` wired through `deployment/`); #278
consumer-side attribution rule (worker-agent contract gains `attribution` on
`InstanceMemoryMeasurement`, worker + control-plane + dashboard suites). The control-plane
contract's description-only `WorkerModelInfo.memoryUsedBytes` rewording below is
type-regenerated and contract-validated.

#277 (shared-pool pressure response) is **implemented and merged onto this phase branch** —
its `SARDEENZ_POOL_PRESSURE_*` knobs (shipped defaults: `ENABLED=false`, `THRESHOLD_PERCENT=90`,
`RELEASE_TARGET_PERCENT=75`, `DEBOUNCE_TICKS=3`), the reconciliation pressure step and the
`deployment/` wiring are all present, gated by its own scoped suites. The evaluator stays **off
by default** (`ENABLED=false`), so on-cluster pressure behavior remains a deploy-gated item.

**Cluster-gated** (written + statically validated, runnable only on a GPU node): the on-cluster
execution of the **Gate 9b** recipe below. Its run is recorded in [`status.md`](status.md)'s
deploy-only verification list at phase close — this doc is the recipe, not the run record.

## Goal

Let the control plane deliberately place several kvcached-capable models on one GPU when their
runners declare `kvCacheElasticSharing`, treating KV-cache memory as reclaimable rather than fixed —
while guaranteeing that **non-kvcached runners are never silently co-located** past naive byte-sum
capacity (the OOM guard Phase 4 deferred, [`phase4.md`](phase4.md) §Out of scope). Three
sub-decisions the phase owns: which models may co-locate, how much oversubscription is allowed, and
how eviction reacts when a shared pool is under pressure
([`overall-plan.md`](overall-plan.md) §Phase 5). Phase 4 proved two vLLM runners can share a GPU
via kvcached (spike Gate 9d); this phase turns that into a control-plane placement policy.

## Design notes

One short section per work item — the authoritative design lives in each issue's spec and decision
comments; this doc records what shipped and how it fits together. Landing waves — W1: #276 ∥ #278
→ this document (#279); W2: #277 after #276 (all four items are merged onto this phase branch).

### #276 — Co-location placement policy

A model opts in with `allowCoLocation` on the deploy request (also settable on a stopped model's
configuration; dashboard deploy-form switch). When set, the placement pipeline may place the
model's instances on a device **past naive byte-sum capacity** iff every instance already resident
on that device — including sleeping ones, which keep their VRAM holds — belongs to a runner type
declaring `kvCacheElasticSharing` on the target worker, and the device reports a kvcached pool.
Key properties:

- **Fail-closed capability guard**: an unresolvable co-resident (deleted model record, worker no
  longer reporting the runner type, any unknown-placement (null/empty `deviceIndices`) resident —
  including an ERROR instance that retains its reservation hold) counts as non-elastic and blocks
  co-location; an ERROR instance **with** `deviceIndices` is an ordinary co-location-group member
  whose runner type resolves normally (it blocks only when that type is missing or non-elastic).
- **Oversubscription headroom** is
  `min(min(freeBytes + preallocBytes, poolTotalBytes), cap% × poolTotalBytes)` from the
  device's KV-pool telemetry, with the cap set by
  `SARDEENZ_COLOCATION_MAX_POOL_HEADROOM_PERCENT` (integer percent 0–100, default **50**, `0`
  disables elastic headroom; validated at boot — the control plane refuses to start on a bad
  value).
- **`placeFixed` (the move API) applies the same rules** and still never evicts.
- **Wake pre-check is now per-device** and excludes the waking instance's own hold (sleep never
  released the hold, so the old worker-wide sum produced a phantom shortfall); wake-eviction
  victims are scoped to the waker's device co-location group, sized per device
  (`requiredMemory / tensorParallel`), bounded by `SARDEENZ_EVICTION_MAX_PER_CYCLE`; legacy
  instances without `deviceIndices` keep the worker-wide fallback.
- The **co-location group helper** (`coLocationGroup` in `placement.ts`) is the single derivation
  of "who shares this device"; #277's pressure path imports it, never re-derives.
- Shared-sentence ownership: the `DeviceInfo.kvCache` "telemetry only — never feeds placement
  math" wording (and its worker-contract/dev-worker twins) is owned wholly by this item and was
  reworded to name the elastic branch as the one placement consumer; all non-elastic placement
  math still never reads it.

### #277 — Shared-pool pressure response

The reconciliation tick gains a pool-pressure step (a `safeStep` directly after
`refreshMemoryBudgets`): when a device's kvcached pool stays near-full for several consecutive
ticks (`SARDEENZ_POOL_PRESSURE_*` knobs — enable flag, usage-ratio threshold, release target,
tick debounce), the control plane reclaims capacity through the existing `EvictionEngine`, with
victims drawn only from that device's co-location group (#276's helper, imported — never
re-derived). Decision (2026-11-13): pressure victims are **STOPPED** (existing deterministic
teardown), not slept, and remain sized by configured `requiredMemory` (the excess-overshoot is
accepted); no sleep-based variant ships. This is the system's first memory-pressure eviction
trigger — previously eviction was demand-only (deploy-fail, wake-shortfall).

### #278 — Consumer-side attribution rule

`attribution` (M17, ADR-027) gains its first executable consumers, and none of them sums a
device-scope memory row into a per-instance figure. The worker-agent contract's
`InstanceMemoryMeasurement` gains the same optional `attribution: "runner" | "device"` field the
engine-runner contract has had since M17; the worker stamps NVML rows `"runner"` and promotes a
no-NVML ledger row only while its runner is the device's sole record; the control plane
scope-checks every per-instance summation site through one shared helper
(`sumInstanceMeasurementsByInstance`) — a device- or unknown-scope row is kept only while it is
its device's sole >0-byte row, else dropped (its bytes surface in the dashboard's "Other" bucket,
whose clamp keeps the bar honest). Closes the #244 residual: two co-located models on a worker
without NVML can no longer render two whole-device bars on one card.

## Deliverables

- Contracts: `control-plane.yaml` (`allowCoLocation` request/response plumbing, elastic-branch
  `DeviceInfo.kvCache` description, `WorkerModelInfo.memoryUsedBytes` absence clause) +
  `worker-agent.yaml` (`attribution` on `InstanceMemoryMeasurement`); types regenerated.
- DB migration `control-plane/migrations/008-add-allow-co-location.sql` + store mapping.
- Control plane: placement pipeline elastic branch, per-device wake pre-check + group-scoped wake
  eviction, config knobs — plus the #277 pool-pressure reconciliation step.
- Worker: attribution stamping/promotion in the memory-report assembly.
- Dashboard: deploy-form `allowCoLocation` switch + i18n; rendering of already-deduped figures.
- Deployment: `SARDEENZ_COLOCATION_MAX_POOL_HEADROOM_PERCENT` and the `SARDEENZ_POOL_PRESSURE_*`
  knobs wired through `deployment/` (both merged with their items).
- Docs: this file (linked from [`overall-plan.md`](overall-plan.md)'s Phase 5 section);
  CHANGELOG `[Unreleased]` entries per item.
- At phase close: `status.md` flip + the Gate 9b run recorded in its deploy-only list; the
  sleep-keeps-hold-under-co-location and oversubscription-cap decisions may be ratified as an ADR
  (ADR-027/028 precedent) — a close-out decision, not this document's.

## Verification — Gate 9b (deploy-only, on-cluster)

Gate 9 (`tests/gates/run-gates.sh`) drives the **worker agent directly**: it asserts that two
runners land on `deviceIndex` 0 and deliberately never asserts `kvCache` blocks, and it exercises
no control-plane decision. Gate 9b is its **CP-driven complement**: the control plane decides the
co-location (policy from #276), and the recipe observes the elastic pool through both runners'
`/memory-report` responses. It is a documented procedure, not a script gate — `run-gates.sh` has
no CP/Postgres/Redis harness — and it makes repeatable the one-time spike evidence
([`phase4-apptainer-spike.md`](phase4-apptainer-spike.md) Gate 9d: elastic sharing on one L4,
proven by hand; the 9c static-split baseline is the comparison point). The standing Gate 9
re-run rule on kvcached/base-image bumps (`containers/runners/vllm/0.21.0/Containerfile` PIN
DISCIPLINE) is unchanged.

**What Gate 9b proves that Gate 9 does not:** the placement decision came from the control plane
(placement math + policy), not from hand-pointing two runners at one GPU through the worker API;
and the elastic pool is observed (`kvCache` blocks), which Gate 9 never asserts.

### Prerequisites

- A GPU worker `ONLINE` advertising the elastic capability:
  `GET /api/v1/workers` → `runnerCapabilities[]` contains an entry with `runnerType: "vllm"` and
  `kvCacheElasticSharing: true`.
- A vLLM module imported via the runner catalog (digest-pinned ORAS pull onto the module store;
  see [`docs/usage/runner-catalog.md`](../usage/runner-catalog.md) — the import verifies the layer
  digest and SIF signature; `runners.yaml`'s vLLM entries declare
  `kvCacheElasticSharing: true`).
- Weights pre-staged on the weights PVC inside the control plane's weights directory — e.g.
  `facebook/opt-125m` per the spike runbook (`phase4-apptainer-spike.md` §9b; runners stay
  offline at runtime, `HF_HUB_OFFLINE=1` is baked into the images). **Two distinct weights
  directories** (two copies of the same small model is acceptable — the recipe exercises memory
  mechanics, not model identity; each model gets its own `modelPath` directory).
- Control plane reachable with its bearer token (`SARDEENZ_API_TOKEN` → `Authorization: Bearer …`
  on `/api/v1/*`; fail-closed — the control plane refuses to start without the token configured;
  dev opt-out: `SARDEENZ_ALLOW_UNAUTHENTICATED_API=true`).
- The worker runs the production (Apptainer) launcher so `SARDEENZ_DEVICE_INDICES` is set —
  without it the vLLM shim omits `kvCache` from `/memory-report`.

### The recipe

1. **Deploy model A through the CP.** `POST /api/v1/models` with the required fields
   (`modelName`, `runnerType: "vllm"`, `modelPath`, `requiredMemory`) **and
   `allowCoLocation: true`** → `202` with the first `instanceId`. The deploy may also carry
   `runtimeModule` (e.g. `vllm-0.21`; optional — when omitted the production worker falls back to
   `<runnerType>-<engineConfig.version>`). Poll
   `GET /api/v1/models/{a}` until the instance is `ACTIVE` with `deviceIndices` populated (the
   control plane's `ACTIVE` maps to the worker-side runner `READY` — the deploy path health-polls
   until `READY|BUSY`). Within byte capacity this succeeds with today's placement; nothing
   requires device exclusivity.
2. **Deploy model B the same way.** On a **single-GPU worker** both instances now share device 0.
   On a multi-GPU worker, pin B (and A if needed) to device 0 via the move API:
   `POST /api/v1/models/{b}/instances/{instanceId}/move` with
   `{"targetWorkerId": "…", "targetDeviceIndices": [0]}` — run moves **sequentially** (moves go
   through `placeFixed`, which applies the same co-location rules and never evicts; the worker
   serializes real engine cold-starts). A move that does not fit the current policy fails with
   **`503 PLACEMENT_FAILED`**, reason `fixed-target-insufficient-capacity-or-incompatible`.
3. **Assert co-location (CP view).** Both models' instances report `state: ACTIVE`,
   `deviceIndices: [0]`, same `workerId`. Worker-side confirmation (optional, from inside the
   worker Pod): `GET {worker}/runners/by-instance/{instanceId}/status` → runner state `READY`.
4. **Assert the elastic pool (the Gate 9 gap closed).** For **each** runner: take `runnerEndpoint`
   (host + management port) from the model detail and `GET /memory-report` → the device entry for
   index 0 carries a `kvCache` block with all four figures satisfying the partition invariant
   `totalBytes = usedBytes + preallocBytes + freeBytes` (`KVCachePoolStats`,
   `engine-runner.yaml`). Both runners report the **same pool** (they read the same `/dev/shm`
   segment; the worker's first-wins dedupe per device is the precedent). CP-side cross-check:
   `GET /api/v1/cluster/memory` → that device's `DeviceInfo.kvCache`; the dashboard's KVCache
   sub-bar renders for the device. Record the four figures from both reports: `freeBytes`
   shrinking while both models serve is the elastic-sharing observation (compare the spike's
   static-split Gate 9c baseline, where each engine's split never moved).
5. **Past-capacity co-location (the #276 policy exercised).** With the policy merged (this
   branch), deploy or move model B **past the device's remaining byte budget**: with
   `allowCoLocation: true`, the guarded KV-pool headroom
   (`min(min(freeBytes + preallocBytes, poolTotal), cap% × poolTotal)`) backs the requirement
   beyond plain byte-fit, and B joins device 0's co-location group. Re-run step 4's assertions. A
   non-elastic model (or an elastic model when the device reports no pool / the cap is `0`) still
   fails placement instead of silently over-committing — worth asserting once with
   `allowCoLocation` unset.
6. **Optional concurrent-inference smoke.** Send concurrent `POST /openai/v1/chat/completions`
   to **both** models through the proxy (the proxy's routing map registers each model's engine
   port at deploy; the dashboard BFF forwards chat via `SARDEENZ_INFERENCE_URL`) and confirm both
   complete. This is what Gate 9 never exercised: two engines sharing one GPU while both serve.
   Afterwards re-read both `/memory-report` responses — `kvCache.usedBytes` should reflect
   concurrent KV growth on the shared pool.
7. **Measure the NVML reality check (required for acceptance).** Because `freeBytes` is _unbacked
   virtual capacity_ (see the caveat below), placement success alone is not acceptance evidence.
   While both co-located runners serve concurrent inference (step 6), record the device's actual
   NVML usage — `memoryUsedBytes` on the device entry in `/api/v1/cluster/memory` (or
   `nvidia-smi` inside the worker Pod) — and confirm the two engines together stay within the
   device's physical capacity. The ratified headroom formula can count free capacity twice across
   co-located pools, so this measurement is what proves the oversubscription cap actually bound
   physical usage.
8. **Record.** Paste the two `kvCache` blocks (or their four figures), the instance states, the
   NVML measurement, and the inference outcome into a linked run note. The phase-close
   `status.md` update adds this run to its deploy-only verification list.
9. **Cleanup.** `DELETE /api/v1/models/{a}` and `DELETE /api/v1/models/{b}` (releases
   reservations and frees the devices).

### Caveats the recipe must respect

- **`freeBytes` is virtual capacity.** `KVCachePoolStats.freeBytes` counts pool space not yet
  backed by physical memory; under co-tenancy the ratified headroom formula
  (`freeBytes + preallocBytes`, capped) can count the same unbacked capacity on behalf of more
  than one pool. That is why step 7's NVML measurement is part of acceptance, not optional
  color: the recipe's acceptance signal is _actual device usage under concurrent inference stays
  within physical capacity_, not _placement succeeded_.
- **Telemetry tolerance is preserved.** `kvCache` is optional end-to-end: the shim omits it on
  read failure or when the pool segment is not readable (absent means absent, never a zero), and
  the control plane validates it tolerantly. A missing `kvCache` block in step 4 is a recipe
  failure to investigate — never a fabricated zero, and never skippable.
- **ADR-028 adjacency.** If the run adds an optional sleep/wake check (e.g. verifying a slept
  co-tenant keeps its hold), respect the drain semantics: the drain signal is two-valued, unknown
  ≠ drained and fails open, and a 409-in-the-drain-window ERROR landing is deliberate.
- **No byte-value assertions.** As in Gate 9, `memoryUsedBytes` is never asserted against a fixed
  value — only the partition invariant's _shape_ is.

## References

- Issues: [#276](https://github.com/rh-aiservices-bu/school-of-sardeenz/issues/276) (co-location
  placement policy), [#277](https://github.com/rh-aiservices-bu/school-of-sardeenz/issues/277)
  (shared-pool pressure response),
  [#278](https://github.com/rh-aiservices-bu/school-of-sardeenz/issues/278) (consumer-side
  attribution rule), [#279](https://github.com/rh-aiservices-bu/school-of-sardeenz/issues/279)
  (this document + the Gate 9b recipe).
- [ADR-027](../architecture/adrs/adr-027-shim-memory-device-scope.md) — shim memory figures are
  device-scope observations; #278 is its first executable consumer rule.
- [ADR-028](../architecture/adrs/adr-028-drain-signal-semantics.md) — drain-signal semantics the
  recipe's optional sleep/wake wording must respect.
- [`phase4.md`](phase4.md) — the phase-doc exemplar and the §Out-of-scope item that defined this
  phase's mandate; [`phase4-apptainer-spike.md`](phase4-apptainer-spike.md) — the Gate 9c/9d
  evidence Gate 9b makes repeatable.
- `tests/gates/run-gates.sh` (Gate 9) — the worker-driven gate this recipe complements, never
  replaces; [`runners.yaml`](../../runners.yaml) + [`docs/usage/runner-catalog.md`](../usage/runner-catalog.md)
  — the module import flow.
- Contracts: `packages/contracts/specs/engine-runner.yaml` (`KVCachePoolStats`, the partition
  invariant), `packages/contracts/specs/control-plane.yaml` (`allowCoLocation`,
  `DeviceInfo.kvCache`, `MoveModelInstanceRequest`), `packages/contracts/specs/worker-agent.yaml`
  (`attribution` on `InstanceMemoryMeasurement`).
