# Sardeenz v2 — Architecture Overview

## Introduction

Sardeenz is a high-density GPU workload orchestration platform that solves the accelerator multi-tenancy and overcommitment problem. It enables an enterprise cluster to host and serve more accelerator-based workloads (LLMs, diffusion models, predictive models) than can fit simultaneously in device memory — without the operational overhead, latency penalties, and resource rigidity of traditional frameworks.

The core paradigm: instead of letting Kubernetes allocate accelerators per-workload at the infrastructure level (L3), Sardeenz permanently assigns accelerator blocks to persistent worker processes and manages workload placement at the application level (L7). Kubernetes sees static, warm containers. Sardeenz sees a fluid canvas of device memory that can be packed, swapped, paged, or put to sleep on the fly.

> See [ADR-001](adrs/adr-001-l7-vram-scheduling.md) for the full rationale.

## High-Level Architecture

```mermaid
graph TB
    subgraph Clients
        C1[AI Applications]
        C2[OpenAI SDKs]
        C3[Admin Users]
    end

    subgraph Platform
        subgraph "Routing Proxy (Rust)"
            P1[Proxy Replica 1]
            P2[Proxy Replica N]
        end

        CP[Control Plane<br/>TypeScript / Fastify]

        subgraph "Admin Dashboard"
            DB[Dashboard Backend<br/>TypeScript / Fastify]
            DF[Dashboard Frontend<br/>React / PatternFly 6]
        end

        subgraph "Worker Pool"
            subgraph "Worker 1"
                R1A[Runner: vLLM<br/>Model A]
                R1B[Runner: vLLM<br/>Model B]
            end
            subgraph "Worker 2"
                R2A[Runner: Triton<br/>Model C]
            end
            subgraph "Worker N"
                RNA[Runner: vLLM<br/>Model D]
            end
        end
    end

    subgraph "Data Stores"
        RD[(Redis / Valkey<br/>Real-time State)]
        PG[(PostgreSQL<br/>Persistent Config)]
        PR[(Prometheus<br/>Metrics)]
    end

    subgraph "Shared Storage (RWX)"
        MW[Model Weights<br/>RWX]
        AM[Runner SIF Modules<br/>RWX]
    end

    C1 & C2 -->|inference| P1 & P2
    C3 -->|admin| DF
    DF --> DB
    DB -->|commands| CP
    DB -->|state| RD
    DB -->|metrics| PR
    P1 & P2 -->|routing map| RD
    P1 & P2 -->|inference| R1A & R1B & R2A & RNA
    P1 & P2 -.->|wake trigger| CP
    CP -->|orchestration state| RD
    CP -->|config| PG
    CP -->|lifecycle| R1A & R1B & R2A & RNA
    R1A & R1B & R2A & RNA -->|device memory usage| RD
    R1A & R1B & R2A & RNA -->|weights| MW
    R1A & R1B & R2A & RNA -->|exec SIF| AM
```

The platform comprises four main components, three data stores, and a shared storage fabric. Each component has a strict responsibility boundary and communicates through well-defined interfaces.

> See [ADR-002](adrs/adr-002-four-component-split.md) for the component split rationale.

## Component Details

### Routing Proxy

|              |                                             |
| ------------ | ------------------------------------------- |
| **Language** | Rust (axum / tokio)                         |
| **Role**     | Stateless, high-performance request routing |
| **Scaling**  | Multiple replicas behind a load balancer    |

The proxy sits on the critical path of every inference request. It reads a routing map from Redis/Valkey to resolve which worker and runner should handle each request, then forwards the traffic.

Key capabilities:

- **Protocol modularity.** Initially supports OpenAI-compatible traffic (for vLLM). The architecture accommodates additional serving protocols (e.g., MLServer for predictive models) as new model types are added.
- **Connection parking.** When a request targets a sleeping model, the proxy holds the client connection open and fires a wake-up trigger to the control plane. Once the model is ready, the proxy seamlessly connects the client to the live engine stream.
- **Thundering herd prevention.** If multiple requests hit the same sleeping model simultaneously, only the first triggers a wake-up. Subsequent requests are parked without redundant control plane calls.
- **Cluster forwarding.** Routes requests across workers with weighted round-robin and circuit breaking.

> See [ADR-003](adrs/adr-003-rust-proxy.md) for the Rust choice rationale.

### Control Plane

