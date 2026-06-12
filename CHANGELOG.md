# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

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
  - axum-based HTTP server with separate proxy (8080) and admin (9090) ports
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
  19 tests across 10 scenarios exercising request forwarding, SSE streaming, sleep/wake cycle,
  thundering herd deduplication, unknown model 404, parking timeout 503, circuit breaker
  trip/recovery, weighted round-robin, `/v1/models` aggregation, and health/readyz endpoints;
  runs without Redis using direct RoutingMapCache injection; mock axum servers for runner
  and control plane

### Fixed

- Proxy circuit breaker now tracks upstream 5xx responses as failures (previously
  only transport-level errors triggered the breaker)

### Changed

- CLAUDE.md project status now links directly to phase0.md for current work
- Aligned runner contract spec filename to `engine-runner.yaml` across all docs
- `packages/types/src/index.ts` re-exports generated engine runner types and enums
- `packages/types/package.json` codegen script now generates from engine-runner.yaml
- `packages/contracts/redocly.yaml` disables rules inappropriate for internal contracts
  (no-empty-servers, security-defined, info-license)
