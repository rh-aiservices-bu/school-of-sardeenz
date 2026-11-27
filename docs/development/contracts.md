# OpenAPI Contract Workflow

The OpenAPI specifications in `packages/contracts/` are the **single source of truth** for all inter-component communication (see [ADR-005](../architecture/adrs/adr-005-openapi-contracts.md)).

## Contract Files

| File                             | Covers                           |
| -------------------------------- | -------------------------------- |
| `specs/control-plane.yaml`       | Dashboard ↔ Control Plane API    |
| `specs/proxy-control-plane.yaml` | Proxy ↔ Control Plane API        |
| `specs/engine-runner.yaml`       | Engine runner lifecycle contract |
| `specs/worker-agent.yaml`        | Worker agent management API      |

## Making Changes

### 1. Edit the OpenAPI spec

Modify the relevant YAML file in `packages/contracts/specs/`. Start with the spec, not the code.

### 2. Validate

```bash
npm run validate -w @sardeenz/contracts
```

### 3. Regenerate types

```bash
make codegen
```

This runs `openapi-typescript` to regenerate TypeScript type definitions in `packages/types/src/generated/`.

### 4. Fix consumers

After regeneration, run `make typecheck` to find any code that no longer matches the updated types. Fix those call sites.

### 5. Commit everything together

The spec change, regenerated types, and consumer fixes should ship in a single commit. This is a key benefit of the monorepo (see [ADR-008](../architecture/adrs/adr-008-monorepo.md)).

## Spec Conventions

- OpenAPI version: 3.1
- Endpoint paths: `kebab-case` (`/model-state`, not `/modelState`)
- Schema names: `PascalCase` (`ModelState`, `DeviceInfo`)
- Field names: `camelCase` (`modelId`, `deviceName`)
- Enum values: `SCREAMING_SNAKE_CASE` (`LOADING`, `READY`)
- Every endpoint must document at least 200, 400, and 500 responses
- Every schema field must have a `description`

## Generated Code

Files in `packages/types/src/generated/` are machine-generated. Never edit them by hand — changes will be overwritten on the next `make codegen`. If the generated output is wrong, fix the spec.

These files are committed to the repo (not gitignored) so that consumers can depend on them without running codegen. The `.gitattributes` file marks them as `linguist-generated` so GitHub collapses them in pull request diffs.

## Redis-Transported Schemas

Several JSON payloads cross a component boundary through Redis rather than an HTTP API. They are **payloads on an existing transport, not a second wire** — no new endpoint, channel, or side-channel API exists for them. Most of them still have a spec home, which stays the source of truth and is mirrored by hand where Rust reads it (`proxy/src/generated/`, ADR-005): routing-map entries → `RoutingEntry`, and the two routing pub/sub payloads → `RoutingMapUpdate` / `RoutingPropagationBarrier`, in `specs/proxy-control-plane.yaml` (whose non-HTTP schema note also defines `{prefix}:proxy:protocols` as a JSON array of `Protocol`); worker registration → `WorkerInfo` / `WorkerMemoryReport` in `specs/worker-agent.yaml`; cluster memory → `ClusterMemory` in `specs/control-plane.yaml`. **Two families have no schema in any spec:** instance state (`{prefix}:models:{modelName}:{instanceId}`) is shaped by the control plane's `InstanceState` interface (`control-plane/src/services/model-lifecycle.ts:66`), and worker detail snapshots (`{prefix}:worker:{workerId}:detail`) carry its `WorkerRecord` (`control-plane/src/services/worker-pool.ts:14`) — not the spec's `WorkerDetail` (`specs/control-plane.yaml:2362`, which governs the workers API response and differs: `models` is required, `capabilities`/`managementUrl` do not exist), even though the dashboard BFF types its read as `WorkerDetail` (`dashboard/server/clients/redis.ts:453`). Those two are additive-only by **convention only**: nothing generates or type-checks their shape, so a rename or type change there is caught by review, never by `make codegen`.

During a rolling upgrade an old proxy reads payloads written by a new control plane (and the reverse), so the following rule governs every change to them:

