# Phase 2 — Control Plane Sleep/Wake Orchestration

## Goal

Build the brain of the system — the control plane that tracks device memory budgets, decides where models run, manages their lifecycle, and coordinates sleep/wake with runners. The control plane does not serve inference traffic; it makes placement and orchestration decisions that every other component depends on.

Phase 2 depends on Phase 0's runner contract for lifecycle commands (health, sleep/wake, capabilities, memory reporting) and Phase 1's proxy contract for the wake trigger API and routing map schema. The control plane's outputs feed Phase 3: the admin API and dashboard-facing API that the dashboard frontend will consume.

## Scope

### In scope

The control plane covers eight functional areas:

1. **Model lifecycle state machine** — states: `PENDING` → `STARTING` → `ACTIVE` → `SLEEPING` → `STOPPING` → `STOPPED`, with well-defined transitions, error states, and timeout-based recovery for every non-terminal state
2. **Device memory budget tracking** — global view of memory allocation across all workers, built from worker self-reports in Redis/Valkey
3. **Workload placement pipeline** — four-stage matching: runner type selection → hardware filtering → capacity filtering → placement strategy
4. **LRU eviction engine** — when memory is constrained, select least-recently-used models to sleep or stop; behind a pluggable strategy interface
5. **Sleep/wake coordination** — send sleep/wake commands to runners through the runner contract; handle timeouts and failures
6. **Routing map management** — write routing map updates to Redis/Valkey for the proxy to consume; publish state changes via pub/sub
7. **Worker pool management** — workers join and leave dynamically without control plane restart; heartbeat-based liveness detection
8. **Leader election** — K8s Lease-based leader/standby for high availability; on failover, the new leader reconstructs state from Redis/Valkey and PostgreSQL

### Out of scope

- **Auto-scaling workers** — workers are provisioned manually in this phase; the architecture supports future autoscaling but the logic is not implemented
- **Multi-cluster federation** — single-cluster only
- **Advanced eviction strategies beyond LRU** — the pluggable strategy interface is in scope; alternative implementations (priority-based, cost-weighted) are not
- **Authentication/authorization** — the control plane API is internal; access control is the dashboard backend's responsibility (Phase 3)
- **Runner implementation** — the control plane calls runners through the runner contract but does not implement them
- **Dashboard UI** — Phase 3; the control plane exposes APIs the dashboard will consume

## Approach

1. Write the control plane OpenAPI specs (admin API + dashboard-facing API)
2. Set up the Fastify project with codegen, configuration, structured logging, and graceful shutdown
3. Design and implement the PostgreSQL schema for persistent configuration
4. Implement the model lifecycle state machine with timeout recovery
5. Implement device memory budget tracking from worker self-reports in Redis
6. Implement the workload placement pipeline
7. Implement the LRU eviction engine with pluggable strategy interface
8. Implement sleep/wake coordination with the runner contract
9. Implement routing map management (Redis writes + pub/sub notifications)
10. Implement worker pool management with heartbeat detection
11. Implement the wake trigger API (consumed by the proxy)
12. Implement the routing map bootstrap API
13. Implement K8s Lease-based leader election
14. Add health endpoints and Prometheus metrics
15. Build a multi-stage container image
16. Write integration tests against real Redis and PostgreSQL instances

## Tasks

| #    | Task                                         | Status | Output                                                                     |
| ---- | -------------------------------------------- | ------ | -------------------------------------------------------------------------- |
| 2.1  | Write control plane OpenAPI specs            | Done   | `packages/contracts/specs/control-plane.yaml`                              |
| 2.2  | Write dashboard ↔ control plane OpenAPI spec | Done   | Merged into 2.1 (single admin API spec + SSE events endpoint)              |
| 2.3  | Set up TypeScript codegen for new specs      | Done   | `packages/types/src/generated/control-plane.ts`                            |
| 2.4  | Scaffold control plane service               | Done   | Compilable Fastify app with config, logging, errors, graceful shutdown     |
| 2.5  | Design PostgreSQL schema and migrations      | Done   | `control-plane/migrations/001-initial-schema.sql`                          |
| 2.6  | Implement model lifecycle state machine      | Done   | Atomic CAS transitions via Lua, SET NX for creation, SCAN for enumeration  |
| 2.7  | Implement device memory budget tracking      | Done   | Redis-based reader + in-memory reservations + staleness detection          |
| 2.8  | Implement workload placement pipeline        | Done   | Four-stage placement with MostAvailableCapacity spread strategy            |
| 2.9  | Implement LRU eviction engine                | Done   | LRU with circuit breaker, max-per-cycle, pinned exclusion, min-active-time |
| 2.10 | Implement sleep/wake coordination            | Done   | Runner HTTP client + drain polling + wake polling with timeout             |
| 2.11 | Implement routing map management             | Done   | Atomic Lua scripts for endpoint add/remove/update + MULTI/EXEC for state   |
| 2.12 | Implement worker pool management             | Done   | SCAN-based discovery, heartbeat detection (ONLINE/DEGRADED/OFFLINE)        |
| 2.13 | Implement wake trigger + routing map APIs    | Done   | `POST /api/v1/wake` (matches spec contract), `GET /api/v1/routing-map`     |
| 2.14 | Implement admin APIs                         | Done   | Model CRUD, worker list/get, cluster status/memory, SSE events             |
| 2.15 | Implement leader election                    | Done   | K8s Lease API with local dev mode fallback, token refresh every 60s        |
| 2.16 | Implement health and metrics                 | Done   | `/healthz`, `/readyz`, `/metrics` with 13 Prometheus metrics               |
| 2.17 | Build container image                        | Done   | `containers/control-plane/Dockerfile` (multi-stage, non-root)              |
| 2.18 | Integration test suite                       | Done   | 128 unit tests + 7 integration tests (real Redis + PostgreSQL)             |

