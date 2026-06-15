# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Dashboard frontend scaffold — Vite + React 18 + PatternFly 6 + React Router + TanStack Query
  with app shell (masthead, sidebar nav, page routing), placeholder pages for all 7 views
  (cluster overview, models, workers, metrics), Vitest config, and TypeScript strict mode
- Dashboard backend-for-frontend (BFF) scaffold — Fastify service with control plane API proxy
  routes, Redis/Prometheus client stubs, health probes (`/healthz`, `/readyz`), structured
  logging, error handling, and graceful shutdown; follows control plane patterns
- v1 component inventory and mapping document (`docs/project/v1-component-mapping.md`) — catalogs
  all reusable components from the v1 dashboard with port verdicts, data model mapping
  (v1 types → v2 `@sardeenz/types`), and state color mapping
- Phase 3 project plan (`docs/project/phase3.md`) — 15-task breakdown for the admin
  dashboard with v1 component reuse-first approach: inventory and port v1 UI components,
  frontend (React + PatternFly 6 + Vite), backend-for-frontend (Fastify BFF), device memory
  visualization, metrics dashboard, Playwright E2E tests, and container images
- Proxy writes per-model inference timestamps to Redis (`SET {prefix}:inference:last:{model}`)
  on each routed request, with a 5-second local debounce to minimize overhead. Gives the
  control plane's LRU eviction engine a real recency signal (ADR-014, #39)
