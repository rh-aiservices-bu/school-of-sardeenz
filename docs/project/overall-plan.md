# Sardeenz v2 — Project Plan

## Executive Summary

Sardeenz v2 is a GPU workload orchestration platform that lets enterprise clusters host and serve more accelerator-based workloads (LLMs, diffusion models, predictive models) than can physically fit in device memory at the same time. It does this by moving workload scheduling from Kubernetes to the application layer — treating device memory as a fluid, software-defined resource that can be packed, swapped, and paged on the fly.

The platform replaces the [Sardeenz v1 prototype](https://github.com/rh-aiservices-bu/sardeenz). It is a new build, not a refactor. v1 remains a living reference for UI components and domain knowledge.

**What stakeholders can expect:** a system where AI applications connect through a standard OpenAI-compatible API and get transparent access to models — whether those models are already loaded, sleeping in host memory, or need to be evicted and swapped in. Administrators get a dashboard showing GPU utilization, model status, and memory budgets in real time.

## Architecture at a Glance

Four components, each independently deployable:

| Component | What it does | Tech stack |
| --- | --- | --- |
| **Routing Proxy** | Routes every inference request to the right model, parks connections when models are waking up | Rust (axum / tokio) |
| **Control Plane** | Decides where models run, manages GPU memory budgets, orchestrates sleep/wake/eviction | TypeScript (Fastify) |
| **Admin Dashboard** | Shows cluster state, lets admins deploy/manage models, visualizes GPU memory | React + PatternFly 6 (frontend), TypeScript Fastify (backend) |
| **Engine Runners** | Run the actual inference engines (vLLM, Triton, etc.) inside worker pods | Engine-specific, behind a common contract |

All four communicate through OpenAPI contracts (the single source of truth for cross-language types) and a shared Redis/Valkey state store. Full architecture details: [`docs/architecture/overview.md`](../architecture/overview.md).

## Delivery Phases

The project is delivered in five sequential phases. Each phase produces a usable increment and has clear entry/exit criteria.

```text
Phase 0          Phase 1          Phase 2          Phase 3        Phase 4
Contracts   ──►  Proxy       ──►  Control Plane ──►  Dashboard  ──►  Highlander
(spec only)      (Rust)           (TypeScript)       (React)        (HPC runtime)
```

Phases are sequential because each depends on the output of the previous one. Phases 3 and 4 have limited overlap potential (the dashboard can begin while Highlander integration starts), but the critical path runs through Phases 0 → 1 → 2.

---

### Phase 0: Engine Runner Contract Design

**Objective:** Define the contract that every inference engine must implement so the rest of the platform can manage it uniformly — without writing any runtime code yet.

**Why this is first:** Every subsequent phase depends on this boundary. The proxy needs to know how to health-check runners. The control plane needs to know how to start, stop, sleep, and wake them. Getting this wrong means rework across all components.

#### Deliverables

| # | Deliverable | Format |
| --- | --- | --- |
| 0.1 | Runner contract OpenAPI specification | `packages/contracts/specs/engine-runner.yaml` |
| 0.2 | Generated TypeScript types from the spec | `packages/types/src/generated/` |
| 0.3 | Runner contract design document | `docs/architecture/components/runner-contract.md` |

#### Scope

The contract defines the HTTP endpoints each runner exposes:

- **Health checking** — readiness probes, state reporting, loading progress
- **Memory reporting** — per-device memory consumption
- **Sleep/wake** — memory offload commands with level support (L1: offload to host RAM; future levels TBD)
- **Progress reporting** — structured loading progress
- **Capability declaration** — what a runner type supports (tensor parallelism, KV cache offload, specific sleep levels, supported model types)

Lifecycle management (drain, stop) is a worker-level concern — the control plane manages the routing map, the worker manages runner processes via signals.

#### Definition of Done

- [x] OpenAPI spec passes `redocly lint` with zero errors
- [x] Generated TypeScript types compile cleanly (`make typecheck`)
- [x] Design document covers all five interface areas listed above
- [x] Contract reviewed against the Sardeenz v1 vLLM integration to confirm no capability gaps
- [x] At least one walkthrough with the team confirming the contract supports the vLLM, Triton, and CPU-only runner scenarios from the architecture overview

#### Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Contract misses a capability needed by a future engine | Rework in later phases | Validate against three known runner types (vLLM, Triton, MLServer) before sign-off |
| Over-engineering the contract for engines we haven't built yet | Complexity without value | Start minimal; the contract should support vLLM fully and accommodate others structurally |

---

### Phase 1: Rust Proxy with Connection Parking

**Objective:** Build a stateless, high-performance routing proxy that forwards OpenAI-compatible inference requests to the correct runner — including transparent connection parking when a target model is sleeping.

**Why Rust:** The proxy is on the critical path of every inference request. Rust gives deterministic latency without GC pauses. See [ADR-003](../architecture/adrs/adr-003-rust-proxy.md).

#### Deliverables

| # | Deliverable | Description |
| --- | --- | --- |
| 1.1 | Routing proxy binary | `proxy/` — production-ready Rust binary |
| 1.2 | Proxy ↔ Control Plane OpenAPI spec | Wake trigger API, routing map schema, model state definitions |
| 1.3 | Container image | Multi-stage Docker build for the proxy |
| 1.4 | Integration test suite | Tests covering all four request flow scenarios |
| 1.5 | Structured output compatibility solution | Documented approach for handling structured output across engine versions |

#### Scope

- **Request routing** — read routing map from Redis/Valkey, resolve target runner, forward request
- **OpenAI protocol compatibility** — support `/v1/chat/completions`, `/v1/completions`, `/v1/models` (both streaming and non-streaming)
- **Connection parking** — when a model is sleeping, hold the client connection open and fire a wake trigger to the control plane; resume forwarding when the model becomes active
- **Thundering herd prevention** — deduplicate wake triggers when multiple clients hit the same sleeping model simultaneously
- **Cluster forwarding** — weighted round-robin across runner replicas with circuit breaking
- **Health and metrics** — Prometheus scrape endpoint, readiness/liveness probes

#### Out of Scope

- Non-OpenAI protocols (MLServer, Triton HTTP) — future extension
- TLS termination — handled by the ingress layer
- Authentication/authorization — future phase or external sidecar

#### Definition of Done

- [ ] Proxy routes requests to active models with < 1ms overhead (p99, excluding network transit)
- [ ] Connection parking works end-to-end: client sends request → proxy parks → model wakes → client receives response, with no client-side retry needed
- [ ] Thundering herd: 100 concurrent requests to the same sleeping model produce exactly 1 wake trigger
- [ ] Circuit breaker trips after configurable failure threshold and recovers after backoff
- [ ] All four request flows from the [architecture overview](../architecture/overview.md#request-flows) pass integration tests
- [ ] Structured output compatibility approach documented and validated
- [ ] Container image builds and runs in CI
- [ ] Prometheus metrics endpoint exposes: request count, latency histogram, active connections, parked connections, circuit breaker state

#### Dependencies

- Phase 0 (runner contract) — for health check and model state definitions
- Redis/Valkey instance — for routing map reads and pub/sub

#### Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Structured output compatibility across engine versions | Proxy may need to transform or validate response schemas | Research early; prototype before full implementation |
| Connection parking memory under sustained load | High parked connection count could exhaust proxy memory | Configurable limits with backpressure; load test with 10K+ parked connections |
| SSE streaming edge cases | Partial frames, client disconnects mid-stream | Comprehensive integration tests with fault injection |

---

### Phase 2: Control Plane Sleep/Wake Orchestration

**Objective:** Build the brain of the system — the control plane that tracks GPU memory budgets, decides where models run, manages their lifecycle, and coordinates sleep/wake with runners.

#### Deliverables

| # | Deliverable | Description |
| --- | --- | --- |
| 2.1 | Control plane service | `control-plane/` — Fastify application |
| 2.2 | Control plane OpenAPI spec | Full admin API for model lifecycle, worker management, cluster state |
| 2.3 | Dashboard ↔ Control Plane OpenAPI spec | API contract the dashboard will consume |
| 2.4 | Database migrations | PostgreSQL schema for configurations, benchmarks, memory profiles |
| 2.5 | Integration test suite | Tests for placement, eviction, sleep/wake, state machine transitions |
| 2.6 | Container image | Docker build for the control plane |

#### Scope

- **Model lifecycle state machine** — states: `PENDING` → `STARTING` → `ACTIVE` → `SLEEPING` → `STOPPING` → `STOPPED`, with well-defined transitions and error states
- **Device memory budget tracking** — global view of memory allocation across all workers, built from worker self-reports in Redis/Valkey
- **Workload placement pipeline** — four-stage matching: runner type selection → hardware filtering → capacity filtering → placement strategy
- **LRU eviction engine** — when memory is constrained, select least-recently-used models to sleep or stop; behind a pluggable strategy interface
- **Sleep/wake coordination** — send sleep/wake commands to runners through the runner contract; handle timeouts and failures
- **Routing map management** — write routing map updates to Redis/Valkey for the proxy to consume
- **Worker pool management** — workers join and leave dynamically without control plane restart
- **Leader election** — K8s Lease-based leader/standby for high availability

#### Out of Scope

- Auto-scaling workers (manual provisioning initially)
- Multi-cluster federation
- Advanced eviction strategies beyond LRU (pluggable interface is in scope; alternative implementations are not)

#### Definition of Done

- [ ] Model lifecycle state machine covers all transitions, including error recovery (e.g., runner fails to start → state returns to `STOPPED`)
- [ ] Placement pipeline correctly matches models to workers across the three scenarios: GPU with capacity, GPU without capacity (triggers eviction), CPU-only fallback
- [ ] LRU eviction frees enough memory for a new deployment by sleeping the least-recently-used model(s)
- [ ] Sleep/wake round-trip works end-to-end: control plane sends sleep → runner offloads → control plane sends wake → runner reloads → model serves traffic
- [ ] Worker join/leave detected within 30 seconds without control plane restart
- [ ] Leader failover completes within the K8s Lease duration (typically 15s); inference traffic is unaffected during failover (proxy continues forwarding to active runners)
- [ ] All OpenAPI specs pass `redocly lint`
- [ ] Generated TypeScript types compile cleanly
- [ ] Integration tests pass against real Redis and PostgreSQL instances (no mocks for data stores)

#### Dependencies

- Phase 0 (runner contract) — defines how the control plane talks to runners
- Phase 1 (proxy) — control plane updates the routing map that the proxy reads; proxy sends wake triggers to the control plane
- Redis/Valkey, PostgreSQL — data stores

#### Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| State machine edge cases under concurrent operations | Models stuck in intermediate states, orphaned runners | Exhaustive state transition tests; timeout-based recovery for every non-terminal state |
| Eviction cascades | Evicting model A to load model B triggers eviction of model C, thrashing the cluster | Configurable eviction limits (max evictions per cycle); circuit breaker on eviction frequency |
| Worker self-report lag | Control plane makes placement decisions on stale memory data | Heartbeat timeout detection; placement pipeline re-validates capacity before starting a runner |

---

### Phase 3: Admin Dashboard

**Objective:** Build a web-based administration interface where operators can deploy and manage models, monitor GPU memory utilization, and observe cluster health — all in real time.

**Approach:** New build using React 18 + PatternFly 6, not a port of the v1 dashboard. Proven v1 UI components (GPU memory cards, model status panels, benchmark views) will be cherry-picked and adapted to the new platform's data model.

#### Deliverables

| # | Deliverable | Description |
| --- | --- | --- |
| 3.1 | Dashboard frontend | `dashboard/` — React + PatternFly 6 + Vite SPA |
| 3.2 | Dashboard backend (BFF) | Fastify service aggregating from control plane, Redis, Prometheus |
| 3.3 | Container image(s) | Frontend static build + backend service |
| 3.4 | E2E test suite | Playwright tests for critical admin workflows |

#### Scope

**Core views:**

- **Cluster overview** — worker status, aggregate GPU memory utilization, active/sleeping model counts
- **Model management** — deploy, stop, sleep, wake models; view state history and logs
- **Worker detail** — per-worker GPU memory breakdown, running runners, hardware capabilities
- **Device memory visualization** — graphical representation of memory allocation across devices (cherry-pick from v1)
- **Metrics dashboards** — inference latency, throughput, device utilization (data from Prometheus)

**Infrastructure:**

- App shell with PatternFly 6 page layout, sidebar navigation, breadcrumbs
- Client-side routing (React Router)
- Data fetching layer with real-time updates (SSE or polling from BFF)
- Authentication flow (integration point TBD — may use external auth provider)

#### Out of Scope

- User management / RBAC (future phase)
- Multi-cluster views
- Custom alerting rules (Prometheus/Alertmanager handle this externally)

#### Definition of Done

- [ ] Admin can deploy a model through the dashboard and see it transition through `STARTING` → `ACTIVE`
- [ ] Admin can sleep and wake a model through the dashboard
- [ ] Cluster overview shows real-time GPU memory utilization (updates within 5 seconds of state change)
- [ ] Device memory visualization renders correctly for workers with 1, 2, 4, and 8 GPUs
- [ ] Dashboard remains responsive and displays cached state during a brief control plane restart (BFF reads from Redis/Prometheus independently)
- [ ] All views pass PatternFly 6 accessibility standards (WCAG 2.1 AA)
- [ ] Playwright E2E tests cover: model deploy, model sleep/wake, cluster overview loads, worker detail loads
- [ ] Frontend builds with zero TypeScript errors and zero ESLint warnings

#### Dependencies

- Phase 2 (control plane) — dashboard backend calls the control plane API for orchestration commands
- Phase 1 (proxy, indirect) — proxy must be running so deployed models can serve traffic
- Redis/Valkey, Prometheus — dashboard backend reads state and metrics directly

#### Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| PatternFly 6 is newer and community examples are fewer | Slower UI development, unexpected component gaps | Use official PatternFly.org docs as sole reference; avoid Context7 for PF components (may return outdated versions) |
| Real-time updates create excessive Redis load | Dashboard polling degrades proxy performance | Use pub/sub for state changes, not polling; rate-limit dashboard subscriptions |
| v1 component cherry-pick takes longer than expected | UI delivery slows | Time-box cherry-pick to 2 days per component; rebuild from scratch if adaptation is too invasive |

---

### Phase 4: Highlander Runtime Integration

**Objective:** Replace traditional container image pulls with HPC-style module loading — workers load engine runtimes (vLLM, Triton) from shared network storage in seconds instead of minutes, enabling fast version switching, zero-downtime upgrades, and canary deployments.

**Why "Highlander":** Named after the [ODH Highlander](https://odh-highlander.github.io/) project that provides the upstream Lmod/EasyBuild module management system.

#### Deliverables

| # | Deliverable | Description |
| --- | --- | --- |
| 4.1 | Base worker container image | `containers/worker-base/` — slim image with OS, accelerator drivers, Lmod |
| 4.2 | EasyBuild configurations | `easyconfigs/` — build recipes for vLLM and initial engine set |
| 4.3 | Module load/unload IPC | Control plane → worker communication for `module load`/`unload` |
| 4.4 | CephFS mount architecture | Storage layout documentation and K8s volume configuration |
| 4.5 | Squashfs/erofs packaging | Packaged modules to mitigate CephFS metadata storms |
| 4.6 | Integration test suite | Tests for module load, runner start, version switch, canary deployment |

#### Scope

- **Worker container image** — minimal base with OS, accelerator drivers (CUDA/ROCm), and Lmod; no engine runtimes baked in
- **EasyBuild recipes** — self-contained easyconfigs that build engine runtimes as Lmod modules
- **CephFS storage layout** — separate mount points for application modules (read-only) and model weights (read-write)
- **Module load/unload protocol** — control plane instructs workers to load specific engine versions before spawning runners
- **Metadata storm mitigation** — squashfs or erofs packaging for module directories to reduce CephFS metadata operations at scale
- **Version management** — support multiple engine versions simultaneously on the same worker (e.g., vLLM 0.19.1 and 0.20.0 serving side-by-side)

#### Out of Scope

- Automated EasyBuild CI pipeline (manual builds initially)
- Non-CephFS shared storage backends
- GPU driver management (assumes drivers are pre-installed on worker nodes)

#### Definition of Done

- [ ] Worker container image starts and loads an Lmod module within 10 seconds (measured from `module load` to module available)
- [ ] Control plane can instruct a worker to load a specific engine version and start a runner using that version
- [ ] Two versions of the same engine can run simultaneously on one worker (canary scenario)
- [ ] Zero-downtime version upgrade: new version starts → proxy shifts traffic → old version drains → old version stops, with no client errors
- [ ] Squashfs-packaged modules reduce CephFS metadata operations by at least 90% compared to unpacked directories (measured with `strace` metadata syscall count)
- [ ] Base worker image size is under 2 GB (excluding mounted modules and weights)
- [ ] EasyBuild recipes for vLLM build successfully and produce a working Lmod module

#### Dependencies

- Phase 1 (proxy) — proxy must support traffic shifting for zero-downtime upgrades
- Phase 2 (control plane) — control plane issues module load commands to workers
- CephFS cluster — shared storage infrastructure
- EasyBuild/Lmod — installed in worker containers and on the build host

#### Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| CephFS metadata storms at scale | Slow module loads, worker timeouts | Squashfs/erofs packaging (deliverable 4.5); benchmark at target scale early |
| EasyBuild recipe complexity for GPU-accelerated Python stacks | Slow initial builds, hard-to-debug failures | Start with vLLM only; leverage existing Highlander community recipes where available |
| Lmod/EasyBuild unfamiliarity on the team | Slower delivery, integration surprises | Time-box a spike at phase start to validate the full load/unload cycle before committing to the implementation plan |

---

## Cross-Cutting Concerns

These concerns span all phases and must be addressed continuously rather than in a single phase.

### OpenAPI Contract Discipline

All inter-component communication is defined by OpenAPI specs in `packages/contracts/`. The workflow — edit spec, validate, generate types, fix consumers, commit together — must be followed from Phase 0 onward. See [ADR-005](../architecture/adrs/adr-005-openapi-contracts.md).

### Testing Strategy

| Level | Scope | Tooling |
| --- | --- | --- |
| Unit | Individual functions and modules | Vitest (TypeScript), `cargo test` (Rust) |
| Integration | Component against real data stores | Vitest + test containers (TypeScript), integration test harness (Rust) |
| E2E | Full system workflows | Playwright (dashboard), custom harness (proxy + control plane + runner) |

Integration tests use real Redis and PostgreSQL instances — no mocks for data stores.

### Observability

Every component exposes a Prometheus scrape endpoint from Phase 1 onward. Key metrics are defined per component in each phase's deliverables. Structured logging (JSON) is required across all components.

### CI/CD

The monorepo uses a unified Makefile. CI runs `make all` (typecheck + lint) and `make test` on every PR. OpenAPI validation (`redocly lint`) is part of the lint step. Generated types are committed to the repo so consumers don't need to run codegen.

### Security Boundaries

- The proxy does not handle authentication (handled by ingress/sidecar)
- The control plane API is internal — not exposed to end users
- The dashboard backend enforces authorization (integration point TBD)
- Runner contract communication is cluster-internal (no public network exposure)

---

## How to Read This Plan

- **Technical contributors:** focus on the scope, deliverables, and definition of done for your phase. The architecture overview and ADRs linked throughout provide the full technical context.
- **Project managers:** use the definitions of done as acceptance criteria. The risk tables flag what to watch for in each phase.
- **Stakeholders and leadership:** the executive summary and architecture-at-a-glance sections describe what the platform does and how it's structured. The phase sequence shows what gets delivered when, and each phase's objective explains the "why."

---

**Supporting documents:**

- [Architecture Overview](../architecture/overview.md) — system design, diagrams, request flows
- [Architecture Decision Records](../architecture/adrs/) — rationale for every major technical choice
- [Development Setup](../development/setup.md) — how to build and run locally
- [Coding Standards](../development/coding-standards.md) — conventions for TypeScript and Rust
