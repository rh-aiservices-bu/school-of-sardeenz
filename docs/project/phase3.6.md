# Phase 3.6 — Dev Worker Agent

## Goal

Build a local-process worker agent that lets the full Sardeenz stack run in a development environment without containers. In production, workers are Kubernetes Pods running a worker agent that spawns runner processes for each model. In dev, the worker agent runs as a plain Node.js process on `localhost`, registers itself in Redis using the same protocol as a production worker, and spawns lightweight runner stubs that implement the full runner contract — including simulated inference responses.

This phase unblocks end-to-end local development and testing of the entire deploy → route → inference → sleep → wake → evict flow without requiring containers, GPUs, or real inference engines.

## Scope

### In scope

Four functional areas:

1. **Worker agent OpenAPI spec** — formalize the worker agent management API (`POST /runners`, `DELETE /runners/{runnerId}`) as an OpenAPI spec, matching the implicit contract in `control-plane/src/clients/worker.ts`
2. **Dev worker agent process** — a TypeScript Fastify server that self-registers to Redis (capabilities, heartbeat, memory), exposes the worker agent management HTTP API, and spawns/supervises runner stub child processes
3. **Runner stub** — a lightweight TypeScript Fastify server implementing the full engine runner contract (`/health`, `/memory-report`, `/sleep`, `/wake`, `/sleep-status`, `/progress`, `/capabilities`) with configurable simulated behavior (startup delay, memory footprint, sleep/wake latency), plus a minimal OpenAI-compatible inference endpoint (`/v1/chat/completions`) returning canned responses for end-to-end proxy testing
4. **Dev environment orchestration** — Makefile targets and configuration to launch one or more dev workers alongside the existing dev stack (Redis, PostgreSQL, control plane, proxy, dashboard)

### Out of scope

- **Real inference engines** — no vLLM, Triton, or MLServer; runner stubs simulate their behavior
- **GPU/accelerator interaction** — device memory values are simulated; no CUDA/ROCm calls
- **SIF/Apptainer integration** — running engine SIFs via `apptainer exec` is a Phase 4 concern; dev workers don't exec SIFs (they fork runner stubs)
- **Container images** — the dev worker runs as a local process only; no Dockerfile
- **Production worker agent** — the real worker agent that runs in K8s Pods is future work; this phase builds the dev simulation layer, though the worker agent management API spec (Task 1) will be reused
- **Multi-node dev setup** — dev workers run on `localhost` only; no distributed dev environment
- **Authentication** — the worker agent management API is internal; no auth required

## Dependencies

| Dependency                    | Status   | Notes                                                                                                               |
| ----------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------- |
| Phase 2 control plane         | Complete | WorkerPoolService (Redis SCAN discovery), WorkerClient, RunnerClient, DeployOrchestrationService, PlacementPipeline |
| Phase 1 proxy                 | Complete | Routing map consumption, connection parking, request forwarding                                                     |
| Phase 3/3.5 dashboard         | Complete | Model deployment UI, worker list, cluster status                                                                    |
| Engine runner contract        | Complete | `packages/contracts/specs/engine-runner.yaml` — defines all runner HTTP endpoints                                   |
| WorkerClient in control plane | Complete | `control-plane/src/clients/worker.ts` — defines the implicit worker agent API                                       |
| Redis/Valkey                  | Required | Worker self-registration, heartbeats, memory reports                                                                |

## Architecture

### Dev environment topology

