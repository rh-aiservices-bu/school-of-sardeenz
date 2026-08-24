# Proxy — CLAUDE.md

Stateless Rust (axum/tokio) routing proxy for OpenAI-compatible inference requests. Handles model resolution, connection parking for sleeping models, and request forwarding with circuit breaking.

**Design doc:** [`docs/architecture/components/proxy.md`](../docs/architecture/components/proxy.md) — request flow diagrams, parking protocol, configuration and metrics reference tables.
**Phase plan:** [`docs/project/phase1.md`](../docs/project/phase1.md) — task breakdown, scope, decisions.

## Module Map

| Module              | Path                       | Role                                                                 |
| ------------------- | -------------------------- | -------------------------------------------------------------------- |
| `config`            | `src/config.rs`            | Configuration from env vars (`Config::from_env()`)                   |
| `error`             | `src/error.rs`             | `ProxyError` enum with HTTP status code mappings                     |
| `forwarding`        | `src/forwarding/`          | `ForwardingClient`, `CircuitBreaker`, `WeightedRoundRobin`           |
| `generated`         | `src/generated/`           | Hand-maintained Rust types mirroring OpenAPI specs                   |
| `handlers`          | `src/handlers.rs`          | Inference handlers + `/metrics` endpoint                             |
| `health`            | `src/health/`              | `/healthz`, `/readyz`, Prometheus metric descriptions                |
| `inference_tracker` | `src/inference_tracker.rs` | Per-model inference timestamps to Redis (debounced, fire-and-forget) |
| `parking`           | `src/parking/`             | `ParkingManager`, `WakeTriggerClient`, thundering herd prevention    |
| `protocol`          | `src/protocol/`            | Request parsing (model extraction), OpenAI response building         |
| `routing`           | `src/routing/`             | `RoutingMapCache` (watch-based), `ModelResolver`                     |
| `state`             | `src/state/`               | `AppState` (shared state), `start_redis_sync` (Redis loop)           |

## Key Types

| Type                 | Module              | Role                                                                     |
| -------------------- | ------------------- | ------------------------------------------------------------------------ |
| `AppState`           | `state`             | Shared across handlers: config, caches, managers, metrics handle         |
| `Config`             | `config`            | All env-var configuration (see table below)                              |
| `ProxyError`         | `error`             | Error variants → HTTP status codes via `IntoResponse`                    |
| `Resolution`         | `routing`           | Enum: `Active` / `Sleeping` / `Starting` — drives parking vs. forwarding |
| `RoutingMapCache`    | `routing`           | In-memory model→entry map with `tokio::sync::watch` notifications        |
| `ParkingManager`     | `parking`           | Parks requests, enforces limits, fires wake triggers                     |
| `CircuitBreaker`     | `forwarding`        | Per-endpoint Closed/Open/HalfOpen state machine                          |
| `ForwardingClient`   | `forwarding`        | reqwest-based HTTP forwarder with hop-by-hop header filtering            |
| `WeightedRoundRobin` | `forwarding`        | Endpoint selection by cumulative weight                                  |
| `InferenceTracker`   | `inference_tracker` | Debounced per-model timestamp writes to Redis for LRU eviction           |

## Hand-Maintained Types

`src/generated/` contains Rust structs mirroring the OpenAPI specs in `packages/contracts/specs/`. These are **not auto-generated** — they are hand-written with serde derives. When the OpenAPI specs change, update these files manually.

- `proxy_control_plane.rs` ← `proxy-control-plane.yaml` (RoutingEntry, ModelState, RunnerEndpoint, WakeTriggerRequest/Response)
- `engine_runner.rs` ← `engine-runner.yaml` (RunnerState, MemoryInfo, etc.)

Rationale: [ADR-005](../docs/architecture/adrs/adr-005-openapi-contracts.md)

## Request Flow (Hot Path)

1. Extract `model` from JSON body (`protocol`)
2. Resolve model state from routing cache (`routing`) → `Resolution::Active` / `Sleeping` / `Starting`
3. If sleeping/starting: park connection, fire wake trigger if first request (`parking`)
4. Pick endpoint via circuit breaker + weighted round-robin (`forwarding`)
5. Forward request, stream response back to client (`forwarding`)
6. On success: fire-and-forget debounced inference timestamp to Redis (`inference_tracker`)

## Test Infrastructure

