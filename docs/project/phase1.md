# Phase 1 — Rust Proxy with Connection Parking

## Goal

Build a stateless, high-performance routing proxy that forwards OpenAI-compatible inference requests to the correct runner — including transparent connection parking when a target model is sleeping. This is the first runtime code in the platform and sits on the critical path of every inference request.

Phase 1 depends on Phase 0's runner contract for model state definitions and health check schemas. The proxy's outputs feed Phase 2: the control plane implements the wake trigger API the proxy calls, and the routing map schema the control plane writes.

## Scope

### In scope

The proxy covers six functional areas for a **stateless** request routing process:

1. **Request routing** — read the routing map from Redis/Valkey, resolve the target runner by model name, forward the request, and proxy the response back to the client
2. **OpenAI protocol compatibility** — support `/v1/chat/completions`, `/v1/completions`, and `/v1/models` for both streaming (SSE) and non-streaming responses
3. **Connection parking** — when a request targets a sleeping model, hold the client connection open, fire a wake trigger to the control plane, and resume forwarding when the model becomes active
4. **Thundering herd prevention** — deduplicate wake triggers so N concurrent requests to the same sleeping model produce exactly 1 control plane call
5. **Cluster forwarding** — weighted round-robin across runner replicas with per-endpoint circuit breaking
6. **Health and observability** — Prometheus scrape endpoint, readiness/liveness probes, structured JSON logging

### Out of scope

- **Non-OpenAI protocols** (MLServer REST, Triton HTTP/gRPC) — future extension when those runner types are implemented
- **TLS termination** — handled by the ingress layer in front of the proxy
- **Authentication/authorization** — future phase or external sidecar; the proxy forwards requests as-is
- **Control plane implementation** — Phase 1 defines the spec the control plane must implement; the actual implementation is Phase 2
- **Runner implementation** — the proxy forwards to runners but does not implement them

## Approach

1. Study the v1 proxy to extract request routing patterns, connection parking behavior, and wake trigger flow
2. Design and write the proxy ↔ control plane OpenAPI spec (routing map, model states, wake trigger)
3. Set up Rust codegen from OpenAPI specs and generate types
4. Scaffold the proxy crate with configuration, logging, error handling, and graceful shutdown
5. Implement routing core: Redis routing map reader, request forwarding, OpenAI protocol handling
6. Implement connection parking with thundering herd prevention
7. Implement cluster forwarding with circuit breaking
8. Add health endpoints and Prometheus metrics
9. Research and document structured output compatibility across engine versions
10. Write the proxy design document
11. Build a multi-stage container image
12. Write integration tests covering all four request flow scenarios

## Tasks

| #    | Task                                     | Status      | Output                                                     |
| ---- | ---------------------------------------- | ----------- | ---------------------------------------------------------- |
| 1.1  | Study v1 proxy patterns                  | Done        | Reference notes (internal)                                 |
| 1.2  | Write proxy ↔ control plane OpenAPI spec | Done        | `packages/contracts/specs/proxy-control-plane.yaml`        |
| 1.3  | Set up Rust codegen from OpenAPI specs   | Done        | Hand-written Rust types in `proxy/src/generated/`          |
| 1.4  | Scaffold proxy crate                     | Done        | Compilable binary with config + logging                    |
| 1.5  | Implement routing core                   | Done        | Request routing with Redis integration                     |
| 1.6  | Implement connection parking             | Done        | Parking subsystem with wake triggers                       |
| 1.7  | Implement cluster forwarding             | Done        | Load balancing + circuit breaking                          |
| 1.8  | Implement health and metrics             | Done        | `/metrics`, `/healthz`, `/readyz`                          |
| 1.9  | Structured output compatibility          | Done        | `docs/architecture/components/structured-output-*.md`      |
| 1.10 | Write proxy design document              | Done        | `docs/architecture/components/proxy.md`                    |
| 1.11 | Build container image                    | Done        | `proxy/Dockerfile`                                         |
| 1.12 | Integration test suite                   | Done        | `proxy/tests/integration/`                                 |

## Task Details

### 1.1 — Study v1 Proxy Patterns

