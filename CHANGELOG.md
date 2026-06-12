# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Control plane admin API OpenAPI spec (`packages/contracts/specs/control-plane.yaml`):
  model lifecycle CRUD (deploy/sleep/wake/delete), worker management, cluster state/memory,
  SSE events stream, `ModelLifecycleState` enum (8 states), `WorkerStatus` and `ClusterEventType` enums
- Generated TypeScript types from control plane spec (`packages/types/src/generated/control-plane.ts`)
- Control plane Fastify scaffold (`control-plane/src/`): config from env vars, typed error hierarchy
  (`ControlPlaneError` with error codes), Redis/PostgreSQL/runner HTTP clients, Prometheus metrics
  (13 metrics: models, workers, memory, placement, eviction, sleep/wake, state transitions, leader),
  health probes (`/healthz`, `/readyz`), structured JSON logging, graceful shutdown
- Phase 2 project plan (`docs/project/phase2.md`): detailed task breakdown for control plane sleep/wake orchestration — 18 tasks covering OpenAPI specs, Fastify scaffold, PostgreSQL schema, model lifecycle state machine, placement pipeline, LRU eviction, sleep/wake coordination, routing map management, worker pool, leader election, health/metrics, container image, and integration tests
- Backward-compatibility policy in ADR-005: semver rules for pre-1.0 specs, breaking vs. non-breaking change definitions, simultaneous rollout guarantee, version mismatch detection via startup logging (#13)
- Runner BUSY state routing mapping in runner contract docs: BUSY sets endpoint weight to 0 (model stays ACTIVE, endpoint stays healthy), full RunnerState-to-ModelState mapping table (#14)
- ADR-013: Secrets management policy — env-var sourcing, naming convention with greppable suffixes, log sanitization rules, reference to proxy's `redact_url()` pattern (#21)

### Changed

- Adopted `dev`/`main` branching strategy: `dev` is the integration branch, `main` is releases only

### Fixed

- OpenAPI validation script now fails on lint errors instead of silently swallowing them (#1)
- Readiness probe now requires both Redis connection AND successful routing map load (#4)
- Response hop-by-hop headers now filtered symmetrically with request-side filtering (#9)

### Added

- Redis integration tests behind `redis-integration` feature flag (#5):
  `test_redis_bootstrap`, `test_redis_pubsub_refresh`, `test_redis_malformed_entry`,
  `test_redis_readiness_lifecycle` — each uses UUID-scoped key prefix for isolation
- Configurable Redis key prefix (`SARDEENZ_REDIS_KEY_PREFIX`, default `sardeenz`) for test isolation (#5)
- Request-level tracing with request ID correlation (#6): generates or propagates
  `X-Request-ID` header, structured JSON log per request (method, path, status, latency)
- Prometheus metric recording at all proxy call sites (#3):
  - `sardeenz_proxy_requests_total` (counter with status label)
  - `sardeenz_proxy_request_duration_seconds` (histogram)
  - `sardeenz_proxy_active_connections` (gauge)
  - `sardeenz_proxy_parked_connections` (gauge with model label)
  - `sardeenz_proxy_wake_triggers_total` (counter with result label)
  - `sardeenz_proxy_parking_duration_seconds` (histogram)
  - `sardeenz_proxy_circuit_breaker_state` (gauge with endpoint label)

### Changed

- Rust types in `proxy/src/generated/` now documented as hand-maintained (not auto-generated) (#2)
- Updated ADR-005, architecture overview, and Phase 1 docs to reflect actual Rust type workflow
- Extracted `ProxyError::status_code()` method for metrics and reuse (#3)
- Added Security and Trust Model section to proxy architecture docs (#7, #18, #20)
- Added configurable upstream request timeout (`SARDEENZ_UPSTREAM_TIMEOUT_SECS`, default 300s) (#8)
- Updated Phase 1 docs with upstream timeout, Redis key prefix, hop-by-hop filtering, and Redis integration test details
- Updated CLAUDE.md to clarify Rust types are hand-maintained (not generated)
- Added `SARDEENZ_REDIS_KEY_PREFIX` to proxy configuration reference table
- Default proxy admin port from 9090 to 9099 to avoid conflict with Cockpit on Fedora/RHEL
- Suppress Redocly `no-unused-components` warning for `RoutingMapUpdate` schema (reserved for Phase 2 pub/sub)

### Added

- `/implement` skill (`.claude/skills/implement.md`): full quality development process
  for phases and features — plan, implement, cross-model review/fix loop, verify
- Project scaffolding: monorepo structure, architecture docs, ADRs
- Development tooling: TypeScript, ESLint, Prettier, Vitest, Redocly
- OpenAPI contract workflow with codegen pipeline
- Build infrastructure: Makefile, npm workspaces, tsconfig project references
- README index in every `docs/` directory for GitHub navigation
- Documentation rule: every Markdown file must be linked from its parent README
- Comprehensive project plan with deliverables, definitions of done, risks, and dependencies for all five phases
- CLAUDE.md: project status, workflow rules (CHANGELOG, npm, commit hygiene)
- Phase 0 planning document with task breakdown, scope, and open questions
- Engine runner contract OpenAPI spec (`packages/contracts/specs/engine-runner.yaml`):
  7 endpoints across 5 interface areas (health, memory, sleep/wake, progress, capabilities),
  5-state runner model (STARTING, READY, BUSY, SLEEPING, ERROR), per-device memory reporting,
  extensible sleep levels, structured loading progress, capability declaration for placement
- Generated TypeScript types from runner contract (`packages/types/src/generated/engine-runner.ts`)
- Runner contract design document (`docs/architecture/components/runner-contract.md`):
  state model with Mermaid diagram, communication patterns, scenario validation (vLLM/Triton/MLServer)
- Architecture components directory (`docs/architecture/components/`)
- Phase 1 planning document with 12-task breakdown for the Rust proxy (`docs/project/phase1.md`)
- Podman Compose dev environment (`compose.yaml`) with Valkey 8 for Redis-compatible state store
- Makefile targets `services` and `services-stop` for dev service lifecycle
- Proxy ↔ control plane OpenAPI spec (`packages/contracts/specs/proxy-control-plane.yaml`):
  wake trigger API (`POST /api/v1/wake`), routing map bootstrap (`GET /api/v1/routing-map`),
  routing map schema (Redis hash at `sardeenz:routing-map` with pub/sub on `sardeenz:routing-updates`),
  5-state model routing model (ACTIVE, SLEEPING, STARTING, DRAINING, ERROR)
- Generated TypeScript types from proxy-control-plane spec
  (`packages/types/src/generated/proxy-control-plane.ts`)
- Hand-written Rust types matching both OpenAPI specs (`proxy/src/generated/`):
  engine runner types and proxy-control-plane types with serde derives
- Rust routing proxy implementation (`proxy/src/`):
  - axum-based HTTP server with separate proxy (8080) and admin (9099) ports
  - Request routing via in-memory routing map cache refreshed by Redis pub/sub
  - OpenAI-compatible endpoints: `/v1/chat/completions`, `/v1/completions`, `/v1/models`
  - Connection parking with configurable timeout (default 120s) and backpressure limits
  - Thundering herd prevention: first request fires wake trigger, subsequent requests park
  - Weighted round-robin load balancing across runner replicas
  - Per-endpoint circuit breaker (configurable failure threshold, window, recovery timeout)
  - Prometheus metrics endpoint on admin port (`/metrics`)
  - Health endpoints (`/healthz`, `/readyz`) on admin port
  - Structured JSON logging via tracing-subscriber
  - Graceful shutdown on SIGTERM/SIGINT
- Structured output compatibility research document
  (`docs/architecture/components/structured-output-compatibility.md`):
  vLLM version compatibility matrix, proxy passthrough recommendation
- Multi-stage Dockerfile for the routing proxy (`proxy/Dockerfile`):
  musl static build, distroless runtime, non-root user, health check
- `.dockerignore` for the proxy (`proxy/.dockerignore`)
- Routing proxy design document (`docs/architecture/components/proxy.md`):
  request flow with Mermaid sequence diagrams (active/sleeping/multi-replica), connection parking
  protocol (thundering herd prevention, timeout/backpressure limits), routing map Redis key
  structure and refresh strategy, circuit breaker state machine, full configuration and metrics
  reference tables, health endpoint semantics, proxy ↔ control plane responsibility split
- Integration test suite for the Rust proxy (`proxy/tests/integration/`):
  26 tests across 13 scenarios exercising request forwarding, SSE streaming, sleep/wake cycle,
  thundering herd deduplication, unknown model 404, missing/invalid model 400, parking timeout 503,
  parking limit enforcement (per-model and global), wake trigger failure, draining/error model
  states, circuit breaker trip/recovery/5xx, weighted round-robin, `/v1/models` aggregation,
  and health/readyz endpoints; runs without Redis using direct RoutingMapCache injection;
  mock axum servers for runner and control plane
- Shared handler module (`proxy/src/handlers.rs`) — handler functions extracted from binary
  crate for reuse by both production `main.rs` and integration tests

### Fixed

- Proxy: missing/invalid `model` field now returns HTTP 400 (`invalid_request_error`)
  instead of 500; invalid JSON body returns 400 instead of 500
- Proxy: `RoutingEntryMetadata` preserves unknown fields via `serde(flatten)` to match
  OpenAPI `additionalProperties` contract
- Proxy: `ForwardingClient` eliminates double-buffering — accepts `Bytes` directly,
  preserves query string via `path_and_query()`, filters hop-by-hop headers
- Proxy: circuit breaker HalfOpen state limits to single probe request (prevents
  stampede); `record_failure()` in HalfOpen immediately re-opens circuit;
  `current_state()` is now read-only (no side effects)
- Proxy: weighted round-robin balancer uses cumulative weight algorithm — O(n),
  zero heap allocation, weight capped at 100
- Proxy: parking manager cleans up `pending_wakes` on timeout exit path (prevents
  permanent stuck state); `reserve_slot()` atomically checks+increments under
  single mutex (TOCTOU fix); uses `SeqCst` ordering throughout
- Proxy: Redis sync subscribes to pub/sub channel before initial `HGETALL` to
  avoid missing updates during the load window
- Proxy: `redis_connected` flag uses `Acquire`/`Release` ordering instead of `Relaxed`
- Proxy: graceful shutdown uses `watch::channel` for coordinated signal to both
  servers and Redis sync task; proper drain sequence (signal → join servers → await Redis)
- Proxy: Redis URL credentials redacted in startup log output

### Changed

- CLAUDE.md project status now links directly to phase0.md for current work
- Aligned runner contract spec filename to `engine-runner.yaml` across all docs
- `packages/types/src/index.ts` re-exports generated engine runner types and enums
- `packages/types/package.json` codegen script now generates from engine-runner.yaml
- `packages/contracts/redocly.yaml` disables rules inappropriate for internal contracts
  (no-empty-servers, security-defined, info-license)