```
┌─────────────────────────────────────────────────────────────────────┐
│ localhost                                                           │
│                                                                     │
│  ┌──────────┐  ┌───────────────┐  ┌───────────┐  ┌──────────────┐  │
│  │  Redis    │  │ Control Plane │  │   Proxy   │  │  Dashboard   │  │
│  │  :6379    │  │   :3000       │  │   :8080   │  │   :5173      │  │
│  └────┬─────┘  └───────┬───────┘  └─────┬─────┘  └──────────────┘  │
│       │                │                 │                           │
│       │ ◄── self-reg ──┼── HTTP ────────►│                          │
│       │                │                 │                           │
│  ┌────┴──────────────────────────────────┴──────────────────────┐   │
│  │ Dev Worker Agent (dev-worker-0)  :9100                       │   │
│  │                                                              │   │
│  │  ┌─────────────────────┐  ┌─────────────────────┐           │   │
│  │  │ Runner Stub A :9101 │  │ Runner Stub B :9102 │  ...      │   │
│  │  │ (model-a)           │  │ (model-b)           │           │   │
│  │  │ /health             │  │ /health             │           │   │
│  │  │ /v1/chat/completions│  │ /v1/chat/completions│           │   │
│  │  └─────────────────────┘  └─────────────────────┘           │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │ Dev Worker Agent (dev-worker-1)  :9200       (optional)     │   │
│  │  └── Runner Stub C :9201 ...                                │   │
│  └─────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

### Process model

Each dev worker runs the same three-layer process tree as a production worker, but with stubs instead of real engines:

```
Dev Worker Agent (long-lived Node.js process)
├── Runner Stub A (child process, Fastify server on its own port)
│   └── Simulated engine (canned inference responses)
├── Runner Stub B (child process)
│   └── Simulated engine
└── ...
```

The worker agent process:

1. **On startup:** pushes worker info (capabilities, devices, management URL) to Redis, starts heartbeat interval
2. **Continuously:** updates `{prefix}:workers:{workerId}:heartbeat` every 5 seconds
3. **On `POST /runners`:** forks a runner stub child process on the next available port, waits for it to become healthy, returns the runner endpoint
4. **On `DELETE /runners/{runnerId}`:** sends SIGTERM to the runner stub process, cleans up
5. **On shutdown (SIGTERM):** stops all runner stubs, removes Redis keys, exits

### Runner stub lifecycle

Each runner stub simulates the full runner state machine:

```
STARTING ──(configurable delay)──► READY ◄──► BUSY
    │                                │
    │                                ▼
    │                            SLEEPING ──(wake)──► STARTING ──► READY
    │
    └──(if error configured)──► ERROR