1. **Scope.** The rule covers the JSON payloads that cross a component boundary through Redis: routing-map hash fields (`{prefix}:routing-map` → `RoutingEntry`); the routing pub/sub payloads — `RoutingMapUpdate` on `{prefix}:routing-updates` and `RoutingPropagationBarrier` on `{prefix}:routing-barriers`; instance state (`{prefix}:models:{modelName}:{instanceId}`); worker registration (`{prefix}:workers:{workerId}:info` and `:memory`); worker detail snapshots (`{prefix}:worker:{workerId}:detail`); cluster memory (`{prefix}:cluster:memory`); and proxy protocols (`{prefix}:proxy:protocols`). The pub/sub payloads are the least forgiving of the set: `RoutingPropagationBarrier` is load-bearing, because the proxy parses it _before_ acting on the message, so a payload an old proxy cannot parse means that proxy never refreshes the map the barrier announces and never writes its ack to `{prefix}:routing-barrier-acks:{barrierId}` — the control plane then waits out that proxy's presence lease while it tears the old runner down, and the old route stays live through the teardown. Plain scalar keys (heartbeats, presence/inference timestamps, barrier acks) are out of scope.
2. **Additive only.** New fields must be optional with a reader-side default; existing fields keep their name, JSON type, and required/optional status. No renames, removals, or type changes — ever, in place.
3. **Enum values are not automatically additive.** A new enum value may be added only when _every_ reader of that schema tolerates unknown values. `Protocol` and `ModelState` are closed by design on the proxy (no `#[serde(other)]`; `proxy/src/generated/proxy_control_plane.rs:23-33`, #125 item 6): an unknown value fails the whole entry parse there. A new protocol/state is therefore a coordinated spec + Rust-mirror + proxy-release change, not a rolling-upgrade-safe addition (see `deployment/README.md` § Upgrade order).
4. **Pinned reader behaviour (old proxy, newer control plane).** Routing entries: unknown extra fields → the entry deserialises and routes normally (serde ignores unknown fields; `RoutingEntryMetadata` flattens them). Unknown enum value → whole-entry parse failure, counted in `sardeenz_proxy_routing_parse_errors_total` (model label), logged, previous entry carried forward / entry dropped when none exists (`proxy/src/state/redis_sync.rs:24-60`). Barrier payloads: unknown extra fields are ignored like everywhere else (serde default), but a missing, renamed, or re-typed required field (`barrierId`, `modelName`, `timestamp` — `proxy/src/generated/proxy_control_plane.rs:170`) fails the parse, and the proxy logs a warning and drops the whole message **before** the map refresh and **before** the ack (`proxy/src/state/redis_sync.rs:153-158`); unlike the routing-entry path that branch increments no counter, so a mixed-version barrier failure is visible only in the proxy log while the control plane waits out that proxy's presence lease before tearing the old runner down.
5. **Reverse direction and the other readers.** The control plane reads payloads it did not write through two behaviours that catch different things. Blind casts — `JSON.parse` with no validation, in `services/routing-map.ts:97,105` and `services/model-lifecycle.ts:164,237,388` — tolerate unknown extra fields and check nothing. Validate-and-reject parsers — `parseWorkerInfo` (`services/worker-pool.ts:185`) and `parseReport`/`validateDevice` (`services/memory-budget.ts:242,429`) — tolerate unknown extra fields but drop the whole worker or memory report when a _known_ field is wrong-typed or carries an unknown enum value; `services/proxy-protocols.ts:21` narrows the advertised array to its string members. Writers must keep every field they ever wrote, and a known field's type or enum domain stays non-additive in both directions. The dashboard BFF is a third reader of the same transport: it serves fallback reads from `dashboard/server/clients/redis.ts` (instance state, worker registration/detail, cluster memory) and bridges `RoutingMapUpdate` to SSE `ClusterEvent`s in `dashboard/server/routes/events.ts`, where an unrecognised `type` silently becomes a default `MODEL_STATE_CHANGED` event (`:55-56`) instead of an error.
6. **No schema version field.** None is added. Revisit at the first change this rule cannot express; that change ships with its own compatibility design and issue (issue #331 decision, 2026-11-27).