## Task Details

### 2.1 — Write Control Plane OpenAPI Spec

**Depends on:** Phase 0 and Phase 1 specs (for shared type definitions)

Design and write an OpenAPI 3.1 specification at `packages/contracts/specs/control-plane.yaml` defining the control plane's admin API — the endpoints used by the dashboard backend and operators to manage models, workers, and cluster state.

The spec covers:

**1. Model lifecycle management:**

- `POST /api/v1/models` — deploy a new model (triggers placement pipeline)
- `GET /api/v1/models` — list all models with current state
- `GET /api/v1/models/{modelName}` — get model details including state, placement, memory usage
- `DELETE /api/v1/models/{modelName}` — stop and remove a model
- `POST /api/v1/models/{modelName}/sleep` — explicitly sleep a model
- `POST /api/v1/models/{modelName}/wake` — explicitly wake a model (admin-initiated, separate from proxy wake trigger)

**2. Worker management:**

- `GET /api/v1/workers` — list all workers with capabilities and current load
- `GET /api/v1/workers/{workerId}` — get worker details including device memory breakdown, running runners

**3. Cluster state:**

- `GET /api/v1/cluster/status` — aggregate cluster state (total/used/free device memory, model counts by state, worker counts)
- `GET /api/v1/cluster/memory` — device memory budget summary across all workers

**4. Shared type definitions:**

- `ModelDeploymentRequest` — model name, required memory, runner type preferences, constraints
- `ModelDeploymentResponse` — placement result, assigned worker, runner endpoint
- `ModelLifecycleState` enum — `PENDING`, `STARTING`, `ACTIVE`, `SLEEPING`, `STOPPING`, `STOPPED`, `ERROR`
- `WorkerInfo` — worker ID, capabilities, device memory per device, running runners
- `ClusterStatus` — aggregate cluster health and capacity

**Conventions** (from [`docs/development/coding-standards.md`](../development/coding-standards.md)):

- Endpoint paths: `kebab-case` (e.g., `/api/v1/models`)
- Schema names: `PascalCase` (e.g., `ModelDeploymentRequest`)
- Field names: `camelCase` (e.g., `modelName`, `deviceMemory`)
- Enum values: `SCREAMING_SNAKE_CASE` (e.g., `ACTIVE`, `SLEEPING`)
- Every endpoint: document 200, 400, 404, 500 responses
- Every field: include a `description`

**Validation:** `npm run validate -w @sardeenz/contracts` must pass with zero errors.

### 2.2 — Write Dashboard ↔ Control Plane OpenAPI Spec

**Depends on:** Task 2.1

Design and write an OpenAPI 3.1 specification at `packages/contracts/specs/dashboard-control-plane.yaml` defining the API the dashboard backend will consume. This may be a subset of the admin API (Task 2.1) with additional dashboard-specific endpoints, or it may be merged into the admin API spec if the surface is the same.

**Decision point:** Determine whether the dashboard backend calls the same API as the admin API (single spec), or whether there's a separate BFF-optimized contract. Leaning toward a single admin API spec that both the dashboard and operators use — the dashboard backend is a consumer, not a special case.

If merged, this task produces a review confirming the admin API covers all dashboard needs, plus any additional endpoints:

- **Real-time event stream** — SSE endpoint for model state changes, memory updates, worker events (the dashboard subscribes for live updates)
- **Batch queries** — endpoints optimized for the dashboard's views (e.g., "all models on worker X with their memory usage")

### 2.3 — Set Up TypeScript Codegen for New Specs

**Depends on:** Tasks 2.1, 2.2

Generate TypeScript types from the new control plane OpenAPI specs using `openapi-typescript`, following the pattern established in Phase 0.

This task:

1. Adds the new spec(s) to the codegen pipeline in `packages/types/`
2. Generates TypeScript types into `packages/types/src/generated/`
3. Verifies output compiles with `make typecheck`

### 2.4 — Scaffold Control Plane Service

**Depends on:** Task 2.3

Set up the Fastify application with the foundational infrastructure that all subsequent tasks build on. This is the skeleton — no business logic yet.

**Configuration** (via environment variables, with defaults):

- `SARDEENZ_REDIS_URL` — Redis/Valkey connection string
- `SARDEENZ_DATABASE_URL` — PostgreSQL connection string
- `SARDEENZ_LISTEN_ADDR` — control plane listen address (default `0.0.0.0:3000`)
- `SARDEENZ_LOG_LEVEL` — log level (default `info`)
- `SARDEENZ_LEASE_NAME` — K8s Lease name for leader election (default `sardeenz-control-plane`)
- `SARDEENZ_LEASE_NAMESPACE` — K8s namespace for Lease (default from downward API)
- `SARDEENZ_REDIS_KEY_PREFIX` — prefix for Redis keys and pub/sub channels (default `sardeenz`)
- `SARDEENZ_WORKER_HEARTBEAT_TIMEOUT_SECS` — how long before a silent worker is considered dead (default `30`)
- `SARDEENZ_PARKING_TIMEOUT_SECS` — timeout for model wake-up before returning 503 (default `120`)
- `SARDEENZ_EVICTION_MAX_PER_CYCLE` — max models to evict in a single placement cycle (default `3`)
- `SARDEENZ_SLEEP_TIMEOUT_SECS` — timeout for runner sleep command (default `300`)
- `SARDEENZ_WAKE_TIMEOUT_SECS` — timeout for runner wake command (default `300`)
- `SARDEENZ_HEALTH_CHECK_INTERVAL_SECS` — interval for polling runner health (default `10`)