```

During `STARTING`, the stub simulates loading phases (`INITIALIZING` → `LOADING_WEIGHTS` → `ALLOCATING_MEMORY` → `READY`) with configurable durations. During `SLEEPING`, the stub frees its simulated device memory. On `POST /wake`, it transitions back through `STARTING` with a shorter delay.

### Redis self-registration (same as production)

The dev worker writes the same Redis keys a production worker would:

```
{prefix}:workers:{workerId}:info       ← JSON: capabilities, devices, managementUrl
{prefix}:workers:{workerId}:heartbeat  ← ISO timestamp, updated every 5s
{prefix}:workers:{workerId}:memory     ← JSON: per-device memory usage
```

The control plane discovers dev workers via its normal `SCAN sardeenz:workers:*:info` — no special dev-mode logic needed.

### Simulated inference

Runner stubs expose a minimal OpenAI-compatible endpoint at `/v1/chat/completions` that returns canned responses:

- **Non-streaming:** returns a complete `ChatCompletionResponse` with a configurable delay (simulating inference time)
- **Streaming:** returns SSE frames with token-by-token output, simulating autoregressive generation with a configurable inter-token delay
- **Model name:** the stub's response includes the model name it was started with, so the proxy's model routing is validated end-to-end

This is sufficient to test the full request flow through the proxy without a real inference engine.

## Implementation Plan

### Task 1: Worker agent OpenAPI spec

Formalize the worker agent management API as an OpenAPI 3.1 spec. This contract is currently implicit — defined only by the `StartRunnerRequest`/`StartRunnerResponse` types and `WorkerClient` class in the control plane.

**Files to create:**

- `packages/contracts/specs/worker-agent.yaml`

**Endpoints:**

- `POST /runners` — start a runner process for a model
  - Request: `StartRunnerRequest` (modelName, runnerType, modelPath, requiredMemory, deviceType, tensorParallel, engineConfig, devices)
  - Response: `StartRunnerResponse` (runnerId, host, port, optional enginePort)
  - `201` on success, `409` if model already running, `503` if no capacity
- `DELETE /runners/{runnerId}` — stop a runner process
  - `204` on success, `404` if runner not found

**Schemas:**

- `StartRunnerRequest` — mirrors the existing TypeScript interface in `control-plane/src/clients/worker.ts`
- `StartRunnerResponse` — runnerId, host, management `port`, and optional `enginePort` (the inference `/v1/*` port; equals `port` when omitted)
- `WorkerInfo` — the JSON structure pushed to `{prefix}:workers:{workerId}:info` (capabilities, devices, managementUrl)
- `WorkerMemoryReport` — the JSON structure pushed to `{prefix}:workers:{workerId}:memory`

**Then regenerate types:** `npm run codegen -w @sardeenz/types`

**Validation:** `npm run validate -w @sardeenz/contracts`

### Task 2: Scaffold dev worker package

Set up the npm workspace package for the dev worker agent.

**Files to create:**

- `runners/dev-worker/package.json` — workspace package `@sardeenz/dev-worker`
- `runners/dev-worker/tsconfig.json` — extends root TypeScript config
- `runners/dev-worker/src/index.ts` — entry point
- `runners/dev-worker/src/config.ts` — configuration from env vars / CLI args

**Configuration (via environment variables, with CLI overrides):**

| Variable                         | Default                  | Description                     |
| -------------------------------- | ------------------------ | ------------------------------- |
| `SARDEENZ_REDIS_URL`             | `redis://localhost:6379` | Redis connection                |
| `SARDEENZ_REDIS_KEY_PREFIX`      | `sardeenz`               | Redis key prefix                |
| `SARDEENZ_WORKER_ID`             | `dev-worker-0`           | Unique worker identifier        |
| `SARDEENZ_WORKER_PORT`           | `9100`                   | Management API listen port      |
| `SARDEENZ_RUNNER_PORT_START`     | `9101`                   | First runner stub port          |
| `SARDEENZ_DEVICE_COUNT`          | `2`                      | Number of simulated GPU devices |
| `SARDEENZ_DEVICE_TYPE`           | `CUDA`                   | Simulated device type           |
| `SARDEENZ_DEVICE_MEMORY_GB`      | `24`                     | Per-device memory in GB         |
| `SARDEENZ_RUNNER_TYPE`           | `vllm`                   | Declared runner type            |
| `SARDEENZ_STARTUP_DELAY_MS`      | `3000`                   | Simulated model loading time    |
| `SARDEENZ_SLEEP_DELAY_MS`        | `500`                    | Simulated sleep offload time    |
| `SARDEENZ_WAKE_DELAY_MS`         | `1500`                   | Simulated wake reload time      |
| `SARDEENZ_INFERENCE_DELAY_MS`    | `200`                    | Simulated inference latency     |
| `SARDEENZ_HEARTBEAT_INTERVAL_MS` | `5000`                   | Heartbeat push interval         |

**Root workspace:** Add `runners/dev-worker` to the root `package.json` workspaces array.

**Verification:** `npm install`, `npm run build -w @sardeenz/dev-worker`, `npm run typecheck -w @sardeenz/dev-worker`

### Task 3: Worker agent — Redis self-registration and heartbeat

Implement the Redis registration module that makes the dev worker visible to the control plane.

**Files to create:**

- `runners/dev-worker/src/registration.ts`

**Behavior:**

- On startup: build `WorkerInfo` from config (capabilities, devices, managementUrl = `http://localhost:{port}`), push to `{prefix}:workers:{workerId}:info`
- Start heartbeat interval: every `HEARTBEAT_INTERVAL_MS`, SET `{prefix}:workers:{workerId}:heartbeat` to current ISO timestamp
- Push initial memory report: `{prefix}:workers:{workerId}:memory` with all devices at 0 used bytes
- On shutdown: stop heartbeat, delete all three Redis keys
- Expose methods for runner stubs to update the memory report when models are loaded/unloaded

### Task 4: Worker agent — management HTTP API

Implement the Fastify server that handles `POST /runners` and `DELETE /runners/{runnerId}`.

**Files to create:**

- `runners/dev-worker/src/server.ts` — Fastify app setup
- `runners/dev-worker/src/routes/runners.ts` — runner management routes
- `runners/dev-worker/src/runner-manager.ts` — spawns, tracks, and stops runner stub child processes

**`POST /runners` flow:**

1. Validate request against `StartRunnerRequest` schema
2. Check no existing runner for the same model name (409 if duplicate)
3. Allocate next available port from the port range
4. Fork a runner stub child process (see Task 5) with model config
5. Wait for the child's health endpoint to return (with timeout)
6. Return `{ runnerId, host: 'localhost', port }` with status 201

**`DELETE /runners/{runnerId}` flow:**

1. Look up runner by ID
2. Send SIGTERM to the child process
3. Wait for exit (with timeout, then SIGKILL)
4. Update the memory report (free the model's simulated memory)
5. Return 204

**Runner tracking:**

- In-memory `Map<runnerId, RunnerProcess>` with PID, port, model name, state
- On child exit (crash or stop): clean up the map entry, update memory report

### Task 5: Runner stub — runner contract implementation

Implement the runner stub as a standalone Fastify server that implements the full engine runner contract from `engine-runner.yaml`.

**Files to create:**

- `runners/dev-worker/src/runner-stub/index.ts` — entry point (child process main)
- `runners/dev-worker/src/runner-stub/server.ts` — Fastify app
- `runners/dev-worker/src/runner-stub/routes/health.ts` — `GET /health`
- `runners/dev-worker/src/runner-stub/routes/memory.ts` — `GET /memory-report`
- `runners/dev-worker/src/runner-stub/routes/sleep.ts` — `POST /sleep`, `POST /wake`, `GET /sleep-status`
- `runners/dev-worker/src/runner-stub/routes/progress.ts` — `GET /progress`
- `runners/dev-worker/src/runner-stub/routes/capabilities.ts` — `GET /capabilities`
- `runners/dev-worker/src/runner-stub/state.ts` — runner state machine

**State machine:**

- On start: transition through `STARTING` phases with simulated delays
  - `INITIALIZING` (10% of startup delay)
  - `LOADING_WEIGHTS` (50% of startup delay)
  - `ALLOCATING_MEMORY` (30% of startup delay)
  - `READY` (final 10%)
- On `POST /sleep`: wait `SLEEP_DELAY_MS`, transition to `SLEEPING`, free simulated memory
- On `POST /wake`: transition to `STARTING`, wait `WAKE_DELAY_MS` (shorter than initial startup), transition to `READY`
- Track `activeRequests` counter for drain detection

**Endpoint responses:**

- `GET /health` — returns current state, active requests, progress (if STARTING)
- `GET /memory-report` — returns simulated per-device memory based on model's `requiredMemory` and device assignment
- `GET /capabilities` — returns configured runner type, supported model types, device types, sleep levels
- `GET /progress` — returns current loading phase and percent complete
- `GET /sleep-status` — returns `isSleeping` boolean and current sleep level

**Communication with parent:** The runner stub receives its configuration (model name, port, device assignment, delays) via command-line arguments or environment variables when forked.

### Task 6: Runner stub — simulated inference endpoint

Add OpenAI-compatible inference endpoints to the runner stub for end-to-end proxy testing.

**Files to create:**

- `runners/dev-worker/src/runner-stub/routes/inference.ts`

**Endpoints:**

- `POST /v1/chat/completions` — returns canned completion responses
  - Non-streaming: wait `INFERENCE_DELAY_MS`, return a complete `ChatCompletionResponse` with a fixed response message (e.g., `"This is a simulated response from model {modelName}."`)
  - Streaming (`"stream": true`): return SSE frames, one token at a time with a configurable inter-token delay (default 20ms), for a fixed response text (~20 tokens)
  - Response includes correct `model` field, `usage` counts, `id`, `created` timestamp
  - Only responds when state is `READY` or `BUSY`; returns 503 if `STARTING`, `SLEEPING`, or `ERROR`
- `GET /v1/models` — returns a single model entry for the loaded model

**Canned response format:**

```json
{
  "id": "chatcmpl-{uuid}",
  "object": "chat.completion",
  "created": 1234567890,
  "model": "{modelName}",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "This is a simulated response from {modelName} on worker {workerId}."
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 10,
    "completion_tokens": 15,
    "total_tokens": 25
  }
}
```

### Task 7: Control plane — update WorkerClient to match spec

Align the existing `WorkerClient` in the control plane with the new OpenAPI spec from Task 1. This is a minor refactoring task — the types and behavior already exist, but should now reference the generated types.

**Files to modify:**

- `control-plane/src/clients/worker.ts` — import types from `@sardeenz/types` instead of defining inline interfaces

### Task 8: Dev environment Makefile targets

Add Makefile targets for launching dev workers alongside the existing dev stack.

**Files to modify:**

- `Makefile` — add dev worker targets

**Targets:**

| Target                 | Description                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------ |
| `make dev-worker`      | Start a single dev worker (`dev-worker-0` on port 9100)                                          |
| `make dev-worker-2`    | Start two dev workers (`dev-worker-0` on 9100, `dev-worker-1` on 9200)                           |
| `make dev-full`        | Start the full dev stack: Redis, PostgreSQL, control plane, proxy, dashboard, and one dev worker |
| `make dev-worker-stop` | Stop all running dev workers                                                                     |

**Environment passthrough:** each target supports `SARDEENZ_*` env var overrides for customization.

### Task 9: Unit tests

**Files to create:**

- `runners/dev-worker/src/__tests__/registration.test.ts`
  - Writes correct Redis keys on startup
  - Heartbeat updates at the configured interval
  - Cleans up Redis keys on shutdown
  - Memory report updates when runners start/stop
- `runners/dev-worker/src/__tests__/runner-manager.test.ts`
  - Starts runner stub on correct port
  - Tracks multiple runners
  - Stops runner by ID
  - Handles runner crash (child exit)
  - Rejects duplicate model names
- `runners/dev-worker/src/__tests__/runner-stub/state.test.ts`
  - State transitions: STARTING → READY → SLEEPING → STARTING → READY
  - Invalid transitions rejected
  - Progress phases advance correctly during STARTING
  - Sleep frees simulated memory, wake re-allocates
- `runners/dev-worker/src/__tests__/runner-stub/inference.test.ts`
  - Non-streaming response has correct shape
  - Streaming response sends valid SSE frames
  - Returns 503 when not in READY state
  - Includes correct model name in response
- `runners/dev-worker/src/__tests__/runner-stub/contract.test.ts`
  - All runner contract endpoints return valid schemas
  - Health endpoint returns correct state at each lifecycle phase
  - Memory report matches device assignment
  - Capabilities match configuration
  - Sleep/wake endpoints transition state correctly

### Task 10: Integration test — end-to-end flow

Add an integration test that validates the full dev-environment flow: start dev worker → control plane discovers it → deploy model via API → proxy routes inference request → response returns.

**Files to create:**

- `runners/dev-worker/src/__tests__/integration/e2e.test.ts`

**Test scenario:**

1. Start Redis (use test database)
2. Register a dev worker in Redis (using registration module)
3. Start the dev worker management server
4. Start a control plane instance (or use the test harness)
5. Deploy a model via `POST /api/v1/models`
6. Wait for model to reach `ACTIVE` state
7. Send an inference request through the proxy (or directly to the runner stub)
8. Verify response is the canned simulated response
9. Sleep the model via `POST /api/v1/models/{modelName}/sleep`
10. Verify model transitions to `SLEEPING`
11. Wake the model via `POST /api/v1/models/{modelName}/wake`
12. Verify model returns to `ACTIVE`
13. Clean up

**Gate:** `redis-integration` — test is skipped without a running Redis instance.

### Task 11: Update documentation and changelog

**Files to modify:**

- `CHANGELOG.md` — add Phase 3.6 entries under `[Unreleased]`
- `docs/project/overall-plan.md` — add Phase 3.6 summary
- `CLAUDE.md` — update project status to reflect Phase 3.6

**Files to create:**

- `runners/dev-worker/README.md` — usage guide (how to start, configure, and use dev workers for local development)

## Task Summary

| #         | Task                                        | Layer         | New files | Modified files | Est. LOC   |
| --------- | ------------------------------------------- | ------------- | --------- | -------------- | ---------- |
| 1         | Worker agent OpenAPI spec + type generation | Contracts     | 1         | 0              | ~120       |
| 2         | Scaffold dev worker package                 | Dev worker    | 4         | 1              | ~100       |
| 3         | Redis self-registration and heartbeat       | Dev worker    | 1         | 0              | ~120       |
| 4         | Worker agent management HTTP API            | Dev worker    | 3         | 0              | ~200       |
| 5         | Runner stub — runner contract               | Dev worker    | 8         | 0              | ~450       |
| 6         | Runner stub — simulated inference           | Dev worker    | 1         | 0              | ~150       |
| 7         | Control plane WorkerClient alignment        | Control plane | 0         | 1              | ~20        |
| 8         | Dev environment Makefile targets            | Build         | 0         | 1              | ~40        |
| 9         | Unit tests                                  | Tests         | 5         | 0              | ~500       |
| 10        | Integration test — e2e flow                 | Tests         | 1         | 0              | ~200       |
| 11        | Documentation and changelog                 | Docs          | 1         | 3              | ~80        |
| **Total** |                                             |               | **25**    | **6**          | **~1,980** |

## Component Architecture

### Dev worker process tree

```
runners/dev-worker/src/
├── index.ts                    # Entry point — config, registration, server start
├── config.ts                   # Configuration from env vars / CLI args
├── registration.ts             # Redis self-registration + heartbeat
├── server.ts                   # Fastify app for management API
├── runner-manager.ts           # Spawns, tracks, and stops runner stubs
├── routes/
│   └── runners.ts              # POST /runners, DELETE /runners/{runnerId}
└── runner-stub/
    ├── index.ts                # Child process entry point
    ├── server.ts               # Fastify app for runner + inference APIs
    ├── state.ts                # Runner state machine (STARTING→READY→SLEEPING)
    └── routes/
        ├── health.ts           # GET /health
        ├── memory.ts           # GET /memory-report
        ├── sleep.ts            # POST /sleep, POST /wake, GET /sleep-status
        ├── progress.ts         # GET /progress
        ├── capabilities.ts     # GET /capabilities
        └── inference.ts        # POST /v1/chat/completions, GET /v1/models
```

### Data flow

```
┌─────────────────────────────────────────────────────────────────────┐
│ Dev Worker Agent                                                    │
│                                                                     │
│  Startup ──► Redis SET {prefix}:workers:{workerId}:info             │
│          ──► Redis SET {prefix}:workers:{workerId}:memory           │
│                                                                     │
│  Every 5s ─► Redis SET {prefix}:workers:{workerId}:heartbeat       │
│                                                                     │
│  POST /runners ─► fork runner-stub child process                    │
│                   ├── child starts Fastify on allocated port         │
│                   ├── child transitions STARTING → READY            │
│                   └── parent updates memory report in Redis          │
│                                                                     │
│  DELETE /runners/{id} ─► SIGTERM to child                           │
│                          ├── child shuts down                       │
│                          └── parent updates memory report           │
└─────────────────────────────────────────────────────────────────────┘

Control plane discovers the worker via SCAN, same as production.
Control plane calls POST /runners to start models.
Control plane calls runner stub endpoints for health/sleep/wake.
Proxy routes inference traffic to runner stub ports.
```

## Acceptance Criteria

### Worker agent

- [x] Dev worker registers in Redis and is discovered by the control plane within one reconciliation cycle (≤ 30s)
- [x] Heartbeat keeps the worker in ONLINE status while the process is running
- [x] Worker disappears from the control plane within the heartbeat timeout after the process stops
- [x] `POST /runners` starts a runner stub on a unique port and returns the endpoint
- [x] `DELETE /runners/{runnerId}` stops the runner stub and frees simulated memory
- [x] Multiple runners can run simultaneously on a single worker
- [x] Graceful shutdown stops all runners and cleans up Redis keys

### Runner stubs

- [x] All six runner contract endpoints (`/health`, `/memory-report`, `/sleep`, `/wake`, `/sleep-status`, `/progress`, `/capabilities`) return valid responses matching the OpenAPI schemas
- [x] State machine transitions follow the correct lifecycle: STARTING → READY ↔ SLEEPING
- [x] Simulated loading progress reports phase transitions during STARTING
- [x] Sleep frees simulated device memory; wake re-allocates it
- [x] `activeRequests` counter in health response reflects in-flight inference requests

### End-to-end flow

- [x] Deploy a model via the dashboard or admin API → control plane places it on the dev worker → runner stub starts → model reaches ACTIVE → proxy routes inference requests → canned response returns
- [x] Sleep a model → runner stub transitions to SLEEPING → proxy parks new requests
- [x] Wake a model (via proxy wake trigger or admin API) → runner stub transitions back to READY → parked requests are released
- [x] Evict a model (by deploying more models than device memory allows) → LRU model is slept → new model is deployed

### Simulated inference

- [x] Non-streaming `POST /v1/chat/completions` returns a valid ChatCompletion response
- [x] Streaming `POST /v1/chat/completions` returns valid SSE frames with token-by-token output
- [x] Response includes the correct model name matching the deployment
- [x] Inference endpoint returns 503 when runner is not in READY state

### Quality

- [x] `npm run lint` and `npm run typecheck` pass across all workspaces
- [x] OpenAPI spec is valid (`npm run validate -w @sardeenz/contracts`)
- [x] Generated types compile cleanly
- [x] All unit tests pass
- [x] Integration test passes with running Redis

## Open Questions

- **Runner stub as child process vs. in-process:** Should runner stubs be forked as separate Node.js processes (matching the production model where each runner is a separate process) or run as in-process Fastify instances within the worker agent? Forked processes are more realistic and test the IPC/supervision logic, but add complexity. In-process is simpler but less faithful to production. **Leaning toward:** forked child processes — the process supervision logic is part of what we're testing, and the overhead is negligible for a dev tool.
- **Port allocation strategy:** Fixed port ranges (worker 0 uses 9100–9199, worker 1 uses 9200–9299) vs. dynamic allocation (find a free port)? Fixed ranges are predictable and easy to configure in tools like Postman; dynamic allocation avoids port conflicts. **Leaning toward:** fixed ranges with dynamic fallback — try the configured port, if taken try the next one.
- **Simulated memory sizing:** How should `requiredMemory` in the deploy request map to simulated device memory? Options: (a) use the value from the deploy request directly; (b) use a fixed simulated value per model. **Leaning toward:** (a) — use the deploy request's `requiredMemory` field, so the control plane's capacity and eviction logic is exercised realistically.
- **Runner stub process recovery:** Should the worker agent auto-restart crashed runner stubs, or just report the error? Production workers will need restart logic, but it adds complexity for a dev tool. **Leaning toward:** no auto-restart — report the crash via the error state and let the user investigate. The control plane's reconciliation will detect the dead runner and transition the model to ERROR.

## Risks

| Risk                                          | Impact                                                                                  | Mitigation                                                                                                                                                                     |
| --------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Port conflicts in dev                         | Runner stubs fail to bind if ports are already in use                                   | Configurable port range; clear error messages with the conflicting port; `make dev-worker-stop` target to clean up                                                             |
| Child process management complexity           | Zombie processes, orphaned runners on unclean shutdown                                  | SIGTERM + SIGKILL timeout; process group management; cleanup on worker agent SIGINT/SIGTERM; trap uncaughtException                                                            |
| Simulated behavior divergence from production | Tests pass in dev but fail in production because stubs don't model real engine behavior | Runner stubs implement the exact same OpenAPI contract; state machine follows the spec rigorously; this phase is explicitly about the orchestration layer, not engine fidelity |
| Redis key pollution                           | Dev workers leave stale keys in Redis on unclean shutdown                               | Heartbeat timeout causes control plane to mark worker as OFFLINE; optional TTL on worker Redis keys; `make dev-worker-stop` cleans up                                          |
| Scope creep toward real engine integration    | Temptation to add real inference capabilities                                           | Strict scope boundary — runner stubs return canned responses only; real engine support is Phase 4 and future runner implementation work                                        |

## References

- [Overall project plan](overall-plan.md) — phase sequencing and delivery strategy
- [Architecture overview](../architecture/overview.md) — system design, component interactions
- [ADR-010: Engine runners](../architecture/adrs/adr-010-engine-runners.md) — worker/runner hierarchy, runner contract rationale
- [ADR-011: Worker capabilities and placement](../architecture/adrs/adr-011-worker-capabilities-and-placement.md) — placement pipeline, worker discovery
- [ADR-009: State and persistence](../architecture/adrs/adr-009-state-and-persistence.md) — Redis for worker registration and state
- [Engine runner contract spec](../../packages/contracts/specs/engine-runner.yaml) — runner HTTP endpoints (Phase 0 output)
- [Runner contract design doc](../architecture/components/runner-contract.md) — state model, communication patterns
- [WorkerClient](../../control-plane/src/clients/worker.ts) — current implicit worker agent API
- [RunnerClient](../../control-plane/src/clients/runner.ts) — control plane → runner HTTP client
- [WorkerPoolService](../../control-plane/src/services/worker-pool.ts) — worker discovery and heartbeat detection
- [Worker agent contract](../../packages/contracts/specs/worker-agent.yaml) — worker agent process model
- [Coding standards](../development/coding-standards.md) — TypeScript and OpenAPI conventions