### Standard integration tests (`tests/integration/`)

No Redis required. Routing data injected directly into `RoutingMapCache`.

| Helper             | File                           | Purpose                                                  |
| ------------------ | ------------------------------ | -------------------------------------------------------- |
| `TestProxy`        | `common/proxy_builder.rs`      | Spawns proxy + admin servers on random ports             |
| `MockRunner`       | `common/mock_runner.rs`        | Mock OpenAI-compatible runner with request counting      |
| `MockControlPlane` | `common/mock_control_plane.rs` | Mock wake trigger endpoint, auto-transition to Active    |
| Routing helpers    | `common/routing.rs`            | `insert_active_model()`, `insert_sleeping_model()`, etc. |

### Redis integration tests (`tests/integration/test_redis.rs`)

Gated behind `redis-integration` Cargo feature flag. Requires a running Redis/Valkey instance.

- `RedisTestHarness` — connects to Redis, uses UUID-scoped key prefix per test for isolation
- Env var `REDIS_TEST_URL` overrides the default `redis://127.0.0.1:6379`

## Build & Test

```bash
cargo check                                    # Type-check
cargo clippy --all-targets -- -D warnings      # Lint
cargo test                                     # All tests (no Redis needed)
cargo test --features redis-integration        # Include Redis tests (needs Redis running)
cargo test --test integration                  # Integration tests only
cargo test --lib                               # Unit tests only
```

## Configuration

All env vars read at startup by `Config::from_env()`.

| Variable                                  | Default                  | Description                                                                 |
| ----------------------------------------- | ------------------------ | --------------------------------------------------------------------------- |
| `SARDEENZ_PROXY_LISTEN_ADDR`              | `0.0.0.0:8080`           | Inference server bind address (falls back to legacy `SARDEENZ_LISTEN_ADDR`) |
| `SARDEENZ_ADMIN_ADDR`                     | `0.0.0.0:9099`           | Admin server (health + metrics)                                             |
| `SARDEENZ_REDIS_URL`                      | `redis://127.0.0.1:6379` | Redis/Valkey connection                                                     |
| `SARDEENZ_CONTROL_PLANE_URL`              | `http://127.0.0.1:3000`  | Control plane for wake triggers                                             |
| `SARDEENZ_LOG_LEVEL`                      | `info`                   | Tracing log level                                                           |
| `SARDEENZ_UPSTREAM_TIMEOUT_SECS`          | `300`                    | Forwarded request timeout                                                   |
| `SARDEENZ_REDIS_KEY_PREFIX`               | `sardeenz`               | Redis key/channel prefix                                                    |
| `SARDEENZ_PARKING_TIMEOUT_SECS`           | `120`                    | Max parking wait before 503                                                 |
| `SARDEENZ_PARKING_MAX_PER_MODEL`          | `1000`                   | Per-model parked connection limit                                           |
| `SARDEENZ_PARKING_MAX_GLOBAL`             | `10000`                  | Global parked connection limit                                              |
| `SARDEENZ_CB_FAILURE_THRESHOLD`           | `5`                      | Failures to trip circuit breaker                                            |
| `SARDEENZ_CB_FAILURE_WINDOW_SECS`         | `30`                     | Circuit breaker failure window                                              |
| `SARDEENZ_CB_RECOVERY_TIMEOUT_SECS`       | `15`                     | Open → HalfOpen transition time                                             |
| `SARDEENZ_PROXY_MAX_CONCURRENT_FORWARDS`  | `0` (unlimited)          | Max concurrently forwarded (in-flight upstream) requests, all models        |
| `SARDEENZ_PROXY_MAX_CONCURRENT_PER_MODEL` | `0` (unlimited)          | Max concurrently forwarded requests, per model                              |

## Conventions

- **Metrics prefix:** all Prometheus metrics use `sardeenz_proxy_` (8 metrics total, see design doc)
- **Admin vs. inference ports:** health, readiness, and metrics are on `SARDEENZ_ADMIN_ADDR`, never on the inference port
- **Readiness:** `/readyz` returns 200 only when `redis_connected AND routing_map_loaded` — both flags required
- **Error types:** all handler errors go through `ProxyError` → `IntoResponse`; use `ProxyError::status_code()` for metrics labels
- **Hop-by-hop headers:** filtered on both request and response sides in `ForwardingClient`