**Depends on:** v1 repo access ([github.com/rh-aiservices-bu/sardeenz](https://github.com/rh-aiservices-bu/sardeenz))

Examine the v1 proxy implementation (part of the Node.js monolith) to extract patterns the Rust proxy must replicate or improve on:

- Request routing logic — how model names resolve to runner endpoints
- Connection parking mechanism — how client connections are held during wake-up
- Wake trigger flow — how the proxy notifies the controller that a sleeping model needs to wake
- Thundering herd handling — how concurrent requests to the same sleeping model are deduplicated
- SSE streaming — how the proxy handles chunked streaming responses and client disconnects
- Redis/Valkey usage — routing map schema, subscription patterns, key structure
- Error handling and retry behavior — what happens when a runner is unreachable or returns an error
- Edge cases discovered during v1 development

This produces internal reference notes, not a deliverable. The notes inform Tasks 1.2 and 1.4–1.8.

### 1.2 — Write Proxy ↔ Control Plane OpenAPI Spec

**Depends on:** Task 1.1

Design and write an OpenAPI 3.1 specification at `packages/contracts/specs/proxy-control-plane.yaml` defining the interface between the routing proxy and the control plane. This is a cross-language contract — the proxy consumes it from Rust, the control plane implements it in TypeScript.

The spec covers three areas:

**1. Routing map schema** (stored in Redis/Valkey, written by control plane, read by proxy):

- Model name → list of runner endpoints with weights and state
- Per-endpoint metadata: host, port, model state, runner health
- Schema for the Redis key structure and value format

**2. Wake trigger API** (proxy → control plane, HTTP):

- `POST /api/v1/wake` — proxy fires this when a request arrives for a sleeping model
- Request includes model identifier; response acknowledges the trigger
- Idempotent — duplicate triggers for the same model are safe

**3. Shared type definitions**:

- `ModelState` enum aligned with the runner contract's `RunnerState` but at the routing level (e.g., `ACTIVE`, `SLEEPING`, `STARTING`, `DRAINING`)
- `RoutingEntry` — per-model routing information
- `RunnerEndpoint` — target address with health and weight metadata

**Conventions** (from [`docs/development/coding-standards.md`](../development/coding-standards.md)):

- Endpoint paths: `kebab-case` (e.g., `/api/v1/wake`)
- Schema names: `PascalCase` (e.g., `RoutingEntry`, `ModelState`)
- Field names: `camelCase` (e.g., `modelId`, `runnerEndpoints`)
- Enum values: `SCREAMING_SNAKE_CASE` (e.g., `ACTIVE`, `SLEEPING`)
- Every endpoint: document 200, 400, 500 responses
- Every field: include a `description`

**Validation:** `npm run validate -w @sardeenz/contracts` must pass with zero errors.

### 1.3 — Set Up Rust Types from OpenAPI Specs

**Depends on:** Task 1.2

Provide Rust structs with serde derive for the routing map schema and wake trigger API types, mirroring the OpenAPI specs.

**Decision:** Hand-maintained Rust types were chosen over automated codegen. Evaluated `openapi-generator` and `progenitor` during this task — generated output was verbose, non-idiomatic, and required extensive customization (serde rename attributes, `Option` handling, `#[serde(flatten)]` for open-ended metadata). Hand-written structs are cleaner, give full control over derives and attributes, and are a small surface (~260 lines across two files). The trade-off is manual synchronization when specs change.

This task:

1. Evaluated codegen approaches — decided on hand-maintained structs
2. Wrote Rust types from `proxy-control-plane.yaml` into `proxy/src/generated/proxy_control_plane.rs`
3. Wrote Rust types from `engine-runner.yaml` into `proxy/src/generated/engine_runner.rs`
4. Verified output compiles with `cargo check`

Also set up TypeScript codegen in `packages/types/` to generate from both specs via `openapi-typescript` (`make codegen`).

### 1.4 — Scaffold Proxy Crate

**Depends on:** Task 1.3

Set up the proxy crate with the foundational infrastructure that all subsequent tasks build on. This is the skeleton — no business logic yet.

**Configuration** (via environment variables, with CLI overrides):

- `SARDEENZ_REDIS_URL` — Redis/Valkey connection string
- `SARDEENZ_LISTEN_ADDR` — proxy listen address (default `0.0.0.0:8080`)
- `SARDEENZ_CONTROL_PLANE_URL` — control plane base URL for wake triggers
- `SARDEENZ_LOG_LEVEL` — log level (default `info`)
- `SARDEENZ_UPSTREAM_TIMEOUT_SECS` — timeout for forwarded requests (default `300`)
- `SARDEENZ_REDIS_KEY_PREFIX` — prefix for Redis keys and pub/sub channels (default `sardeenz`)
- Parking timeout, circuit breaker thresholds, and other tuning parameters

**Structured logging** — JSON format via `tracing` + `tracing-subscriber` with request ID propagation.

**Error types** — `thiserror`-based error hierarchy with `anyhow` for application-level propagation per [coding standards](../development/coding-standards.md).

**Graceful shutdown** — handle SIGTERM/SIGINT, drain in-flight requests, close parked connections with an appropriate error.

**Module layout:**

```
proxy/src/
├── main.rs              # Entry point, config parsing, server startup
├── config.rs            # Configuration from env vars / CLI
├── error.rs             # Error types
├── generated/           # Generated types from OpenAPI specs
├── routing/             # Routing map, model resolution
├── parking/             # Connection parking, wake triggers
├── forwarding/          # Request forwarding, load balancing, circuit breaking
├── protocol/            # OpenAI protocol handling (SSE, models endpoint)
├── health/              # Readiness, liveness, metrics
└── state/               # Redis/Valkey integration
```

**Verification:** `cargo check`, `cargo clippy -- -D warnings`, `cargo test` (unit tests for config parsing).

### 1.5 — Implement Routing Core

**Depends on:** Task 1.4

The core hot path: receive a request, resolve the target runner, forward the request, and proxy the response.

**Redis/Valkey integration:**

- Connect to Redis/Valkey on startup with configurable connection pooling (`deadpool-redis` or `bb8-redis`)
- Read the routing map on each request (or maintain an in-memory cache refreshed via pub/sub)
- Subscribe to routing map change notifications via Redis pub/sub for near-instant updates
- Handle Redis connection failures gracefully — serve from cached routing map with degraded accuracy

**Model resolution:**

- Extract model name from the request (JSON body for completions, path for models endpoint)
- Look up model in the routing map
- Return 404 if the model is unknown, or enter parking flow if the model is sleeping (Task 1.6)

**Request forwarding:**

- Forward the full HTTP request (headers + body) to the target runner
- For non-streaming responses: proxy the complete response back to the client
- For SSE streaming: set up a bidirectional stream — forward the request, then stream response chunks back to the client as they arrive
- Handle client disconnects mid-stream (cancel the upstream request)
- Propagate request IDs and tracing headers

**OpenAI protocol endpoints:**

| Endpoint               | Method | Behavior                                                  |
| ---------------------- | ------ | --------------------------------------------------------- |
| `/v1/chat/completions` | POST   | Route to runner, support both streaming and non-streaming |
| `/v1/completions`      | POST   | Route to runner, support both streaming and non-streaming |
| `/v1/models`           | GET    | Aggregate available models from the routing map           |

Streaming is indicated by `"stream": true` in the request body. The proxy must set appropriate headers (`Content-Type: text/event-stream`, `Transfer-Encoding: chunked`) and forward SSE frames verbatim.

**Verification:** Unit tests for model resolution and routing map parsing. Manual testing against a mock runner.

### 1.6 — Implement Connection Parking

**Depends on:** Task 1.5

The signature feature of the proxy — transparent connection holding while a sleeping model wakes up. From the client's perspective, the request just takes longer; no retry logic is needed.

**Parking flow:**

1. Request arrives for model in `SLEEPING` state
2. Proxy holds the client connection open (parks it) and buffers the request payload
3. Proxy fires a wake trigger to the control plane (`POST /api/v1/wake`)
4. Proxy subscribes to routing map updates for this model (Redis pub/sub)
5. When the model transitions to `ACTIVE`, proxy forwards the buffered request to the now-active runner
6. Runner response streams back to the client as normal

**Thundering herd prevention:**

- Maintain an in-memory map of pending wake triggers per model
- First request for a sleeping model fires the wake trigger; subsequent requests for the same model are parked without additional control plane calls
- After the model wakes, all parked requests for that model are released and forwarded
- Clean up the pending map entry once the model is active

**Timeouts and limits:**

- Configurable parking timeout (default ~120s) — if the model doesn't wake in time, return 503 to parked clients
- Configurable maximum parked connections per model and globally — backpressure via 503 when limits are reached
- If the control plane is unreachable, return 503 immediately (don't park with no chance of wake)

**Edge cases:**

- Client disconnects while parked — clean up the parked connection, decrement counters
- Model transitions to `ERROR` or `STOPPED` while requests are parked — release all parked requests with 503
- Wake trigger fails (control plane returns error) — release parked requests with 503
- Model wakes then immediately goes back to sleep — requests already released continue normally; new requests enter a fresh parking cycle

**Verification:** Unit tests for the parking state machine. Integration test for the full park → wake → forward flow.

### 1.7 — Implement Cluster Forwarding

**Depends on:** Task 1.5

Load balancing across multiple runner replicas serving the same model, with circuit breaking to handle unhealthy runners.

**Weighted round-robin:**

- When a model has multiple runner endpoints in the routing map, distribute requests across them according to configured weights
- Weights are set by the control plane in the routing map (e.g., for canary deployments or capacity-based distribution)
- Default to equal weights when not specified

**Circuit breaker** (per runner endpoint):

- States: `CLOSED` (healthy) → `OPEN` (tripped) → `HALF_OPEN` (testing recovery)
- Trips after a configurable number of consecutive failures (default: 5) or failure rate threshold
- In `OPEN` state, requests skip this endpoint and are routed to healthy replicas
- After a configurable backoff period, transitions to `HALF_OPEN` and allows a single probe request
- If the probe succeeds, transitions back to `CLOSED`; if it fails, returns to `OPEN`
- If all endpoints for a model are in `OPEN` state, return 503

**Hop-by-hop header filtering:** Both request and response directions strip hop-by-hop headers (`connection`, `keep-alive`, `transfer-encoding`, `te`, `trailer`, `upgrade`, `proxy-authorization`, `proxy-authenticate`) to avoid leaking per-hop transport metadata across the proxy boundary.

**Verification:** Unit tests for the round-robin algorithm and circuit breaker state machine.

### 1.8 — Implement Health and Metrics

**Depends on:** Task 1.4

Observability endpoints and Prometheus metrics.

**Health endpoints** (on the main listen port):

| Endpoint   | Purpose                                                                           |
| ---------- | --------------------------------------------------------------------------------- |
| `/healthz` | Liveness probe — returns 200 if the process is running                            |
| `/readyz`  | Readiness probe — returns 200 if Redis is connected and the routing map is loaded |

**Prometheus metrics** (on `/metrics`):

| Metric                                    | Type      | Description                                                        |
| ----------------------------------------- | --------- | ------------------------------------------------------------------ |
| `sardeenz_proxy_requests_total`           | Counter   | Total requests, labeled by model, endpoint, status code            |
| `sardeenz_proxy_request_duration_seconds` | Histogram | Request latency (excluding parking wait time)                      |
| `sardeenz_proxy_active_connections`       | Gauge     | Currently active forwarded connections                             |
| `sardeenz_proxy_parked_connections`       | Gauge     | Currently parked connections, labeled by model                     |
| `sardeenz_proxy_wake_triggers_total`      | Counter   | Wake triggers sent to the control plane                            |
| `sardeenz_proxy_parking_duration_seconds` | Histogram | Time spent parked before forwarding                                |
| `sardeenz_proxy_circuit_breaker_state`    | Gauge     | Circuit breaker state per endpoint (0=closed, 1=open, 2=half-open) |

**Structured logging** — all log lines are JSON with fields for request ID, model name, duration, and outcome. Errors include the full causal chain.

**Verification:** `curl /healthz`, `curl /readyz`, `curl /metrics` return expected formats.

### 1.9 — Structured Output Compatibility

**Depends on:** Task 1.1

Research how structured output (JSON mode, tool calling, function calling) behaves across different engine versions and document the proxy's approach.

**Problem:** Different engine versions (e.g., vLLM 0.19 vs. 0.20) may support different structured output features or implement them with subtle differences. The proxy needs a strategy for handling this — whether to pass through transparently, validate schemas, or transform requests/responses.

**Deliverable:** A documented approach covering:

- Which structured output features the proxy passes through transparently
- Whether the proxy needs to inspect or transform structured output parameters
- How the `/v1/models` endpoint communicates what structured output features each model supports
- Compatibility matrix for known engine versions
- Recommendations for the control plane (Phase 2) on how to surface structured output capabilities

This may produce a standalone document or a section in the proxy design document (Task 1.10), depending on the complexity of the findings.

### 1.10 — Write Proxy Design Document

**Depends on:** Tasks 1.5, 1.6, 1.7, 1.8

Narrative companion to the code at `docs/architecture/components/proxy.md`. Explains the _why_ and _how_ for operators and future contributors.

Covers:

- **Request flow** — step-by-step walkthrough of the hot path with a sequence diagram
- **Connection parking protocol** — how parking works, timeout behavior, backpressure
- **Thundering herd prevention** — deduplication mechanism with a concurrency diagram
- **Routing map schema** — Redis key structure, data format, refresh strategy
- **Circuit breaker behavior** — states, thresholds, recovery, and what happens when all endpoints are open
- **Configuration reference** — all environment variables and their defaults
- **Metrics reference** — all Prometheus metrics with descriptions
- **Performance characteristics** — expected overhead, connection limits, memory usage under load
- **Relationship to the control plane** — what the proxy reads vs. writes, the wake trigger contract

### 1.11 — Build Container Image

**Depends on:** Task 1.8

Multi-stage Docker build at `proxy/Dockerfile`.

**Build stage:** Rust toolchain, compile the proxy in release mode with static linking (musl target for a minimal runtime image).

**Runtime stage:** Distroless or `scratch`-based image containing only the proxy binary.

**Image requirements:**

- Final image size under 50 MB
- No shell, no package manager, no unnecessary system libraries
- Runs as a non-root user
- Exposes the configured listen port
- Health check instruction using `/healthz`

**Build:** `docker build -t sardeenz-proxy ./proxy` from the repo root.

**Verification:** Build succeeds in CI. Container starts and responds to health checks.

### 1.12 — Integration Test Suite

**Depends on:** Tasks 1.5, 1.6, 1.7, 1.8

Integration tests that validate all four request flow scenarios from the [architecture overview](../architecture/overview.md#request-flows). Tests run against a real Redis/Valkey instance (no mocks for data stores, per the [overall plan](overall-plan.md#testing-strategy)).

**Test infrastructure:**

- A mock runner HTTP server that implements enough of the OpenAI protocol to serve test requests (both streaming and non-streaming)
- A mock control plane that implements the wake trigger endpoint
- A Redis/Valkey instance (via test container or local instance)
- The proxy binary under test

**Test scenarios:**

| #   | Scenario                | What it validates                                                                        |
| --- | ----------------------- | ---------------------------------------------------------------------------------------- |
| 1   | Active model request    | Proxy routes to runner, response returns correctly (streaming + non-streaming)           |
| 2   | Sleeping model request  | Proxy parks → fires wake trigger → model wakes → request forwarded → response returns    |
| 3   | Thundering herd         | 100 concurrent requests to sleeping model → exactly 1 wake trigger → all requests served |
| 4   | Eviction during request | Model transitions while request is in flight — proxy handles gracefully                  |
| 5   | Circuit breaker         | Runner fails → circuit opens → requests routed to healthy replica → circuit recovers     |
| 6   | Client disconnect       | Client disconnects mid-stream → upstream request canceled, no resource leak              |
| 7   | Unknown model           | Request for non-existent model → 404                                                     |
| 8   | Parking timeout         | Model doesn't wake within timeout → 503 to parked clients                                |

**Redis integration tests** (feature-gated behind `redis-integration`):

Tests that exercise the real Redis/Valkey sync path are in `proxy/tests/integration/test_redis.rs`, gated by the `redis-integration` Cargo feature flag so that `cargo test` works without a running Redis instance. Each test uses a UUID-scoped key prefix for isolation, enabling parallel execution.

| #   | Scenario                | What it validates                                                               |
| --- | ----------------------- | ------------------------------------------------------------------------------- |
| 9   | Redis bootstrap         | Proxy loads routing map from Redis on startup and forwards requests             |
| 10  | Pub/sub refresh         | Proxy picks up new routes published to Redis after startup                      |
| 11  | Malformed entry         | Valid entries route correctly; malformed JSON entries are silently skipped       |
| 12  | Readiness lifecycle     | `/readyz` transitions from 503 → 200 as Redis connects and routing map loads   |

Run with: `cargo test --features redis-integration test_redis`

**Verification:** `cargo test --test integration` passes. `cargo test --features redis-integration` passes with a running Redis/Valkey instance. Tests run in CI.

## Definition of Done

From the [overall project plan](overall-plan.md#phase-1-rust-proxy-with-connection-parking):

- [ ] Proxy routes requests to active models with < 1ms overhead (p99, excluding network transit)
- [ ] Connection parking works end-to-end: client sends request → proxy parks → model wakes → client receives response, with no client-side retry needed
- [ ] Thundering herd: 100 concurrent requests to the same sleeping model produce exactly 1 wake trigger
- [ ] Circuit breaker trips after configurable failure threshold and recovers after backoff
- [ ] All four request flows from the architecture overview pass integration tests
- [ ] Structured output compatibility approach documented and validated
- [ ] Container image builds and runs in CI
- [ ] Prometheus metrics endpoint exposes: request count, latency histogram, active connections, parked connections, circuit breaker state
- [ ] OpenAPI spec passes `redocly lint` with zero errors
- [ ] Generated Rust types compile cleanly (`cargo check`)
- [ ] Generated TypeScript types compile cleanly (`make typecheck`)
- [ ] `cargo clippy -- -D warnings` passes with zero warnings

## Open Questions

- **Routing map cache strategy:** Should the proxy cache the routing map in-memory and refresh via pub/sub, or read from Redis on every request? In-memory cache with pub/sub gives lower latency but requires careful invalidation. Read-per-request is simpler but adds ~0.1ms per request. _Leaning toward:_ in-memory cache with pub/sub refresh — the proxy is on the hot path and sub-millisecond overhead matters.
- **Rust codegen approach:** ~~Should we use `openapi-generator` to generate Rust structs from the spec, or hand-write structs and validate them against the spec in CI?~~ _Decided:_ hand-maintained structs. Codegen output was verbose and non-idiomatic; the type surface is small (~260 lines) and benefits from manual serde attribute control. Drift risk is accepted and mitigated by keeping types in a clearly labeled `generated/` directory with spec source references in each file header.
- **Parking connection limit:** What should the default maximum parked connections be (per model and globally)? Too low and legitimate traffic gets rejected during wake-up; too high and a sleeping model with heavy traffic exhausts proxy memory. _Leaning toward:_ 1,000 per model, 10,000 global, configurable.
- **Metrics port separation:** Should Prometheus metrics be served on the same port as the proxy traffic, or on a separate admin port? Same port is simpler; separate port keeps metrics traffic off the hot path and allows different access controls. _Leaning toward:_ separate admin port for metrics and health.
- **Structured output passthrough vs. inspection:** Can the proxy treat structured output parameters as opaque (pure passthrough), or does it need to inspect them for routing or compatibility decisions? _Leaning toward:_ pure passthrough initially — the proxy shouldn't need to understand request semantics beyond model routing.

## Dependencies

- **Phase 0 outputs** — runner contract spec for model state definitions (`RunnerState` enum) and health check schemas
- **Redis/Valkey instance** — required for routing map storage and pub/sub
- **Rust toolchain** — Rust 1.82+, cargo, clippy (see [setup guide](../development/setup.md))
- **v1 repo access** — for studying proxy patterns in Task 1.1

## Risks

| Risk                                                   | Impact                                                          | Mitigation                                                                                             |
| ------------------------------------------------------ | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Connection parking memory under sustained load         | High parked connection count could exhaust proxy memory         | Configurable per-model and global limits with 503 backpressure; load test with 10K+ parked connections |
| SSE streaming edge cases                               | Partial frames, client disconnects mid-stream, buffering issues | Comprehensive integration tests with fault injection (Task 1.12 scenarios 4 and 6)                     |
| Structured output compatibility across engine versions | Proxy may need to transform or validate response schemas        | Research early (Task 1.9) before committing to a passthrough approach                                  |
| Redis/Valkey latency or unavailability                 | Proxy cannot route if Redis is down                             | In-memory routing map cache survives brief Redis outages; readiness probe reflects Redis health        |
| Rust learning curve                                    | Slower delivery if contributors are new to Rust                 | Proxy has a narrow, well-defined scope; start with the scaffold (Task 1.4) to build familiarity        |
| Cross-language codegen quality                         | Generated Rust types may be verbose or non-idiomatic            | Evaluate during Task 1.3; fall back to hand-written structs if generation output is poor               |

## References

- [Overall project plan](overall-plan.md) — Phase 1 deliverables and definition of done
- [Architecture overview](../architecture/overview.md) — system design, request flows, routing proxy role
- [ADR-003: Rust proxy](../architecture/adrs/adr-003-rust-proxy.md) — Rust choice rationale
- [ADR-005: OpenAPI contracts](../architecture/adrs/adr-005-openapi-contracts.md) — cross-language contract strategy
- [ADR-009: State and persistence](../architecture/adrs/adr-009-state-and-persistence.md) — Redis/Valkey for routing map, data store split
- [Runner contract spec](../../packages/contracts/specs/engine-runner.yaml) — model states and health schemas (Phase 0 output)
- [Runner contract design doc](../architecture/components/runner-contract.md) — state model, communication patterns (Phase 0 output)
- [Coding standards](../development/coding-standards.md) — Rust and OpenAPI conventions
- [Sardeenz v1](https://github.com/rh-aiservices-bu/sardeenz) — reference implementation for proxy patterns