|              |                                                 |
| ------------ | ----------------------------------------------- |
| **Language** | TypeScript (Fastify)                            |
| **Role**     | Orchestration, scheduling, lifecycle management |
| **Scaling**  | Single leader with standby failover (K8s Lease) |

The control plane is the brain of the system. It does not serve inference traffic — it makes decisions about where workloads run and how device memory is allocated.

Key responsibilities:

- **Device memory budget tracking.** Maintains a global view of device memory allocation across all workers, built from worker self-reports in Redis/Valkey. Reports carry two distinct figures per device: the _allocation ledger_ (sum of running runners' configured `requiredMemory` — the basis for placement and eviction) and, where the worker can measure (NVML via ts-nvml, #163), the _measured_ usage including per-instance attribution — surfaced as telemetry (`currentMemory`, per-device measured bytes) but never fed into budget math.
- **Model lifecycle state machine.** Manages model states (starting, active, sleeping, stopping) and transitions.
- **Eviction.** When device memory is constrained, applies an eviction strategy (initially LRU, behind a pluggable interface) to free capacity by sleeping or stopping models.
- **Sleep/wake coordination.** Sends sleep and wake commands to runners through the runner contract.
- **Workload placement.** Matches model requirements → compatible runner type → capable worker → best candidate (see [Worker and Runner Model](#worker-and-runner-model)). Operators can also move one active instance to an explicit compatible worker and device set. A durable transaction creates a healthy replacement, atomically sets the old endpoint's weight to zero, waits for every serving proxy to apply and quiesce the old routing generation, then drains and stops the source; leader reconciliation resumes any interrupted phase.
- **Routing map management.** Writes the routing map to Redis/Valkey, which the proxy consumes.
- **Worker pool management.** Detects workers joining or leaving the pool dynamically without requiring a restart.
- **Runner catalog + SIF import.** Loads a catalog of available runner SIFs and imports them on demand by pulling signed SIFs from an OCI registry (ORAS) onto the shared module store — see [ADR-018](adrs/adr-018-runner-catalog-oras-distribution.md).

### Admin Dashboard

|              |                                                          |
| ------------ | -------------------------------------------------------- |
| **Frontend** | React 18 + PatternFly 6 + Vite                           |
| **Backend**  | TypeScript (Fastify) — BFF pattern                       |
| **Scaling**  | Single replica by default, stateless, scalable on demand |

The dashboard is a backend + frontend pair. The backend acts as a BFF (backend-for-frontend), aggregating data from multiple sources independently — it is not a pass-through to the control plane.

Data sources:

- **Control plane API** — for orchestration commands (deploy model, trigger sleep/wake, apply presets)
- **Redis / Valkey** — for real-time cluster state (model states, device memory usage, topology)
- **Prometheus** — for metrics visualization (inference latency, throughput, device utilization)

This independence means the dashboard can display cluster state and metrics even during a brief control plane failover.

### Engine Runners

|                          |                                    |
| ------------------------ | ---------------------------------- |
| **Role**                 | Engine-specific workload execution |
| **First implementation** | vLLM runner (reference)            |

Each worker runs a three-layer process architecture:

1. **Worker agent** — a long-lived management process inside the worker Pod. It self-registers to Redis/Valkey (capabilities, devices, heartbeat), receives commands from the control plane to start and stop runners, and exposes an HTTP management API (`POST /runners`, `DELETE /runners/{runnerId}`).

2. **Runner** — a separate process spawned by the worker agent, one per model **instance**. A logical model may have several instances (replicas) — including more than one on the same worker — each with its own runner process (see [ADR-019](adrs/adr-019-logical-model-vs-instance-split.md)). Each runner is a thin engine-specific shim that:
   - Executes its engine **SIF** in place — `apptainer exec --nv /modules/<engine>-<version>.sif <serve cmd>` — from the shared RWX module store (no per-host copy)
   - Runs the actual engine as the exec'd process
   - Exposes the runner contract HTTP API (`/health`, `/sleep`, `/wake`, `/memory-report`) on its own port

3. **Engine** (vLLM, Triton, etc.) — the unmodified inference engine, packaged in the SIF and run by `apptainer exec`. The engine has no knowledge of Sardeenz.

The runner is the isolation boundary — each runner exec's its own self-contained SIF (its own filesystem and userland), allowing different engine types and versions to coexist on the same worker. See [Why runners are separate processes](#why-runners-are-separate-processes) for the rationale.

> See [ADR-015](adrs/adr-015-sif-runtime-packaging.md) for the SIF runtime-delivery decision.

**The runner contract** defines the HTTP endpoints each runner exposes:

- **Health checking** — readiness detection, state reporting
- **Memory reporting** — per-device memory consumption
- **Sleep/wake support** — memory offload API (optional, not all engines support this)
- **Progress reporting** — structured loading progress
- **Capability declaration** — supported platform features (tensor parallelism, sleep levels, model types)

Process lifecycle (start, stop, drain) is a worker-level concern — the worker agent manages runner processes, and the control plane manages the routing map.

> See [ADR-010](adrs/adr-010-engine-runners.md) for the runner abstraction design. See [`components/runner-contract.md`](components/runner-contract.md) for the full contract specification.

## Data Architecture

```mermaid
graph LR
    subgraph Writers
        CP_W[Control Plane]
        WK_W[Workers]
        ALL[All Components]
    end

    subgraph "Redis / Valkey"
        RM[Routing Map]
        MS[Instance States]
        MB[Memory Budgets]
        CT[Cluster Topology]
        DU[Device Memory Usage]
    end

    subgraph PostgreSQL
        CFG[Configurations]
        BM[Benchmarks]
        MP[Memory Profiles]
        ST[Settings]
    end

    subgraph Prometheus
        IL[Inference Latency]
        TP[Throughput]
        DV[Device Utilization]
        CH[Component Health]
    end

    subgraph Readers
        PX[Proxy]
        DB_R[Dashboard Backend]
        CP_R[Control Plane]
    end

    CP_W -->|writes| RM & MS & MB & CT
    WK_W -->|pushes| DU
    CP_W -->|reads/writes| CFG & BM & MP & ST
    ALL -.->|scrape endpoints| IL & TP & DV & CH

    RM & MS & MB & CT & DU -->|reads| PX
    RM & MS & MB & CT & DU -->|reads| DB_R
    RM & MS & MB & CT & DU -->|reads| CP_R
    CFG & BM & MP & ST -->|reads| DB_R
    IL & TP & DV & CH -->|queries| DB_R
```

Data is split across three purpose-matched stores:

| Store              | What                                                                                                                 | Why                                                                                                                                                   |
| ------------------ | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Redis / Valkey** | Routing map, instance lifecycle states, device memory budgets, worker-reported device memory usage, cluster topology | Sub-millisecond reads for the proxy. Pub/sub for state change notifications. Workers push their own device memory data, inverting v1's polling model. |
| **PostgreSQL**     | Configurations, instance placement ledger, benchmarks, memory profiles, persistent settings                          | Durability, queryability, transactional guarantees for data that must survive restarts.                                                               |
| **Prometheus**     | Inference metrics, device utilization, proxy stats, component health                                                 | Time-series collection via scrape endpoints. Dashboard reads directly for monitoring views.                                                           |

> See [ADR-009](adrs/adr-009-state-and-persistence.md) for the full rationale.

**Model configuration (logical model) vs. instance.** A _model configuration_ (Postgres `models` —
config: runner type, weights path, memory requirement, etc.) may have zero or more _instances_ (one
runner process on one worker each, with its own lifecycle state, VRAM reservation, and routing
endpoint — identified by a control-plane-minted `instanceId`). A configuration carries distinct
name concepts: its unique _configuration name_ (wire field `modelName` — the routing key clients
send in the OpenAI `model` field), an optional _served model name_ (the identity the engine
reports in metrics and responses; defaults to the configuration name), an optional _display name_
(free-form dashboard label, presentation only), and the _model path_ (the weights reference) — see
[ADR-020](adrs/adr-020-config-name-vs-served-model-name.md).
Instance lifecycle state lives in Redis, one key per instance (`{prefix}:models:{modelName}:{instanceId}`); a lightweight
Postgres `instances` table is the durable identity/placement ledger, written at instance create/
delete. The model's own state (`ACTIVE`, `SLEEPING`, etc., as surfaced by the API and dashboard) is
derived from its instances on read — the highest-precedence state present, with `ACTIVE` outranking
`ERROR` so one healthy replica masks a broken one. See [ADR-019](adrs/adr-019-logical-model-vs-instance-split.md).

## Worker and Runner Model

```mermaid
graph TB
    CP[Control Plane]

    subgraph "Worker 1 (Pod)"
        direction TB
        W1_CAP["Capabilities:<br/>2x GPU (80GB each)<br/>Architecture: Ampere"]
        R1A["Runner: vLLM 0.19.1<br/>Model A (LLM, 14GB)"]
        R1B["Runner: vLLM 0.20.0<br/>Model B (LLM, sleeping)"]
    end

    subgraph "Worker 2 (Pod)"
        direction TB
        W2_CAP["Capabilities:<br/>1x GPU (24GB)<br/>Architecture: Ada"]
        R2A["Runner: Triton<br/>Model C (predictive)"]
    end

    subgraph "Worker 3 (Pod)"
        direction TB
        W3_CAP["Capabilities:<br/>CPU only<br/>16 cores, 64GB RAM"]
        R3A["Runner: MLServer<br/>Model D (sklearn)"]
    end

    CP -->|"lifecycle commands"| R1A & R1B & R2A & R3A
    W1_CAP & W2_CAP & W3_CAP -.->|"capability + memory reports"| RD[(Redis / Valkey)]
    CP -->|"reads capabilities"| RD
```

**Workers** are long-lived Pods with one or more accelerators (or CPU capacity). Each worker runs a **worker agent** process that manages the runners on that node.

**Runners** are short-lived relative to workers — started, stopped, slept, and woken by the control plane. Each runner is typed to a specific engine and runs a single workload.

### Process Tree

Each worker Pod runs a worker agent that spawns and supervises runners. Each runner exec's its own engine SIF from the shared module store:

```text
Worker agent (long-lived, manages everything)
├── Runner A: apptainer exec --nv vllm-0.19.1.sif → serve model X on :5001
├── Runner B: apptainer exec --nv vllm-0.20.0.sif → serve model Y on :5002
└── Runner C: apptainer exec --nv triton-2.40.sif → serve model Z on :5003
```

### Communication Channels

| Channel                       | Direction            | Purpose                                                                 |
| ----------------------------- | -------------------- | ----------------------------------------------------------------------- |
| Control plane → Worker agent  | Process management   | `POST /runners` to start a runner, `DELETE /runners/{id}` to stop one   |
| Control plane → Runner        | Lifecycle management | `/health`, `/sleep`, `/wake` — the runner contract                      |
| Proxy → Runner                | Inference traffic    | Direct request forwarding, no control plane involvement on the hot path |
| Worker agent → Redis / Valkey | Self-registration    | Capabilities, devices, heartbeat, management URL                        |

### Why Runners Are Separate Processes

The key constraint is **runtime isolation**. Running multiple engines or engine versions on the same worker requires each to have its own filesystem, libraries, and Python environment. A separate process per runner provides this naturally — each runner `apptainer exec`s its own **SIF**, a single self-contained squashfs image with the full engine userland, mounted read-only in the runner's own mount namespace. Different engine types and versions coexist with zero cross-contamination, and none of it is baked into the worker image.

> See [ADR-015](adrs/adr-015-sif-runtime-packaging.md) for the SIF runtime-delivery decision and [ADR-010](adrs/adr-010-engine-runners.md) for the runner abstraction design.

### Workload Placement

When a model deployment request arrives, the control plane resolves a multi-level matching problem:

```mermaid
flowchart TD
    REQ[Deploy Model X<br/>Type: LLM, needs GPU] --> S1

    S1[1. Runner Type Selection<br/>Which runners can serve LLMs?] --> S1R[vLLM runner ✓<br/>Triton runner ✗<br/>MLServer runner ✗]
    S1R --> S2

    S2[2. Hardware Filtering<br/>Which workers have compatible GPUs?] --> S2R[Worker 1 ✓ Ampere GPU<br/>Worker 2 ✓ Ada GPU<br/>Worker 3 ✗ CPU only]
    S2R --> S3

    S3[3. Capacity Filtering<br/>Which have enough device memory?] --> S3R[Worker 1 ✓ 52GB free<br/>Worker 2 ✗ 3GB free]
    S3R --> S4

    S4[4. Placement Strategy<br/>Select best candidate] --> S4R[Worker 1 selected<br/>Most available capacity]
    S4R --> DEPLOY[Start vLLM runner<br/>on Worker 1]
```

Workers self-report their capabilities and device memory usage to Redis/Valkey. The control plane reads this data to build its placement decisions — it does not poll workers directly.

> See [ADR-011](adrs/adr-011-worker-capabilities-and-placement.md) for the full placement design, including its relationship to infrastructure-level schedulers.

## Request Flows

The proxy serves two protocol-family path prefixes on its inference port: `/openai/v1/*` (OpenAI-
compatible, shown below) and `/oip/v2/*` (KServe V2 Open Inference Protocol, e.g. MLServer models).
See [ADR-021](adrs/adr-021-protocol-family-path-prefixes.md) and
[`components/proxy.md`](components/proxy.md#overview) for the full endpoint surface.

### Inference Request — Model is Active

```mermaid
sequenceDiagram
    participant Client
    participant Proxy
    participant Redis as Redis / Valkey
    participant Runner as Runner (vLLM)

    Client->>Proxy: POST /openai/v1/chat/completions<br/>{model: "llama-3"}
    Proxy->>Redis: Lookup routing map<br/>for "llama-3"
    Redis-->>Proxy: Worker 1, port 5001<br/>State: ACTIVE
    Proxy->>Runner: Forward request
    Runner-->>Proxy: SSE stream (chunks)
    Proxy-->>Client: SSE stream (chunks)
```

The proxy resolves the target from the routing map in Redis/Valkey and forwards directly. No control plane involvement on the hot path.

### Inference Request — Model is Sleeping

```mermaid
sequenceDiagram
    participant Client
    participant Proxy
    participant Redis as Redis / Valkey
    participant CP as Control Plane
    participant Runner as Runner (vLLM)

    Client->>Proxy: POST /openai/v1/chat/completions<br/>{model: "llama-3"}
    Proxy->>Redis: Lookup routing map
    Redis-->>Proxy: State: SLEEPING

    Note over Proxy: Park connection,<br/>hold client payload

    Proxy->>CP: Wake trigger for "llama-3"
    Note over CP: Evaluate memory budget,<br/>evict if needed

    CP->>Runner: Wake command
    Runner-->>CP: Ready
    CP->>Redis: Update state → ACTIVE

    Redis-->>Proxy: State change notification<br/>(pub/sub)
    Proxy->>Runner: Forward held request
    Runner-->>Proxy: SSE stream
    Proxy-->>Client: SSE stream
```

The proxy parks the client connection while the model wakes. If multiple clients request the same sleeping model, the thundering herd mechanism ensures only one wake trigger reaches the control plane.

### Model Deployment

```mermaid
sequenceDiagram
    participant Admin
    participant Dashboard as Dashboard Backend
    participant CP as Control Plane
    participant Redis as Redis / Valkey
    participant Worker
    participant Runner

    Admin->>Dashboard: Deploy "llama-3"<br/>with requirements
    Dashboard->>CP: Deployment request

    Note over CP: Placement pipeline:<br/>1. Select runner type<br/>2. Filter by hardware<br/>3. Filter by capacity<br/>4. Apply strategy

    CP->>Worker: Start vLLM runner<br/>for "llama-3"
    Worker->>Runner: apptainer exec vllm-0.19.1.sif<br/>→ serve process

    Runner-->>CP: Health: ready
    CP->>Redis: Update routing map<br/>+ model state: ACTIVE
    CP-->>Dashboard: Deployment complete
    Dashboard-->>Admin: Model active
```

### Eviction Under Memory Pressure

```mermaid
sequenceDiagram
    participant CP as Control Plane
    participant Redis as Redis / Valkey
    participant RunnerA as Runner A (target)
    participant RunnerB as Runner B (victim)

    Note over CP: Deployment requested,<br/>not enough device memory

    CP->>Redis: Read device memory<br/>across workers
    Note over CP: LRU eviction:<br/>Runner B least recently used

    CP->>RunnerB: Sleep command<br/>(L1: offload to host RAM)
    RunnerB-->>CP: Sleep complete
    CP->>Redis: Update Runner B<br/>state → SLEEPING

    Note over CP: Capacity freed,<br/>proceed with deployment

    CP->>RunnerA: Start on freed capacity
    RunnerA-->>CP: Ready
    CP->>Redis: Update routing map<br/>+ Runner A state: ACTIVE
```

## Runtime Delivery — Apptainer SIF

Engine runtimes are not baked into worker container images, nor loaded as Lmod modules
(the original Highlander/EasyBuild plan — see [ADR-004](adrs/adr-004-highlander-runtime.md),
superseded). Instead, each runtime is packaged as an **Apptainer SIF** — a single squashfs file
containing a whole OCI image — stored on a shared RWX volume and executed in place with
`apptainer exec`. A "runner module" is one `.sif` file.

```mermaid
graph LR
    subgraph "Build Time (CI + librarian job)"
        CF[containers/runners/vllm/0.21.0/<br/>Containerfile]
        IMG[OCI image<br/>build + scan + sign]
        SIF[apptainer build/pull<br/>+ apptainer sign]
        CF -->|CI build| IMG
        IMG -->|convert| SIF
    end

    subgraph "Shared Storage (RWX)"
        subgraph "SIF Module Store"
            V1[vllm-0.19.1.sif]
            V2[vllm-0.20.0.sif]
            TR[triton-2.3.sif]
        end
        subgraph "Model Weights"
            MW1[llama-3-8b/]
            MW2[mistral-7b/]
        end
    end

    SIF -->|write signed SIF| V1 & V2 & TR

    subgraph "Worker (slim container + Apptainer)"
        OS[Base OS + accelerator drivers + Apptainer]
        PROC[Runner process]
        OS -->|"apptainer exec --nv vllm-0.20.0.sif"| PROC
    end

    V2 -.->|squashfuse mount, read-only| PROC
    MW1 -.->|bind mount| PROC
```

Worker container images are slim — base OS, accelerator drivers, and Apptainer
(`containers/worker-base/`). When the control plane instructs a worker to start a runner, the
worker `apptainer exec`s the engine SIF straight off the shared volume; `squashfuse` mounts it
read-only and pages it in lazily (no per-host copy, no metadata storm).

This enables:

- **Fast engine iteration** — drop a new `.sif` on the volume; no container rebuild cycle
- **Hot-add without recycling workers** — a new SIF is runnable immediately, no Pod restart
- **Zero-downtime upgrades** — new version execs as a parallel process, proxy shifts traffic, old process drains
- **Canary / A/B testing** — two engine versions serve traffic side-by-side from the same worker

Runner `Containerfile`s and the base worker image live in this repository under `containers/`,
making Sardeenz fully self-contained. The SIFs are built, signed, and published by Sardeenz's
own pipeline; workers verify signatures at exec.

> See [ADR-015](adrs/adr-015-sif-runtime-packaging.md) (SIF delivery),
> [ADR-016](adrs/adr-016-sif-worker-security-posture.md) (the mild SCC + `/dev/fuse` posture),
> and [ADR-017](adrs/adr-017-runner-image-pipeline.md) (build/sign/convert pipeline). The Phase 4
> feasibility spike that validated this is [`docs/project/phase4-apptainer-spike.md`](../project/phase4-apptainer-spike.md).

## Scaling and Redundancy

```mermaid
graph TB
    LB[Load Balancer / Ingress]

    subgraph "Proxy (stateless, N replicas)"
        P1[Replica 1]
        P2[Replica 2]
        PN[Replica N]
    end

    subgraph "Control Plane (leader/standby)"
        CPL[Leader]
        CPS[Standby]
        CPL -.->|K8s Lease| CPS
    end

    subgraph "Dashboard (stateless, 1 by default)"
        D1[Replica 1]
    end

    subgraph "Workers (dynamic pool)"
        W1[Worker 1]
        W2[Worker 2]
        WN[Worker N]
    end

    LB --> P1 & P2 & PN
    CPL --> W1 & W2 & WN
```

Each component scales according to its workload profile:

| Component           | Strategy                                           | Rationale                                                                                                              |
| ------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **Routing Proxy**   | Multiple stateless replicas behind a load balancer | On the critical path of every request. Horizontally scalable.                                                          |
| **Control Plane**   | Single leader with standby failover (K8s Lease)    | Coordination workload is moderate. Leader/standby avoids multi-writer complexity. Inference continues during failover. |
| **Admin Dashboard** | Single replica by default, stateless and scalable  | Doesn't affect inference. Scales to multiple replicas without code changes if needed.                                  |
| **Workers**         | Dynamic pool, manual provisioning initially        | Workers join/leave without control plane restart. Extensible to autoscaling later.                                     |

> See [ADR-007](adrs/adr-007-redundancy-and-scaling.md) for the full scaling rationale.

## Cross-Language Contracts

The Rust proxy and TypeScript components share type definitions through OpenAPI specifications maintained in `packages/contracts/`.

```mermaid
graph LR
    SPEC[packages/contracts/<br/>OpenAPI Specs] -->|openapi-generator<br/>or utoipa| RUST[Rust structs<br/>+ serde]
    SPEC -->|openapi-typescript| TS_CP[TypeScript types<br/>Control Plane]
    SPEC -->|openapi-typescript| TS_DB[TypeScript types<br/>+ fetch client<br/>Dashboard]

    CI[CI Pipeline] -->|validates sync| SPEC
```

Contracts cover:

- **Proxy ↔ Control Plane** — routing map schema, model states, wake-up trigger API
- **Dashboard ↔ Control Plane** — model lifecycle operations, device memory budgets, cluster state, event streams
- **Engine Runner Contract** — health check, memory reporting, lifecycle signals, capability declaration

The workflow: edit the OpenAPI spec → run code generation → TypeScript types are regenerated automatically. Rust types in `proxy/src/generated/` are hand-maintained to match the specs (see `docs/project/phase1.md` task 1.3 for rationale).

> See [ADR-005](adrs/adr-005-openapi-contracts.md) for the contract strategy rationale.

## ADR Index

| ADR                                                          | Decision                                                                                 |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| [ADR-001](adrs/adr-001-l7-vram-scheduling.md)                | Software-defined device memory scheduling at Layer 7                                     |
| [ADR-002](adrs/adr-002-four-component-split.md)              | Four-component architecture split                                                        |
| [ADR-003](adrs/adr-003-rust-proxy.md)                        | Rust for the routing proxy                                                               |
| [ADR-004](adrs/adr-004-highlander-runtime.md)                | Highlander runtime integration with self-contained easyconfigs _(superseded by ADR-015)_ |
| [ADR-005](adrs/adr-005-openapi-contracts.md)                 | OpenAPI as cross-language contract                                                       |
| [ADR-006](adrs/adr-006-new-platform.md)                      | New platform vs. v1 refactor                                                             |
| [ADR-007](adrs/adr-007-redundancy-and-scaling.md)            | Redundancy and scaling strategy                                                          |
| [ADR-008](adrs/adr-008-monorepo.md)                          | Monorepo structure                                                                       |
| [ADR-009](adrs/adr-009-state-and-persistence.md)             | Shared state and persistence strategy                                                    |
| [ADR-010](adrs/adr-010-engine-runners.md)                    | Engine runners                                                                           |
| [ADR-011](adrs/adr-011-worker-capabilities-and-placement.md) | Worker capabilities and workload placement                                               |
| [ADR-012](adrs/adr-012-typescript-stack.md)                  | TypeScript stack for control plane and dashboard                                         |
| [ADR-013](adrs/adr-013-secrets-management.md)                | Secrets management policy                                                                |
| [ADR-014](adrs/adr-014-inference-recency-tracking.md)        | Inference recency tracking for LRU eviction                                              |
| [ADR-015](adrs/adr-015-sif-runtime-packaging.md)             | Engine runtime delivery via Apptainer SIF on shared RWX storage                          |
| [ADR-016](adrs/adr-016-sif-worker-security-posture.md)       | Worker security posture for SIF execution                                                |
| [ADR-017](adrs/adr-017-runner-image-pipeline.md)             | Runner image build and supply chain _(amended by ADR-018)_                               |
| [ADR-018](adrs/adr-018-runner-catalog-oras-distribution.md)  | Runner catalog and ORAS distribution _(amends ADR-017)_                                  |
| [ADR-019](adrs/adr-019-logical-model-vs-instance-split.md)   | Logical model vs. instance split _(refines ADR-014)_                                     |
| [ADR-020](adrs/adr-020-config-name-vs-served-model-name.md)  | Configuration name vs. served model name _(refines ADR-019; amended by ADR-021)_         |
| [ADR-021](adrs/adr-021-protocol-family-path-prefixes.md)     | Protocol-family path prefixes for multi-protocol runners _(amends ADR-020)_              |

---

**Note:** The [original design brief](archive/refactor-brief.md) that seeded this project is preserved in the archive for historical reference. Architecture and scope have evolved since; this overview and the ADRs above are the current source of truth.
