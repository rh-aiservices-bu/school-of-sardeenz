# Sardeenz v2 — Project Plan

## Executive Summary

Sardeenz v2 is a GPU workload orchestration platform that lets enterprise clusters host and serve more accelerator-based workloads (LLMs, diffusion models, predictive models) than can physically fit in device memory at the same time. It does this by moving workload scheduling from Kubernetes to the application layer — treating device memory as a fluid, software-defined resource that can be packed, swapped, and paged on the fly.

The platform replaces the [Sardeenz v1 prototype](https://github.com/rh-aiservices-bu/sardeenz). It is a new build, not a refactor. v1 remains a living reference for UI components and domain knowledge.

**What stakeholders can expect:** a system where AI applications connect through a standard OpenAI-compatible API and get transparent access to models — whether those models are already loaded, sleeping in host memory, or need to be evicted and swapped in. Administrators get a dashboard showing GPU utilization, model status, and memory budgets in real time.

## Architecture at a Glance

Four components, each independently deployable:

| Component           | What it does                                                                                   | Tech stack                                                    |
| ------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| **Routing Proxy**   | Routes every inference request to the right model, parks connections when models are waking up | Rust (axum / tokio)                                           |
| **Control Plane**   | Decides where models run, manages GPU memory budgets, orchestrates sleep/wake/eviction         | TypeScript (Fastify)                                          |
| **Admin Dashboard** | Shows cluster state, lets admins deploy/manage models, visualizes GPU memory                   | React + PatternFly 6 (frontend), TypeScript Fastify (backend) |
| **Engine Runners**  | Run the actual inference engines (vLLM, Triton, etc.) inside worker pods                       | Engine-specific, behind a common contract                     |

All four communicate through OpenAPI contracts (the single source of truth for cross-language types) and a shared Redis/Valkey state store. Full architecture details: [`docs/architecture/overview.md`](../architecture/overview.md).

## Delivery Phases

The project was delivered in seven sequential phases (0, 1, 2, 3, 3.5, 3.6, 4), all complete. Each phase produced a usable increment with clear entry/exit criteria. Since Phase 4, work continues on two tracks: a **milestone backlog** (M2 onward, groomed GitHub milestones on `dev`) and **Phase 5**. Current state: [`status.md`](status.md).

```text
Phase 0          Phase 1          Phase 2          Phase 3        Phase 3.5       Phase 3.6        Phase 4          Phase 5
Contracts   ──►  Proxy       ──►  Control Plane ──►  Dashboard  ──►  UI Polish  ──►  Dev Worker  ──►  SIF Runners ──►  kvcached
(spec only)      (Rust)           (TypeScript)       (React)        (chrome)        (dev tooling)    (Apptainer)      co-location
                                                                                                          │
                                                                                          Milestones M2 … M13 (backlog track)
```

Phases are sequential because each depends on the output of the previous one. Phases 3 and 4 have limited overlap potential (the dashboard can begin while the runtime work starts), but the critical path runs through Phases 0 → 1 → 2.

---

### Phase 0: Engine Runner Contract Design

**Objective:** Define the contract that every inference engine must implement so the rest of the platform can manage it uniformly — without writing any runtime code yet.

**Why this is first:** Every subsequent phase depends on this boundary. The proxy needs to know how to health-check runners. The control plane needs to know how to start, stop, sleep, and wake them. Getting this wrong means rework across all components.

#### Deliverables

| #   | Deliverable                              | Format                                            |
| --- | ---------------------------------------- | ------------------------------------------------- |
| 0.1 | Runner contract OpenAPI specification    | `packages/contracts/specs/engine-runner.yaml`     |
| 0.2 | Generated TypeScript types from the spec | `packages/types/src/generated/`                   |
| 0.3 | Runner contract design document          | `docs/architecture/components/runner-contract.md` |

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

| Risk                                                           | Impact                   | Mitigation                                                                                |
| -------------------------------------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------- |
| Contract misses a capability needed by a future engine         | Rework in later phases   | Validate against three known runner types (vLLM, Triton, MLServer) before sign-off        |
| Over-engineering the contract for engines we haven't built yet | Complexity without value | Start minimal; the contract should support vLLM fully and accommodate others structurally |

---

### Phase 1: Rust Proxy with Connection Parking

**Objective:** Build a stateless, high-performance routing proxy that forwards OpenAI-compatible inference requests to the correct runner — including transparent connection parking when a target model is sleeping.

**Why Rust:** The proxy is on the critical path of every inference request. Rust gives deterministic latency without GC pauses. See [ADR-003](../architecture/adrs/adr-003-rust-proxy.md).

#### Deliverables

| #   | Deliverable                              | Description                                                               |
| --- | ---------------------------------------- | ------------------------------------------------------------------------- |
| 1.1 | Routing proxy binary                     | `proxy/` — production-ready Rust binary                                   |
| 1.2 | Proxy ↔ Control Plane OpenAPI spec       | Wake trigger API, routing map schema, model state definitions             |
| 1.3 | Container image                          | Multi-stage Docker build for the proxy                                    |
| 1.4 | Integration test suite                   | Tests covering all four request flow scenarios                            |
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
- [x] Connection parking works end-to-end: client sends request → proxy parks → model wakes → client receives response, with no client-side retry needed
- [x] Thundering herd: 100 concurrent requests to the same sleeping model produce exactly 1 wake trigger
- [x] Circuit breaker trips after configurable failure threshold and recovers after backoff
- [x] All four request flows from the [architecture overview](../architecture/overview.md#request-flows) pass integration tests
- [x] Structured output compatibility approach documented and validated
- [x] Container image builds and runs in CI
- [x] Prometheus metrics endpoint exposes: request count, latency histogram, active connections, parked connections, circuit breaker state

#### Dependencies

- Phase 0 (runner contract) — for health check and model state definitions
- Redis/Valkey instance — for routing map reads and pub/sub

#### Risks

| Risk                                                   | Impact                                                   | Mitigation                                                                    |
| ------------------------------------------------------ | -------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Structured output compatibility across engine versions | Proxy may need to transform or validate response schemas | Research early; prototype before full implementation                          |
| Connection parking memory under sustained load         | High parked connection count could exhaust proxy memory  | Configurable limits with backpressure; load test with 10K+ parked connections |
| SSE streaming edge cases                               | Partial frames, client disconnects mid-stream            | Comprehensive integration tests with fault injection                          |

---

### Phase 2: Control Plane Sleep/Wake Orchestration

**Objective:** Build the brain of the system — the control plane that tracks GPU memory budgets, decides where models run, manages their lifecycle, and coordinates sleep/wake with runners.

#### Deliverables

| #   | Deliverable                            | Description                                                          |
| --- | -------------------------------------- | -------------------------------------------------------------------- |
| 2.1 | Control plane service                  | `control-plane/` — Fastify application                               |
| 2.2 | Control plane OpenAPI spec             | Full admin API for model lifecycle, worker management, cluster state |
| 2.3 | Dashboard ↔ Control Plane OpenAPI spec | API contract the dashboard will consume                              |
| 2.4 | Database migrations                    | PostgreSQL schema for configurations, benchmarks, memory profiles    |
| 2.5 | Integration test suite                 | Tests for placement, eviction, sleep/wake, state machine transitions |
| 2.6 | Container image                        | Docker build for the control plane                                   |

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

- [x] Model lifecycle state machine covers all transitions, including error recovery (e.g., runner fails to start → state returns to `STOPPED`)
- [x] Placement pipeline correctly matches models to workers across the three scenarios: GPU with capacity, GPU without capacity (triggers eviction), CPU-only fallback
- [x] LRU eviction frees enough memory for a new deployment by sleeping the least-recently-used model(s)
- [x] Sleep/wake round-trip works end-to-end: control plane sends sleep → runner offloads → control plane sends wake → runner reloads → model serves traffic
- [x] Worker join/leave detected within 30 seconds without control plane restart
- [x] Leader failover completes within the K8s Lease duration (typically 15s); inference traffic is unaffected during failover (proxy continues forwarding to active runners)
- [x] All OpenAPI specs pass `redocly lint`
- [x] Generated TypeScript types compile cleanly
- [x] Integration tests pass against real Redis and PostgreSQL instances (no mocks for data stores)

#### Dependencies

- Phase 0 (runner contract) — defines how the control plane talks to runners
- Phase 1 (proxy) — control plane updates the routing map that the proxy reads; proxy sends wake triggers to the control plane
- Redis/Valkey, PostgreSQL — data stores

#### Risks

| Risk                                                 | Impact                                                                               | Mitigation                                                                                     |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| State machine edge cases under concurrent operations | Models stuck in intermediate states, orphaned runners                                | Exhaustive state transition tests; timeout-based recovery for every non-terminal state         |
| Eviction cascades                                    | Evicting model A to load model B triggers eviction of model C, thrashing the cluster | Configurable eviction limits (max evictions per cycle); circuit breaker on eviction frequency  |
| Worker self-report lag                               | Control plane makes placement decisions on stale memory data                         | Heartbeat timeout detection; placement pipeline re-validates capacity before starting a runner |

---

### Phase 3: Admin Dashboard

**Objective:** Build a web-based administration interface where operators can deploy and manage models, monitor GPU memory utilization, and observe cluster health — all in real time.

**Approach:** React 18 + PatternFly 6 frontend with a reuse-first strategy. The v1 dashboard is a functional React + PatternFly application covering the same domain — v1 components (GPU memory cards, model status panels, deploy forms, worker layouts) should be **ported directly** to the v2 data model and upgraded from PatternFly 5 to 6. Build new only when v1 has no equivalent or when the v2 data model diverges too far for porting to be practical.

#### Deliverables

| #   | Deliverable             | Description                                                       |
| --- | ----------------------- | ----------------------------------------------------------------- |
| 3.1 | Dashboard frontend      | `dashboard/` — React + PatternFly 6 + Vite SPA                    |
| 3.2 | Dashboard backend (BFF) | Fastify service aggregating from control plane, Redis, Prometheus |
| 3.3 | Container image(s)      | Frontend static build + backend service                           |
| 3.4 | E2E test suite          | Playwright tests for critical admin workflows                     |

#### Scope

**Core views:**

- **Cluster overview** — worker status, aggregate GPU memory utilization, active/sleeping model counts
- **Model management** — deploy, stop, sleep, wake models; view state history and logs
- **Worker detail** — per-worker GPU memory breakdown, running runners, hardware capabilities
- **Device memory visualization** — graphical representation of memory allocation across devices (port from v1)
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

- [x] Admin can deploy a model through the dashboard and see it transition through `STARTING` → `ACTIVE`
- [x] Admin can sleep and wake a model through the dashboard
- [x] Cluster overview shows real-time GPU memory utilization (updates within 5 seconds of state change)
- [x] Device memory visualization renders correctly for workers with 1, 2, 4, and 8 GPUs
- [x] Dashboard remains responsive and displays cached state during a brief control plane restart (BFF reads from Redis/Prometheus independently)
- [x] All views pass PatternFly 6 accessibility standards (WCAG 2.1 AA)
- [x] Playwright E2E tests cover: model deploy, model sleep/wake, cluster overview loads, worker detail loads
- [x] Frontend builds with zero TypeScript errors and zero ESLint warnings

#### Dependencies

- Phase 2 (control plane) — dashboard backend calls the control plane API for orchestration commands
- Phase 1 (proxy, indirect) — proxy must be running so deployed models can serve traffic
- Redis/Valkey, Prometheus — dashboard backend reads state and metrics directly

#### Risks

| Risk                                                   | Impact                                           | Mitigation                                                                                                          |
| ------------------------------------------------------ | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| PatternFly 6 is newer and community examples are fewer | Slower UI development, unexpected component gaps | Use official PatternFly.org docs as sole reference; avoid Context7 for PF components (may return outdated versions) |
| Real-time updates create excessive Redis load          | Dashboard polling degrades proxy performance     | Use pub/sub for state changes, not polling; rate-limit dashboard subscriptions                                      |
| v1 component porting takes longer than expected        | UI delivery slows                                | Time-box porting to 2 days per component; rebuild only if porting costs more than building new                      |

---

### Phase 3.5: Admin UI Finalization

**Objective:** Bring the v2 Admin Dashboard to feature parity with the v1 dashboard header bar — SVG logo, dark/light theme toggle, full notification system (backend + frontend), user dropdown menu, and sidebar footer with GitHub link.

#### Deliverables

| #     | Deliverable           | Description                                                               |
| ----- | --------------------- | ------------------------------------------------------------------------- |
| 3.5.1 | Notification backend  | `NotificationService` in control plane with Redis storage + pub/sub push  |
| 3.5.2 | Notification API      | REST endpoints for list, mark-read, remove, clear; BFF proxy layer        |
| 3.5.3 | Notification frontend | Context provider, drawer overlay, toast alerts, SSE integration           |
| 3.5.4 | Theme system          | Dark/light toggle with localStorage persistence, PF6 `pf-v6-theme-dark`   |
| 3.5.5 | Masthead overhaul     | SVG logo, sidebar toggle, theme toggle, notification badge, user dropdown |

#### Scope

- SVG logo with sidebar toggle (hamburger button)
- Dark/light theme switching (Sun/Moon icons, `prefers-color-scheme` on first visit)
- Notification backend: `NotificationService` stores history in Redis list (capped at 200), publishes via pub/sub, REST CRUD endpoints
- Notification frontend: `NotificationContext`, `NotificationDrawer`, `AlertToastGroup`, deduplication (500ms window)
- Lifecycle event integration: model deploy/fail/sleep/wake/delete, worker join/leave, stuck model recovery all generate notifications
- User dropdown with username, role, and logout action
- Sidebar footer with GitHub link and theme-aware icons
- i18n keys for all new UI strings

#### Dependencies

- Phase 3 (complete) — AppLayout, AuthContext, useEventStream, BFF SSE proxy all exist

---

### Phase 4: SIF Runner Runtime (Apptainer)

**Objective:** Deliver engine runtimes (vLLM, Triton, …) as **Apptainer SIF files** on a shared
RWX volume, executed in place by the worker — enabling fast version switching, hot-add of new
versions without recycling workers, side-by-side versions, and no per-host image copy, with GPU
access and kvcached co-tenancy intact.

**Why SIF (not EasyBuild/Lmod):** the original Highlander/EasyBuild plan ([ADR-004](../architecture/adrs/adr-004-highlander-runtime.md))
was superseded after the Phase 4 feasibility spike. A SIF is a single squashfs file = a whole
OCI image, built with the normal container toolchain (no from-source easyconfigs) and mounted
in place (no metadata storm). See [ADR-015](../architecture/adrs/adr-015-sif-runtime-packaging.md),
[ADR-016](../architecture/adrs/adr-016-sif-worker-security-posture.md), and
[ADR-017](../architecture/adrs/adr-017-runner-image-pipeline.md).

**Spike outcome:** validated GO on a live OKD 4.21 cluster (all gates green, including two vLLM
runners sharing one GPU via kvcached). Detailed runbook, findings, and the exact security posture
are in [`phase4-apptainer-spike.md`](phase4-apptainer-spike.md). The implementation task
breakdown is in [`phase4.md`](phase4.md).

#### Deliverables

| #   | Deliverable             | Description                                                                           |
| --- | ----------------------- | ------------------------------------------------------------------------------------- |
| 4.1 | Base worker image       | `containers/worker-base/` — slim UBI + Apptainer + FUSE helpers + `/etc/localtime`    |
| 4.2 | Runner image(s)         | `containers/runner-vllm/` (base vLLM + kvcached) — the image that becomes a SIF       |
| 4.3 | SIF librarian build job | CI/Job that builds+signs images and converts image→SIF onto the module PVC            |
| 4.4 | Worker security profile | Custom seccomp SCC + `/dev/fuse` annotation + Deployment/Pod shape (ADR-016)          |
| 4.5 | Worker agent SIF launch | Runner start = `apptainer exec` of the engine SIF (replaces the dev-worker stub path) |
| 4.6 | Integration test suite  | Runner start, version switch/hot-add, GPU `--nv`, kvcached co-tenancy, clean drain    |

#### Scope

- **Base worker image** — minimal UBI + accelerator driver access + Apptainer (rootless) + FUSE
  helpers; no engine baked in ([ADR-017](../architecture/adrs/adr-017-runner-image-pipeline.md))
- **Runner images** — one `containers/runner-<engine>/Containerfile` per engine; vLLM+kvcached
  is the reference
- **SIF build/sign/convert pipeline** — CI builds+scans+signs the OCI image; a librarian Job
  converts it to a signed SIF (node-local scratch) and writes it to the module PVC with versioned
  filenames
- **Worker security posture** — the mild custom SCC (seccomp `Unconfined`, no privileged/caps),
  `/dev/fuse` via `io.kubernetes.cri-o.Devices`, in-container userns (not `hostUsers: false`)
- **Worker agent SIF launch** — the production worker agent starts a runner by `apptainer exec`
  of the model's engine SIF (with `--nv`, bind-mounted weights, writable scratch); clean SIGTERM
  drain
- **Version management** — multiple engine versions coexist on one worker; hot-add a new SIF with
  no Pod restart

#### Out of Scope

- Autoscaling workers (manual provisioning initially)
- Non-RWX / block storage backends for the module store
- GPU driver management (assumes the NVIDIA GPU Operator / drivers on worker nodes)
- Replacing the dev-worker stub path (Phase 3.6) — it stays for containerless local dev

#### Definition of Done

- [ ] `containers/worker-base` and `containers/runner-vllm` build in CI; the vLLM+kvcached image
      converts to a signed SIF via the librarian job
- [ ] A worker Pod admits under the custom SCC with `/dev/fuse` present and runs `apptainer exec`
      unprivileged (spike Gates 0–3)
- [ ] The worker agent starts a real vLLM runner from a SIF on the module PVC, reads weights via
      `--bind`, serves OpenAI traffic, and drains cleanly on SIGTERM (spike Gates 4–5)
- [ ] Two engine versions run side-by-side and a new SIF hot-adds with no Pod restart (Gate 6)
- [ ] GPU is visible inside the SIF via `--nv`, and **two runners share one GPU via kvcached**
      (Gates 7–9)
- [ ] SIFs are signed by the librarian and verified at exec; the module PVC is RBAC-restricted to
      the librarian for writes
- [ ] Runtime perf is characterized on the target RWX backend (EFS proven in the spike; CephFS
      re-run recorded)

#### Dependencies

- Phase 1 (proxy) — traffic shifting for zero-downtime upgrades
- Phase 2 (control plane) — issues runner start/stop to the worker agent
- Phase 3.6 (dev worker) — the worker-agent management API and runner contract the production
  worker agent reuses
- OpenShift/OKD 4.15+ with `crun`, a shared RWX StorageClass, and GPU nodes (GPU Operator)

#### Risks

| Risk                                                    | Impact                                  | Mitigation                                                                                       |
| ------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Custom SCC (seccomp `Unconfined`) fails security review | Blocks the product default              | Productionize as a scoped seccomp profile via the Security Profiles Operator (ADR-016)           |
| Perf on the target backend (CephFS) differs from EFS    | Cold-start economics weaker than spiked | Re-run the spike's Gate 10 on CephFS/ODF; the spike numbers are a conservative (NFS-grade) floor |
| kvcached image drift (pinned commit vs. vLLM version)   | Elastic sharing breaks on upgrade       | Pin the kvcached commit per vLLM version in `containers/runner-vllm/`; test Gate 9 on every bump |
| SIF supply-chain (RWX bypasses image admission)         | Code-injection path into workers        | Sign at build, verify at exec, RBAC-lock the module PVC to the librarian (ADR-017)               |

---

### Phase 5: kvcached Oversubscription and Co-location Policy

**Objective:** Let the control plane place several models on one GPU when their runners declare
`kvCacheElasticSharing`, treating KV-cache memory as reclaimable rather than fixed. Phase 4 proved
two vLLM runners can share a GPU via kvcached (spike Gate 9); Phase 5 turns that into a placement
policy: which models may co-locate, how much oversubscription is allowed, and how eviction reacts
when a shared pool is under pressure.

**Status:** not started. Detailed scope will be written as `phase5.md` when the milestone backlog
in front of it (M13) is closed.

**Dependencies:** Phase 4 complete; measured-only VRAM telemetry (#163/#164) so pool pressure is
observed, not estimated; per-device kvcached pool reporting from the runner contract.

---

## Milestone Track

Alongside the phases, issues from the full audit (August 2026) are grouped into GitHub milestones
and executed one milestone per branch, merged to `dev`. M2 through M12 are complete; M13 is next.
The list of themes and what each delivered is maintained in [`status.md`](status.md).

---

## Cross-Cutting Concerns

These concerns span all phases and must be addressed continuously rather than in a single phase.

### OpenAPI Contract Discipline

All inter-component communication is defined by OpenAPI specs in `packages/contracts/`. The workflow — edit spec, validate, generate types, fix consumers, commit together — must be followed from Phase 0 onward. See [ADR-005](../architecture/adrs/adr-005-openapi-contracts.md).

### Testing Strategy

| Level       | Scope                              | Tooling                                                                 |
| ----------- | ---------------------------------- | ----------------------------------------------------------------------- |
| Unit        | Individual functions and modules   | Vitest (TypeScript), `cargo test` (Rust)                                |
| Integration | Component against real data stores | Vitest + test containers (TypeScript), integration test harness (Rust)  |
| E2E         | Full system workflows              | Playwright (dashboard), custom harness (proxy + control plane + runner) |

Integration tests use real Redis and PostgreSQL instances — no mocks for data stores.

### Observability

Every component exposes a Prometheus scrape endpoint from Phase 1 onward. Key metrics are defined per component in each phase's deliverables. Structured logging (JSON) is required across all components.

### CI/CD

The monorepo uses a unified Makefile. CI runs `make all` (typecheck + lint) and `make test` on every PR. OpenAPI validation (`redocly lint`) is part of the lint step. Generated types are committed to the repo so consumers don't need to run codegen.

### Security Boundaries

- The proxy does not handle authentication (handled by ingress/sidecar)
- The control plane API is internal — not exposed to end users
- The dashboard BFF enforces authentication (`simple` / `oauth` modes) and holds the control plane API token; the control plane and worker agents check shared bearer tokens as defense in depth (see [deployment security](../usage/deployment-security.md))
- Runner contract communication is cluster-internal (no public network exposure)

---

## How to Read This Plan

- **Technical contributors:** focus on the scope, deliverables, and definition of done for your phase. The architecture overview and ADRs linked throughout provide the full technical context.
- **Project managers:** use the definitions of done as acceptance criteria. The risk tables flag what to watch for in each phase.
- **Stakeholders and leadership:** the executive summary and architecture-at-a-glance sections describe what the platform does and how it's structured. The phase sequence shows what gets delivered when, and each phase's objective explains the "why."

---

**Supporting documents:**

- [Project Status](status.md) — delivered phases and milestones, what is next
- [Architecture Overview](../architecture/overview.md) — system design, diagrams, request flows
- [Architecture Decision Records](../architecture/adrs/) — rationale for every major technical choice
- [Development Setup](../development/setup.md) — how to build and run locally
- [Coding Standards](../development/coding-standards.md) — conventions for TypeScript and Rust