- Document worker agent / runner / engine three-layer process architecture in
  `docs/architecture/overview.md` — process tree, communication channels, and
  Lmod environment isolation rationale (#31)

### Changed

- Phase 2 (control plane sleep/wake orchestration) marked complete — 18/18 tasks done,
  128 unit tests + 7 integration tests passing

### Fixed

- LRU eviction now reads per-model inference timestamps from Redis (`{prefix}:inference:last:{model}`)
  written by the proxy, giving the eviction engine a real recency signal instead of random
  ordering. See ADR-014 for the design decision (#37)
- Control plane Dockerfile COPY instructions no longer use invalid shell redirection
  (`2>/dev/null || true`); optional workspace-local `node_modules` dirs are guaranteed to
  exist via `mkdir -p` in the deps stage so plain COPY always succeeds (#33)
- Placement pipeline now excludes DEGRADED and OFFLINE workers as the first filter stage,
  preventing unhealthy workers from being selected for model placement (#35)
- Readiness probe (`/readyz`) now returns 503 for follower instances when leader election
  is enabled, ensuring Kubernetes endpoints exclude followers from orchestration traffic
  (closes #36)
- `MemoryBudgetService.refreshAll()` and `refreshWorkerBudget()` no longer clear all
  in-flight reservations on every reconciliation tick. Reservations are now cleared
  per-device only when the worker's fresh memory report shows `usedBytes >= reservedBytes`,
  meaning the allocation has been accounted for. Reservations for in-flight deploys (runner
  starting, worker not yet reporting) are preserved, closing the overcommit window that
  allowed double-placement onto the same capacity (closes #34).
- Internal wake route (`POST /api/v1/wake`) now enforces leader gate and atomically
  claims `SLEEPING → STARTING` via CAS before launching background work, preventing
  thundering herd from concurrent proxy wake triggers and follower-instance wake
  processing (#32)
- Deployment security documentation (`docs/usage/deployment-security.md`) documenting the
  network isolation requirement for Phase 2 (no auth until a later phase)
- Readiness probe (`/readyz`) now reports leader-election status in the response
- Prometheus gauge metrics (`modelsTotal`, `workersTotal`, `deviceMemoryBytes`) are now
  populated with real values on every reconciliation tick instead of remaining at zero
- Leader-election lease operations now use Kubernetes `resourceVersion` for optimistic
  concurrency, preventing split-brain from concurrent lease updates; 409 conflicts are
  detected explicitly
- Kubernetes service account token loading uses ESM-compatible `readFileSync` import
  instead of `require('node:fs')`
- `stopModel()` now handles all lifecycle states correctly — PENDING and STARTING
  route through ERROR before reaching STOPPED instead of attempting invalid transitions
- Wake and sleep routes atomically claim their transitional state (STARTING / DRAINING)
  before launching background work, preventing concurrent request races
- Eviction engine now wired into deploy and wake flows: insufficient capacity triggers
  LRU eviction of idle models before failing with placement error
- Eviction candidates now use actual `requiredMemory` from model metadata instead of
  hardcoded zero bytes, fixing freed-capacity accounting
- Memory-budget staleness now uses worker-reported `reportedAt` timestamp instead of
  control-plane read-time, making staleness detection accurate for batched/delayed reports
- In-flight memory reservations are cleared on budget refresh (`refreshAll` and
  `refreshWorkerBudget`), preventing phantom reservations from accumulating after model
  stop/delete/failure

### Added

- Integration test infrastructure for control plane (`control-plane/src/__tests__/integration/`):
  test harness wiring real Redis (DB 1) and PostgreSQL with per-test key prefixes, in-process
  mock runner and worker Fastify servers, `canConnect()` skip guard, and dedicated vitest config
  (`vitest.integration.config.ts`). Three test suites: deploy orchestration (happy path +
  timeout), sleep/wake round-trip with CAS thundering-herd prevention, and worker discovery
  with routing map consistency across deploy/sleep/wake lifecycle (#38)
- PostgreSQL service added to `compose.yaml` for integration test and local dev use
- Control plane reconciliation loop (`control-plane/src/services/reconciliation.ts`):
  `ReconciliationService` runs a leader-only background loop (default 30s interval) that
  re-discovers workers, checks heartbeats, cleans up dead workers (transitions their models
  to ERROR and removes routing), refreshes memory budgets, and recovers models stuck in
  transitional states past their timeout. Detects leader promotion for full state rebuild.
  Includes Prometheus metrics for tick count, duration, dead workers, stuck models, and
  per-step errors.
- Control plane core services (`control-plane/src/services/`):
  - `ModelRepository`: PostgreSQL CRUD for model configuration
  - `ModelLifecycleService`: Redis-backed state machine with atomic CAS transitions via Lua scripts
  - `MemoryBudgetService`: in-memory VRAM budget tracker with per-device reservations and staleness detection
  - `WorkerPoolService`: Redis SCAN-based worker discovery with three-tier heartbeat status (ONLINE/DEGRADED/OFFLINE)
  - `RoutingMapService`: Redis hash-backed routing map with atomic MULTI/EXEC writes and pub/sub notifications
  - `PlacementPipeline`: four-stage workload placement (runner type → hardware → capacity → strategy)
  - `EvictionEngine`: LRU eviction with circuit breaker, max-per-cycle limit, pinned model exclusion, minimum active time
  - `SleepWakeService`: sleep/wake coordination driving ACTIVE→DRAINING→SLEEPING and SLEEPING→STARTING→ACTIVE transitions
  - `LeaderElectionService`: K8s Lease API leader election with local dev mode fallback
- Control plane database migrations (`control-plane/migrations/001-initial-schema.sql`):
  models, memory_profiles, benchmarks, and settings tables with migration runner
- Control plane deploy orchestration (`control-plane/src/services/deploy-orchestration.ts`):
  `DeployOrchestrationService` drives models from STARTING → ACTIVE by calling the worker
  management API to start a runner, polling runner health until READY, registering the
  endpoint in the routing map, and transitioning to ACTIVE (with ERROR fallback and
  capacity reservation release on failure)
- Control plane HTTP clients (`control-plane/src/clients/`):
  runner HTTP client wrapping engine runner contract endpoints, worker management HTTP
  client for starting/stopping runners on workers, SQL migration runner
- Control plane HTTP route handlers (`control-plane/src/routes/`):
  model CRUD (deploy/list/get/delete/sleep/wake), worker list/get, cluster status/memory,
  SSE event stream, internal proxy wake trigger and routing map read endpoints
- Full service wiring in control plane entry point: all services instantiated,
  leader election started, worker discovery and memory budget refresh on startup
- Control plane container image (`containers/control-plane/Dockerfile`):
  multi-stage build (deps → build → runtime), non-root user, Node.js 22 slim base
- Control plane test suite (54 tests): config loading and URL redaction, error hierarchy
  serialization, state machine transition validation (16 valid + 8 invalid transitions),
  placement pipeline (runner type/hardware/capacity/TP filtering, spread strategy, stale budget
  rejection), LRU eviction engine (ordering, pinned exclusion, min-active-time, max-per-cycle,
  circuit breaker)
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

- SSE event stream now creates per-connection Redis subscriber via `subscriber.duplicate()` and calls `reply.hijack()` before writing to raw socket — prevents cross-client message leaks and Fastify warnings
- Model deploy endpoint now rolls back DB record and Redis state on placement failure, validates request body types at runtime, and catches PostgreSQL unique constraint violations for race-safe duplicate detection
- Database migrations now execute at startup (were imported but never called)
- State transition metric (`stateTransitionsTotal`) now labels `from` correctly — Lua script returns `currentState|encoded` instead of only the new state
- `ModelLifecycleService.getAllStates()` and `MemoryBudgetService.refreshAll()` now use SCAN instead of `KEYS *` to avoid blocking Redis in production
- `WorkerPoolService.infoScanPattern()` now uses configurable `keyPrefix` instead of hardcoded namespace
- `updateLastInference` now uses atomic Lua script instead of non-atomic GET-then-SET, preventing state clobber on concurrent transitions
- `createModel` now uses `SET NX` for atomic existence check, preventing TOCTOU race on duplicate model creation
- `RoutingMapService.addEndpoint/removeEndpoint/updateEndpointHealth` now use Lua scripts for atomic read-modify-write, preventing concurrent endpoint list corruption
- K8s service account token now re-reads from disk every 60s instead of caching forever, preventing auth failures after projected token rotation
- Internal `/api/v1/wake` response now includes required `accepted` field and uses `currentState` field per proxy-control-plane spec contract
- `delay()` helper in sleep-wake service now cleans up abort listener when timer fires normally, preventing listener accumulation during long polling loops
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
