# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.2.0] - 2026-09-15

First release of Sardeenz v2, the production-grade successor to the
[v1 prototype](https://github.com/rh-aiservices-bu/sardeenz). This section summarizes what the
platform delivers as of this release; the per-change history that accumulated during
development (Phases 0-4 and milestones M1-M14) is preserved in the git history of this file.

### Platform

- **Four decoupled components talking only through OpenAPI contracts** (ADR-002, ADR-005):
  a Rust routing proxy, a TypeScript control plane (Fastify, PostgreSQL, Redis/Valkey), a React +
  PatternFly 6 admin dashboard with a Fastify BFF, and engine runners. TypeScript types are
  generated from the specs in `packages/contracts/`; Rust types are hand-maintained.
- **Application-layer VRAM multiplexing.** Models are logical configurations with one or more
  instances (ADR-019); the control plane places them on workers and GPUs, sleeps idle models,
  wakes them on demand, and evicts to make room. Configuration name, served model name, and
  display name are distinct (ADR-020).
- **Measured-only GPU memory doctrine.** Every memory figure shown to users comes from NVML
  telemetry; `requiredMemory` is a placement input, never a user-facing "reserved" figure.
  kvcached pool statistics (prealloc / used / free) are reported end to end.

### Routing proxy

- OpenAI-compatible and Open Inference Protocol traffic on separate path families (`/openai`,
  `/oip`, ADR-021), weighted round-robin across instances with per-endpoint circuit breakers.
- **Wake-on-request parking.** Requests for a sleeping model are parked, a wake is triggered, and
  the request is forwarded once the model is ready; parked herds fail fast on wake rollback and
  never suppress the next wake trigger.
- Live routing map from Redis pub/sub with reconnect and backoff; request-ID tracing; hop-by-hop
  header filtering; configurable body cap, parking byte budget, forwarding concurrency limits, and
  upstream timeout.
- Prometheus metrics on a separate admin port: request counts and latency histograms, active and
  parked connections, parking duration, wake triggers, circuit-breaker state.

### Control plane

- Model lifecycle API: deploy, sleep, wake, stop, start, delete, and force-delete for stalled
  configurations; in-progress deployments can be cancelled; stopped configurations can be
  modified in place.
- **Resumable move-model operation** across workers and GPUs with weight-zero cutover, resumed
  after leader changes.
- Placement pipeline with capability filtering, VRAM budgeting with in-flight reservations, LRU
  eviction wired into deploy and wake, and a reconciliation loop that repairs ghost instances after
  worker restarts.
- Kubernetes Lease-based leader election; atomic Redis state transitions via Lua scripts;
  PostgreSQL migrations at startup.
- Durable, instance-scoped startup logs replayable from the dashboard.
- Runner catalog: digest-pinned ORAS imports of official runner SIFs with byte-accurate
  verification, digest-drift detection, and optional Apptainer signature checks.
- Server-sent events for model, worker, and memory changes; Prometheus metrics for models,
  workers, device memory, state transitions, evictions, and operation durations.

### Admin dashboard

- Cluster overview with a GPU placement board, per-GPU stacked per-model VRAM bars, and the
  cluster inference URL; model list with sorting, multi-instance worker links, and runner
  identification; model detail with startup-log replay; worker pages.
- Deploy form driven by live worker capabilities, with runtime-module (SIF) selection and a
  weights folder picker; compact per-model action menus (sleep, wake, move, stop) on GPU cards.
- **Chatbot Playground** built on `@patternfly/chatbot`: model sidebar grouped by GPU, session
  tabs, single / split / 2x2 layouts, streaming and non-streaming turns, latency / TTFT / tok/s
  per reply, persisted layout and sessions, and a per-user inference concurrency cap.
- **Metrics page** backed by Prometheus: request latency and throughput, active and parked
  connections, parking duration, wake triggers, state transitions, evictions, memory over time,
  and average operation durations, with preset and custom time ranges and auto-refresh. Works
  against OpenShift user-workload monitoring out of the box (Thanos Querier tenancy port with
  ServiceAccount token, service CA, and namespace tenancy).
- Notification drawer fed by SSE with degraded polling fallback; Redis fallback for all read
  routes when the control plane is unavailable.
- Authentication modes `none`, `simple`, and OpenShift OAuth with namespace-scoped
  `sardeenz-admin` / `sardeenz-admin-readonly` marker Roles; read-only users get a read-only UI.
- Accessibility audit fixes, i18n infrastructure, and a Playwright e2e suite against mock
  services, enforced in CI.

### Engine runners

- **Apptainer SIF runtime** (ADR-015 to ADR-018): engine images are converted to SIF files on a
  shared volume and executed by a slim worker image; official SIFs are distributed via ORAS from
  the `runners.yaml` catalog.
- Worker agent with NVML GPU detection, per-runner port blocks, runner lifecycle management with
  log streaming, multiple runner families per worker, and heartbeat memory reports.
- **vLLM runner shim** (vLLM 0.21 and 0.24 images, kvcached-enabled) and **MLServer runner
  shim** (MLServer 1.7.1) implementing the engine-runner contract: health, memory report, sleep
  and wake, and engine-parameter passthrough. A shared conformance suite runs against both.
- Runner container definitions organized by engine and exact upstream version under
  `containers/runners/<engine>/<version>/`.

### Deployment and operations

- Kustomize bases for the control plane, proxy, dashboard, worker (SCC, RBAC, PVCs, NetworkPolicy,
  PVC write protection), PoC PostgreSQL and Valkey backing services, OpenShift monitoring
  (ServiceMonitors, service-CA ConfigMap, metrics-reader Role), and a parameterized Librarian Job
  that builds, converts, and publishes runner SIFs on OpenShift.
- Canonical Quay repository layout and a manual GitHub workflow that builds and pushes all
  platform images.
- Defense in depth: bearer-token authentication on the control plane and worker agent, allow-list
  NetworkPolicies per flow, restrictive BFF security headers, proxy-aware rate limiting, SIF
  supply-chain checks, and secrets sourced from environment variables (ADR-013). Operator guides
  cover deployment security, OpenShift OAuth RBAC, MLServer model layouts, and the runner catalog.

### Development

- npm workspaces monorepo with a Makefile front door; `make lint typecheck test` gate; Podman
  Compose dev services; logged dev servers; integration tests on a dedicated `_test` database.
- CI: quality (lint, typecheck, unit and integration tests), dashboard e2e, Python runner and
  conformance suites, and service container build and smoke tests on every pull request.
- Architecture overview, 21 ADRs, per-component specs, and per-component `AGENTS.md` guides for
  AI-assisted development.

### Notable fixes folded into this release

Development surfaced and fixed a long tail of correctness issues before release, including:
runner processes not terminated on delete, stop, or eviction; VRAM reservations cleared
prematurely or leaked; move and delete races; parked-connection and circuit-breaker leaks in the
proxy; routing entries corrupted on sleep; integration tests wiping the dev database; MLServer
failing on read-only images; OAuth identity and RBAC lookups on OpenShift; and proxy histograms
rendered as summaries, which left latency panels empty.
