# Proxy — AGENTS.md

Stateless Rust (axum/tokio) routing proxy for inference requests. Resolves the target model from
the routing map, parks connections while a sleeping model wakes (single wake trigger per model),
and forwards with circuit breaking + weighted round-robin. Paths are split by protocol family:
`/openai/...` (OpenAI-compatible) and `/oip/...` (KServe V2 Open Inference Protocol, ADR-021).

**Design doc:** [`docs/architecture/components/proxy.md`](../docs/architecture/components/proxy.md)
— request flows, parking protocol, full configuration and metrics tables. **Phase plan:**
[`docs/project/phase1.md`](../docs/project/phase1.md).

## Layout

| Path                       | Role                                                             |
| -------------------------- | ---------------------------------------------------------------- |
| `src/config.rs`            | `Config::from_env()` — all `SARDEENZ_*` env vars                 |
| `src/error.rs`             | `ProxyError` → HTTP status via `IntoResponse`                    |
| `src/handlers.rs`          | Inference handlers + `/metrics`                                  |
| `src/routing/`             | `RoutingMapCache` (watch-based) + `ModelResolver` → `Resolution` |
| `src/parking/`             | `ParkingManager`, `WakeTriggerClient`, thundering-herd dedup     |
| `src/forwarding/`          | `ForwardingClient`, `CircuitBreaker`, `WeightedRoundRobin`       |
| `src/protocol/`            | Model extraction per protocol family, response building          |
| `src/inference_tracker.rs` | Debounced per-model inference timestamps to Redis (LRU input)    |
| `src/state/`               | `AppState`, `start_redis_sync` (routing map + pub/sub loop)      |
| `src/health/`              | `/healthz`, `/readyz` on the admin port                          |
| `src/generated/`           | **Hand-maintained** Rust mirrors of the OpenAPI specs (ADR-005)  |

## Rules

- **Contracts:** when `packages/contracts/specs/proxy-control-plane.yaml` or `engine-runner.yaml`
  changes, update `src/generated/*.rs` by hand in the same PR (`RoutingEntry`, `ModelState`,
  `RunnerEndpoint`, `WakeTrigger*`, …). `RoutingEntry.protocol` is required.
- **Ports:** health, readiness, metrics live on `SARDEENZ_ADMIN_ADDR`, never on the inference
  port. `/readyz` is 200 only when Redis is connected **and** the routing map is loaded.
- **Errors:** every handler error goes through `ProxyError`; use `status_code()` for metric labels.
- **Metrics:** all Prometheus names are prefixed `sardeenz_proxy_`.
- **Headers:** hop-by-hop headers are stripped on both request and response in `ForwardingClient`.
- Never add state that must survive a restart — the proxy is stateless by design (ADR-003).

## Build & Test

```bash
cargo check
cargo clippy --all-targets -- -D warnings
cargo test                                 # unit + integration, no Redis needed
cargo test --features redis-integration    # needs Redis; REDIS_TEST_URL overrides the default
```

Integration tests (`tests/integration/`) inject routing data straight into `RoutingMapCache` and
use `TestProxy`, `MockRunner`, `MockControlPlane` from `tests/integration/common/`. Formatting
and lint config: `rustfmt.toml`, `clippy.toml` at the repo root.