**Structured logging** — JSON format via `pino` (Fastify's default logger) with request ID propagation.

**Error handling** — typed error hierarchy with machine-readable error codes. Use explicit error returns, not thrown exceptions, per coding standards.

**Graceful shutdown** — handle SIGTERM/SIGINT, stop accepting new requests, wait for in-flight operations, close data store connections.

**Module layout:**

```
control-plane/src/
├── index.ts                # Entry point, config, server startup
├── config.ts               # Configuration from env vars
├── errors.ts               # Error types and codes
├── server.ts               # Fastify app setup, plugin registration, routes
├── routes/
│   ├── wake.ts             # POST /api/v1/wake (proxy-facing)
│   ├── routing-map.ts      # GET /api/v1/routing-map (proxy-facing)
│   ├── models.ts           # Model lifecycle CRUD
│   ├── workers.ts          # Worker management
│   └── cluster.ts          # Cluster state endpoints
├── services/
│   ├── model-lifecycle.ts  # State machine, transitions, timeout recovery
│   ├── placement.ts        # Workload placement pipeline
│   ├── eviction.ts         # LRU eviction engine + strategy interface
│   ├── sleep-wake.ts       # Sleep/wake coordination with runners
│   ├── routing-map.ts      # Redis routing map writer + pub/sub
│   ├── worker-pool.ts      # Worker discovery, heartbeats, capability registry
│   ├── memory-budget.ts    # Device memory budget tracking
│   └── leader-election.ts  # K8s Lease-based election
├── clients/
│   ├── redis.ts            # Redis/Valkey client, connection management
│   ├── runner.ts           # HTTP client for runner contract endpoints
│   └── database.ts         # PostgreSQL client, query helpers
├── health/
│   ├── probes.ts           # Readiness, liveness
│   └── metrics.ts          # Prometheus metrics
└── types/                  # Internal types (re-exports from @sardeenz/types)
```

**Verification:** `npm run build`, `npm run lint`, `npm run typecheck`, `npm test` (unit tests for config parsing).

### 2.5 — Design PostgreSQL Schema and Migrations

**Depends on:** Task 2.4

Design and implement the PostgreSQL schema for persistent configuration data. Real-time state (routing map, model states, device memory) lives in Redis (ADR-009) — PostgreSQL stores durable data that must survive full cluster restarts.

**Tables:**

**`models`** — model deployment configurations (what the admin requested, not the runtime state):

| Column            | Type                   | Description                                          |
| ----------------- | ---------------------- | ---------------------------------------------------- |
| `id`              | `uuid` PK              | Internal identifier                                  |
| `name`            | `text` UNIQUE NOT NULL | Model name (routing key, e.g., `meta-llama/Llama-3`) |
| `runner_type`     | `text` NOT NULL        | Required runner type (e.g., `vllm`, `triton`)        |
| `model_path`      | `text` NOT NULL        | Path to model weights on shared storage              |
| `required_memory` | `bigint`               | Estimated device memory requirement (bytes)          |
| `device_type`     | `text`                 | Required device type (`CUDA`, `ROCM`, `CPU`)         |
| `tensor_parallel` | `integer` DEFAULT 1    | Tensor parallelism degree                            |
| `engine_config`   | `jsonb`                | Engine-specific configuration (passed to runner)     |
| `created_at`      | `timestamptz` NOT NULL | Deployment creation time                             |
| `updated_at`      | `timestamptz` NOT NULL | Last configuration update                            |

**`memory_profiles`** — observed memory footprints for model/engine combinations:

| Column           | Type                   | Description                                      |
| ---------------- | ---------------------- | ------------------------------------------------ |
| `id`             | `uuid` PK              | Internal identifier                              |
| `model_name`     | `text` NOT NULL        | Model name                                       |
| `runner_type`    | `text` NOT NULL        | Runner type used for the measurement             |
| `device_type`    | `text` NOT NULL        | Device type for this profile                     |
| `weights_bytes`  | `bigint`               | Memory consumed by model weights                 |
| `kv_cache_bytes` | `bigint`               | Memory consumed by KV cache at max context       |
| `overhead_bytes` | `bigint`               | Runtime overhead (CUDA context, allocator, etc.) |
| `total_bytes`    | `bigint` NOT NULL      | Total device memory consumption                  |
| `measured_at`    | `timestamptz` NOT NULL | When the profile was recorded                    |

**`benchmarks`** — performance benchmarks for model deployments:

| Column                   | Type                   | Description                       |
| ------------------------ | ---------------------- | --------------------------------- |
| `id`                     | `uuid` PK              | Internal identifier               |
| `model_name`             | `text` NOT NULL        | Model name                        |
| `runner_type`            | `text` NOT NULL        | Runner type used                  |
| `tokens_per_second`      | `real`                 | Measured throughput               |
| `time_to_first_token_ms` | `real`                 | Measured TTFT                     |
| `context_length`         | `integer`              | Context length used for benchmark |
| `batch_size`             | `integer`              | Batch size used                   |
| `measured_at`            | `timestamptz` NOT NULL | When the benchmark was run        |

**`settings`** — persistent configuration (eviction thresholds, global defaults):

| Column       | Type                   | Description                        |
| ------------ | ---------------------- | ---------------------------------- |
| `key`        | `text` PK              | Setting key (e.g., `eviction.max`) |
| `value`      | `jsonb` NOT NULL       | Setting value                      |
| `updated_at` | `timestamptz` NOT NULL | Last update time                   |

**Migration tooling:** Use a migration library compatible with ESM TypeScript (e.g., `postgres-migrations`, `umzug`, or raw SQL files with a simple runner). Migrations are numbered and idempotent.

**Verification:** Migrations run cleanly against an empty PostgreSQL database. Schema matches the OpenAPI spec field types.

### 2.6 — Implement Model Lifecycle State Machine

**Depends on:** Tasks 2.4, 2.5

The core state machine that governs every model's lifecycle. All state transitions must be validated — invalid transitions are rejected.

**States and transitions:**

```
PENDING ──────► STARTING ──────► ACTIVE
                   │                 │
                   │                 ▼
                   │             DRAINING ──────► SLEEPING
                   │                                 │
                   │                 ┌───────────────┘
                   │                 ▼
                   │             STARTING ──────► ACTIVE
                   │
                   ▼
                STOPPED ◄─────── STOPPING ◄────── ACTIVE
                                    ▲                │
                                    │                ▼
                                    └────────── DRAINING

        (any non-terminal state) ──────► ERROR ──────► STOPPED
```

**Valid transitions:**

| From       | To         | Trigger                                                  |
| ---------- | ---------- | -------------------------------------------------------- |
| `PENDING`  | `STARTING` | Placement succeeds, runner start command issued          |
| `STARTING` | `ACTIVE`   | Runner reports `READY` via health check                  |
| `STARTING` | `ERROR`    | Runner reports `ERROR` or start times out                |
| `ACTIVE`   | `DRAINING` | Sleep or stop requested — proxy stops new requests       |
| `DRAINING` | `SLEEPING` | All in-flight requests complete, sleep command succeeds  |
| `DRAINING` | `STOPPING` | All in-flight requests complete, stop command issued     |
| `DRAINING` | `ERROR`    | Drain times out or sleep/stop command fails              |
| `SLEEPING` | `STARTING` | Wake trigger received, wake command issued to runner     |
| `SLEEPING` | `STOPPING` | Model removed while sleeping                             |
| `STOPPING` | `STOPPED`  | Runner process exits, confirmed via health check failure |
| `STOPPING` | `ERROR`    | Stop times out                                           |
| `ERROR`    | `STOPPED`  | Error acknowledged or recovery timeout expires           |
| `ERROR`    | `STARTING` | Admin-initiated retry                                    |

**State storage:**

- **Runtime state** lives in Redis/Valkey — the model's current lifecycle state, last transition time, assigned worker, and runner endpoint. This is what the proxy reads and the dashboard displays.
- **Configuration** lives in PostgreSQL — the model's deployment parameters (what was requested). This survives full Redis flushes.

**Timeout recovery:** Every non-terminal state has a configurable timeout. If a model stays in `STARTING` longer than the startup timeout, it transitions to `ERROR`. If it stays in `DRAINING` longer than the drain timeout, the control plane force-stops the runner. This prevents models from getting stuck in intermediate states.

**Concurrency:** The state machine must handle concurrent transitions safely. Use Redis transactions (MULTI/EXEC or Lua scripts) to ensure atomic state updates. Two concurrent wake triggers for the same model must not both attempt to start it.

**Verification:** Unit tests covering all valid transitions, all invalid transition rejections, and all timeout recovery paths.

### 2.7 — Implement Device Memory Budget Tracking

**Depends on:** Tasks 2.4, 2.11 (Redis client)

Maintain a global view of device memory allocation across all workers. Workers self-report device memory usage to Redis (see ADR-009) — the control plane reads this data for placement and eviction decisions.

**Data flow:**

1. Workers push device memory reports to Redis at regular intervals (key: `sardeenz:workers:{workerId}:memory`)
2. Workers include per-device breakdown: `deviceIndex`, `deviceType`, `memoryUsedBytes`, `memoryTotalBytes`
3. The control plane reads these reports to compute available capacity per worker per device
4. When a model is deployed, the control plane reserves capacity in its in-memory budget
5. When a model sleeps, the freed capacity is released back to the budget

**Budget data structure (in-memory):**

Per worker, per device:

- `totalBytes` — total device memory (from worker capability report)
- `usedBytes` — last reported usage (from worker memory push)
- `reservedBytes` — memory reserved by the control plane for models being started (not yet reflected in worker reports)
- `availableBytes` — `totalBytes - max(usedBytes, reservedBytes)`

**Staleness handling:**

- If a worker's memory report is older than the heartbeat timeout, mark the worker as potentially stale
- Placement decisions use the freshest data available but re-validate capacity before issuing a runner start command
- If re-validation fails (capacity was consumed between decision and execution), retry placement on the next-best candidate

**Verification:** Unit tests for budget computation, reservation/release, and staleness detection.

### 2.8 — Implement Workload Placement Pipeline

**Depends on:** Tasks 2.6, 2.7, 2.12

Four-stage pipeline that resolves where a model should run (see ADR-011).

**Stage 1 — Runner type selection:**

Given the model's workload type (LLM, DIFFUSION, PREDICTIVE, EMBEDDING), identify which runner types can serve it. This uses runner capability declarations cached from `GET /capabilities`.

**Stage 2 — Hardware filtering:**

Filter workers to those with compatible accelerators. A vLLM runner requires CUDA or ROCm; an MLServer runner can run on CPU. Match the runner's `supportedDeviceTypes` against the worker's reported device types.

**Stage 3 — Capacity filtering:**

Filter to workers with enough available device memory (from the budget tracker, Task 2.7). Account for tensor parallelism — a model requiring 2 devices needs a worker with 2 compatible devices each having sufficient free memory.

If no worker has sufficient capacity, trigger eviction (Task 2.9) and re-evaluate.

**Stage 4 — Placement strategy:**

Among candidates, apply a placement policy. The initial strategy is **most-available-capacity** (bin-packing avoidance — spread workloads to leave headroom). The strategy interface is pluggable:

```typescript
interface PlacementStrategy {
  select(candidates: PlacementCandidate[]): PlacementCandidate;
}
```

Future strategies (balanced distribution, affinity/anti-affinity, cost-weighted) implement the same interface.

**Verification:** Unit tests for each stage independently. Integration test for the full pipeline with multiple workers and models.

### 2.9 — Implement LRU Eviction Engine

**Depends on:** Tasks 2.6, 2.7, 2.10

When the placement pipeline (Task 2.8) finds no worker with sufficient capacity, the eviction engine frees device memory by sleeping (or stopping) the least-recently-used models.

**Eviction flow:**

1. Placement pipeline reports insufficient capacity on all candidate workers
2. Eviction engine ranks active models by last inference time (from proxy metrics or runner health data)
3. Selects the least-recently-used model(s) that, if evicted, would free enough memory for the new deployment
4. Sends sleep commands (if the runner supports sleep) or stop commands (if it doesn't)
5. Waits for sleep/stop to complete
6. Re-runs the placement pipeline with the freed capacity

**Pluggable strategy interface:**

```typescript
interface EvictionStrategy {
  selectVictims(candidates: EvictionCandidate[], requiredBytes: number): EvictionCandidate[];
}
```

The default implementation is LRU. Future strategies implement the same interface.

**Safeguards:**

- **Max evictions per cycle** — configurable limit (default 3) to prevent eviction cascades
- **Eviction circuit breaker** — if evictions are happening too frequently (e.g., >5 per minute), pause eviction and alert. This prevents thrashing where loading model A evicts B, then a request for B evicts A.
- **Non-evictable models** — support for marking models as pinned (never evict), configured in PostgreSQL
- **Minimum active time** — don't evict a model that was loaded less than a configurable duration ago (default 60s), to prevent evicting models that haven't had a chance to serve traffic

**Verification:** Unit tests for the LRU algorithm, safeguard checks, and victim selection logic. Integration test for the full eviction cycle.

### 2.10 — Implement Sleep/Wake Coordination

**Depends on:** Tasks 2.4, 2.6

HTTP client for the runner contract endpoints. The control plane calls these to orchestrate model lifecycle transitions.

**Runner contract client:**

| Runner endpoint      | Method | When the control plane calls it                            |
| -------------------- | ------ | ---------------------------------------------------------- |
| `GET /health`        | GET    | Periodically, to detect readiness and monitor state        |
| `GET /memory-report` | GET    | After runner is ready, to update device memory budget      |
| `POST /sleep`        | POST   | When evicting or explicitly sleeping a model               |
| `POST /wake`         | POST   | When waking a sleeping model (from proxy trigger or admin) |
| `GET /sleep-status`  | GET    | To verify sleep state before attempting wake               |
| `GET /progress`      | GET    | During startup, to report loading progress to dashboard    |
| `GET /capabilities`  | GET    | Once after runner starts, cached for placement decisions   |

**Health polling:**

- Poll runner health at a configurable interval (default 10s)
- Detect state transitions: `STARTING` → `READY`, `READY` → `BUSY`, `BUSY` → `READY`, any → `ERROR`
- On `READY` detection after `STARTING`: transition model to `ACTIVE`, update routing map
- On `ERROR` detection: transition model to `ERROR`, update routing map, alert

**Sleep/wake protocol:**

1. **Sleep:** Transition model to `DRAINING` in routing map → wait for in-flight requests to drain (monitor `activeRequests` from health endpoint) → send `POST /sleep` to runner → on success, transition model to `SLEEPING` in routing map
2. **Wake:** Transition model to `STARTING` in routing map → send `POST /wake` to runner → poll health until `READY` → transition model to `ACTIVE` in routing map

**Timeouts:** Both sleep and wake have configurable timeouts. If the operation doesn't complete within the timeout, the control plane transitions the model to `ERROR`.

**Verification:** Unit tests for the client with mocked HTTP responses. Integration test for the full sleep → wake round-trip.

### 2.11 — Implement Routing Map Management

**Depends on:** Tasks 2.4, 2.6

The control plane is the sole writer of the routing map in Redis/Valkey. The proxy reads it for request routing.

**Redis data structures** (as defined in the proxy-control-plane spec):

- **Key:** `sardeenz:routing-map` (Redis hash) — one field per model, value is JSON-serialized `RoutingEntry`
- **Channel:** `sardeenz:routing-updates` — pub/sub channel for `RoutingMapUpdate` notifications

**Write operations:**

| Operation              | Redis commands                                 | Pub/sub event type    |
| ---------------------- | ---------------------------------------------- | --------------------- |
| Model deployed         | `HSET` routing entry with state `STARTING`     | `MODEL_ADDED`         |
| Model becomes active   | `HSET` with state `ACTIVE` + endpoint list     | `MODEL_STATE_CHANGED` |
| Model entering drain   | `HSET` with state `DRAINING`                   | `MODEL_STATE_CHANGED` |
| Model sleeping         | `HSET` with state `SLEEPING`, empty endpoints  | `MODEL_STATE_CHANGED` |
| Model waking           | `HSET` with state `STARTING`                   | `MODEL_STATE_CHANGED` |
| Model removed          | `HDEL` routing entry                           | `MODEL_REMOVED`       |
| Endpoint added         | `HSET` with updated endpoint list              | `ENDPOINT_ADDED`      |
| Endpoint removed       | `HSET` with updated endpoint list              | `ENDPOINT_REMOVED`    |
| Endpoint health change | `HSET` with updated `healthy` flag on endpoint | `ENDPOINT_UPDATED`    |

**Atomicity:** Use Redis transactions (MULTI/EXEC) to ensure the routing map update and pub/sub notification are atomic. The proxy must never see a state change without the corresponding pub/sub notification.

**Verification:** Unit tests for each write operation. Integration test verifying the proxy receives pub/sub notifications after routing map changes.

### 2.12 — Implement Worker Pool Management

**Depends on:** Tasks 2.4, 2.7

Dynamic worker discovery and liveness tracking. Workers join and leave the pool without requiring a control plane restart.

**Worker registration:**

Workers announce themselves by writing to Redis:

- `sardeenz:workers:{workerId}:info` — worker capabilities (device types, counts, memory per device, architecture)
- `sardeenz:workers:{workerId}:memory` — current device memory usage (updated at regular intervals)
- `sardeenz:workers:{workerId}:heartbeat` — timestamp of last heartbeat (updated every few seconds)

The control plane discovers workers by scanning `sardeenz:workers:*` keys and subscribing to a `sardeenz:worker-events` pub/sub channel for join/leave notifications.

**Capability registry (in-memory):**

- Built from worker self-reports in Redis
- Updated when workers join, leave, or update capabilities
- Queried by the placement pipeline (Task 2.8) for hardware filtering

**Heartbeat detection:**

- The control plane monitors worker heartbeat timestamps
- If a worker's heartbeat is older than the configured timeout (default 30s), it's considered dead
- Dead worker handling: mark all models on that worker as `ERROR`, remove endpoints from routing map, update memory budget

**Worker leave (graceful):**

- Worker announces it's leaving via pub/sub
- Control plane drains models on that worker (transition to `DRAINING`, then re-place or stop)
- Routing map updated to remove endpoints

**Verification:** Integration test for worker join → placement → worker leave → model recovery.

### 2.13 — Implement Wake Trigger and Routing Map APIs

**Depends on:** Tasks 2.6, 2.10, 2.11

Implement the two proxy-facing HTTP endpoints defined in the `proxy-control-plane.yaml` spec.

**`POST /api/v1/wake`:**

1. Receive wake trigger request from proxy
2. Look up model — return 404 if unknown
3. Check model state — return 409 if not `SLEEPING` (or already `STARTING`)
4. If model is `SLEEPING`: start the wake flow (Task 2.10). If model is already `STARTING`: acknowledge (idempotent, no new action).
5. Return 202 with acknowledgement (wake happens asynchronously)
6. The proxy detects readiness via Redis pub/sub — it does not poll this endpoint

**`GET /api/v1/routing-map`:**

1. Return the full routing map from Redis as a JSON object
2. Used by the proxy for bootstrap or recovery when Redis pub/sub is unavailable
3. Same data structure as stored in the Redis hash

**Verification:** Integration test for the wake trigger → model wakes → routing map updated → proxy detects via pub/sub.

### 2.14 — Implement Admin APIs

**Depends on:** Tasks 2.6, 2.8, 2.9, 2.10, 2.12

Implement the admin-facing HTTP endpoints from the control plane OpenAPI spec (Task 2.1). These are the endpoints the dashboard backend (Phase 3) will call.

**Model management:**

- `POST /api/v1/models` — validate request, run placement pipeline, start runner, return placement result. If placement fails (no capacity), trigger eviction and retry.
- `GET /api/v1/models` — aggregate model list from Redis (runtime state) + PostgreSQL (configuration)
- `GET /api/v1/models/{modelName}` — model details including state, worker assignment, device memory usage, runner capabilities
- `DELETE /api/v1/models/{modelName}` — drain → stop → remove from routing map and PostgreSQL
- `POST /api/v1/models/{modelName}/sleep` — admin-initiated sleep (same flow as eviction sleep, but explicit)
- `POST /api/v1/models/{modelName}/wake` — admin-initiated wake (same flow as proxy-triggered wake)

**Worker management:**

- `GET /api/v1/workers` — list workers with capabilities, running models, memory usage
- `GET /api/v1/workers/{workerId}` — detailed worker view with per-device breakdown

**Cluster state:**

- `GET /api/v1/cluster/status` — aggregate: total/used/free device memory, model counts by state, worker count, leader status
- `GET /api/v1/cluster/memory` — per-worker, per-device memory breakdown

**Verification:** Integration tests for the full deploy → sleep → wake → stop lifecycle via admin APIs.

### 2.15 — Implement Leader Election

**Depends on:** Task 2.4

K8s Lease-based leader election for high availability. Only the leader performs orchestration actions (placement, eviction, state machine transitions, routing map writes). The standby watches the Lease and takes over on failure.

**Mechanism:**

- Use the Kubernetes `coordination.k8s.io/v1` Lease API
- Leader acquires the Lease and renews it at regular intervals (e.g., every 5s with a 15s duration)
- On renewal failure, the leader demotes itself
- Standby instances watch the Lease and compete for acquisition when it expires
- On promotion: the new leader reconstructs state from Redis (runtime state) and PostgreSQL (config), then resumes orchestration

**Behavior during failover:**

- Inference traffic is unaffected — the proxy continues forwarding to active runners using the cached routing map
- No new placement, eviction, or state transitions during the leadership gap (~15s)
- After promotion, the new leader reconciles: checks for stale states, cleans up stuck transitions, resumes health polling

**Local development mode:** When not running in K8s (no Lease API available), the control plane runs as a single leader without election. This is the default for development.

**Verification:** Unit tests for the election state machine. Manual verification of failover behavior in a K8s environment.

### 2.16 — Implement Health and Metrics

**Depends on:** Task 2.4

Health endpoints and Prometheus metrics.

**Health endpoints** (on the main listen port):

| Endpoint   | Purpose                                                                                                       |
| ---------- | ------------------------------------------------------------------------------------------------------------- |
| `/healthz` | Liveness probe — returns 200 if the process is running                                                        |
| `/readyz`  | Readiness probe — returns 200 if Redis is connected, PostgreSQL is connected, and leader election is resolved |

**Prometheus metrics** (on `/metrics`):

| Metric                                                    | Type      | Description                                                |
| --------------------------------------------------------- | --------- | ---------------------------------------------------------- |
| `sardeenz_control_plane_models_total`                     | Gauge     | Number of models by state (`ACTIVE`, `SLEEPING`, etc.)     |
| `sardeenz_control_plane_workers_total`                    | Gauge     | Number of registered workers by status                     |
| `sardeenz_control_plane_device_memory_bytes`              | Gauge     | Device memory by worker and state (total, used, available) |
| `sardeenz_control_plane_placement_duration_seconds`       | Histogram | Time to complete placement pipeline                        |
| `sardeenz_control_plane_evictions_total`                  | Counter   | Evictions triggered, labeled by reason (placement, manual) |
| `sardeenz_control_plane_eviction_duration_seconds`        | Histogram | Time to complete eviction cycle                            |
| `sardeenz_control_plane_sleep_duration_seconds`           | Histogram | Time for runner sleep operation                            |
| `sardeenz_control_plane_wake_duration_seconds`            | Histogram | Time for runner wake operation                             |
| `sardeenz_control_plane_wake_triggers_total`              | Counter   | Wake triggers received from proxy                          |
| `sardeenz_control_plane_state_transitions_total`          | Counter   | Model state transitions, labeled by from/to state          |
| `sardeenz_control_plane_leader_is_leader`                 | Gauge     | 1 if this instance is the leader, 0 otherwise              |
| `sardeenz_control_plane_runner_health_check_errors_total` | Counter   | Failed runner health checks                                |

**Structured logging** — all log lines are JSON with fields for request ID, model name, worker ID, duration, and outcome. State transitions log both the old and new state.

**Verification:** `curl /healthz`, `curl /readyz`, `curl /metrics` return expected formats.

### 2.17 — Build Container Image

**Depends on:** Task 2.16

Multi-stage Docker build at `control-plane/Dockerfile`.

**Build stage:** Node.js 22, install dependencies, compile TypeScript, prune dev dependencies.

**Runtime stage:** Node.js 22 slim image with only production dependencies and compiled JavaScript.

**Image requirements:**

- Runs as a non-root user
- Exposes the configured listen port
- Health check instruction using `/healthz`
- Node.js configured for production (`NODE_ENV=production`)

**Build:** `docker build -t sardeenz-control-plane ./control-plane` from the repo root.

**Verification:** Build succeeds. Container starts and responds to health checks.

### 2.18 — Integration Test Suite

**Depends on:** Tasks 2.6–2.16

Integration tests that validate the control plane's core orchestration scenarios. Tests run against real Redis/Valkey and PostgreSQL instances — no mocks for data stores (per the [overall plan](overall-plan.md#testing-strategy)).

**Test infrastructure:**

- A mock runner HTTP server that implements the runner contract (health, sleep/wake, memory, capabilities, progress)
- A real Redis/Valkey instance (via test container or local instance)
- A real PostgreSQL instance (via test container or local instance)
- The control plane service under test

**Test scenarios:**

| #   | Scenario                        | What it validates                                                                      |
| --- | ------------------------------- | -------------------------------------------------------------------------------------- |
| 1   | Model deployment — happy path   | Deploy request → placement → runner start → health poll → ACTIVE → routing map updated |
| 2   | Model deployment with eviction  | Deploy when no capacity → evict LRU model → freed capacity → deploy succeeds           |
| 3   | Sleep/wake round-trip           | Sleep command → runner offloads → SLEEPING → wake trigger → runner reloads → ACTIVE    |
| 4   | Wake trigger from proxy         | `POST /api/v1/wake` → model wakes → routing map updated → pub/sub notification sent    |
| 5   | Thundering herd (control plane) | Multiple concurrent wake triggers for same model → only one wake operation             |
| 6   | State machine transitions       | All valid transitions succeed; all invalid transitions rejected                        |
| 7   | Timeout recovery                | Model stuck in STARTING beyond timeout → transitions to ERROR                          |
| 8   | Worker join/leave               | New worker detected → available for placement; worker leaves → models recovered        |
| 9   | Eviction safeguards             | Eviction respects max-per-cycle limit; pinned models not evicted                       |
| 10  | Routing map consistency         | Every state change produces a routing map update + pub/sub notification                |
| 11  | Model stop                      | Delete model → DRAINING → STOPPING → STOPPED → removed from routing map                |
| 12  | Placement pipeline              | Multi-worker setup: correct runner type, hardware, and capacity filtering              |
| 13  | Admin wake/sleep                | Admin-initiated sleep and wake via API (separate from proxy wake trigger)              |
| 14  | Runner health check failure     | Runner goes ERROR → model transitions to ERROR → routing map updated                   |
| 15  | Cluster status accuracy         | `GET /api/v1/cluster/status` reflects actual cluster state                             |

**Verification:** `npm test` passes. Integration tests pass with running Redis and PostgreSQL instances.

## Definition of Done

From the [overall project plan](overall-plan.md#phase-2-control-plane-sleepwake-orchestration):

- [ ] Model lifecycle state machine covers all transitions, including error recovery (e.g., runner fails to start → state returns to `STOPPED`)
- [ ] Placement pipeline correctly matches models to workers across the three scenarios: GPU with capacity, GPU without capacity (triggers eviction), CPU-only fallback
- [ ] LRU eviction frees enough memory for a new deployment by sleeping the least-recently-used model(s)
- [ ] Sleep/wake round-trip works end-to-end: control plane sends sleep → runner offloads → control plane sends wake → runner reloads → model serves traffic
- [ ] Worker join/leave detected within 30 seconds without control plane restart
- [ ] Leader failover completes within the K8s Lease duration (typically 15s); inference traffic is unaffected during failover
- [ ] All OpenAPI specs pass `redocly lint`
- [ ] Generated TypeScript types compile cleanly (`make typecheck`)
- [ ] Integration tests pass against real Redis and PostgreSQL instances (no mocks for data stores)
- [ ] `npm run lint` passes with zero warnings
- [ ] `npm run typecheck` passes with zero errors
- [ ] Container image builds and runs successfully
- [ ] Prometheus metrics endpoint exposes: model counts, worker counts, memory budgets, placement latency, eviction counts, wake trigger counts, state transitions, leader status

## Open Questions

- **Worker registration protocol:** How do workers announce themselves to the control plane? Options: (a) workers write to well-known Redis keys on startup and the control plane discovers them via key scan + pub/sub; (b) workers call a control plane registration API. Leaning toward (a) — keeps the push model consistent with memory reporting and avoids coupling workers to the control plane's HTTP API.
- **Drain before sleep — wait strategy:** How long should the control plane wait for in-flight requests to drain before sending the sleep command? Options: (a) poll the runner's `activeRequests` from the health endpoint until zero; (b) fixed timeout. Leaning toward (a) with a maximum timeout — most requests complete in seconds, but long-running streaming responses need a ceiling.
- **Model deployment idempotency:** If the same model is deployed twice with the same name, should it fail, update the existing deployment, or be a no-op? Leaning toward: fail with 409 if the model already exists; require explicit delete → re-deploy for configuration changes.
- **Memory profile bootstrapping:** Where does the initial `required_memory` estimate come from for a model that's never been deployed? Options: (a) admin provides it manually; (b) use a heuristic based on model size on disk; (c) deploy with a "profile" flag that measures and records. Leaning toward (a) initially, with (c) as a future improvement.
- **Dashboard real-time events:** Should the control plane expose an SSE endpoint for real-time state changes, or should the dashboard backend subscribe to Redis pub/sub directly? Leaning toward the dashboard backend subscribing to Redis directly — it already reads from Redis for state, and this avoids adding a streaming API to the control plane.

## Dependencies

- **Phase 0 outputs** — runner contract spec for health check, sleep/wake, memory reporting, and capability interfaces
- **Phase 1 outputs** — proxy-control-plane spec for wake trigger API and routing map schema; running proxy for end-to-end testing
- **Redis/Valkey instance** — for routing map, model states, device memory, worker capabilities
- **PostgreSQL instance** — for model configurations, benchmarks, memory profiles
- **Node.js 22+** — runtime (see [setup guide](../development/setup.md))
- **TypeScript toolchain** — compiler, linter, test runner (Vitest)

## Risks

| Risk                                                 | Impact                                                         | Mitigation                                                                                     |
| ---------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| State machine edge cases under concurrent operations | Models stuck in intermediate states, orphaned runners          | Exhaustive state transition tests; timeout-based recovery for every non-terminal state         |
| Eviction cascades                                    | Evicting A to load B triggers eviction of C, thrashing cluster | Configurable eviction limits (max per cycle); circuit breaker on eviction frequency            |
| Worker self-report lag                               | Placement decisions on stale memory data                       | Heartbeat timeout detection; placement pipeline re-validates capacity before starting a runner |
| Leader election during active orchestration          | In-flight operations (sleep, wake, placement) interrupted      | On promotion, new leader reconciles state and retries stuck transitions                        |
| Runner contract timeout tuning                       | Sleep/wake timeouts too short for large models, or too long    | Configurable per-operation timeouts; monitor actual durations via metrics and adjust           |
| PostgreSQL migration complexity over time            | Schema changes break running deployments                       | Use idempotent, versioned migrations; test migrations against populated databases              |

## References

- [Overall project plan](overall-plan.md) — Phase 2 deliverables and definition of done
- [Architecture overview](../architecture/overview.md) — system design, request flows, control plane role
- [ADR-001: L7 VRAM scheduling](../architecture/adrs/adr-001-l7-vram-scheduling.md) — scheduling paradigm
- [ADR-002: Four-component split](../architecture/adrs/adr-002-four-component-split.md) — component boundaries
- [ADR-005: OpenAPI contracts](../architecture/adrs/adr-005-openapi-contracts.md) — cross-language contract strategy
- [ADR-007: Redundancy and scaling](../architecture/adrs/adr-007-redundancy-and-scaling.md) — leader/standby design
- [ADR-009: State and persistence](../architecture/adrs/adr-009-state-and-persistence.md) — Redis/PostgreSQL/Prometheus split
- [ADR-010: Engine runners](../architecture/adrs/adr-010-engine-runners.md) — runner abstraction
- [ADR-011: Worker capabilities and placement](../architecture/adrs/adr-011-worker-capabilities-and-placement.md) — placement pipeline design
- [ADR-012: TypeScript stack](../architecture/adrs/adr-012-typescript-stack.md) — TypeScript choice rationale
- [Proxy ↔ control plane spec](../../packages/contracts/specs/proxy-control-plane.yaml) — wake trigger and routing map contract (Phase 1 output)
- [Engine runner contract spec](../../packages/contracts/specs/engine-runner.yaml) — runner HTTP endpoints (Phase 0 output)
- [Runner contract design doc](../architecture/components/runner-contract.md) — state model, communication patterns (Phase 0 output)
- [Proxy design doc](../architecture/components/proxy.md) — proxy behavior, connection parking, routing map consumption (Phase 1 output)
- [Coding standards](../development/coding-standards.md) — TypeScript and OpenAPI conventions
