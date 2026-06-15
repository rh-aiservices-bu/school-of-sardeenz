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

    subgraph "Shared Storage (CephFS)"
        MW[Model Weights<br/>RWX]
        AM[Application Modules<br/>ROX]
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
    R1A & R1B & R2A & RNA -->|engine modules| AM
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

- **Device memory budget tracking.** Maintains a global view of device memory allocation across all workers, built from worker self-reports in Redis/Valkey.
- **Model lifecycle state machine.** Manages model states (starting, active, sleeping, stopping) and transitions.
- **Eviction.** When device memory is constrained, applies an eviction strategy (initially LRU, behind a pluggable interface) to free capacity by sleeping or stopping models.
- **Sleep/wake coordination.** Sends sleep and wake commands to runners through the runner contract.
- **Workload placement.** Matches model requirements → compatible runner type → capable worker → best candidate (see [Worker and Runner Model](#worker-and-runner-model)).
- **Routing map management.** Writes the routing map to Redis/Valkey, which the proxy consumes.
- **Worker pool management.** Detects workers joining or leaving the pool dynamically without requiring a restart.

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

2. **Runner** — a separate process spawned by the worker agent, one per model. Each runner is a thin engine-specific shim that:
   - Runs `module load <engine>/<version>` to set up its isolated Lmod environment
   - Spawns the actual engine process as a child
   - Exposes the runner contract HTTP API (`/health`, `/sleep`, `/wake`, `/memory-report`) on its own port

3. **Engine** (vLLM, Triton, etc.) — the unmodified inference engine, started and managed by its parent runner. The engine has no knowledge of Sardeenz.

The runner is the isolation boundary — each runner has its own Lmod environment, allowing different engine types and versions to coexist on the same worker. See [Why runners are separate processes](#why-runners-are-separate-processes) for the rationale.

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
        MS[Model States]
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

| Store              | What                                                                                                    | Why                                                                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Redis / Valkey** | Routing map, model states, device memory budgets, worker-reported device memory usage, cluster topology | Sub-millisecond reads for the proxy. Pub/sub for state change notifications. Workers push their own device memory data, inverting v1's polling model. |
| **PostgreSQL**     | Configurations, benchmarks, memory profiles, persistent settings                                        | Durability, queryability, transactional guarantees for data that must survive restarts.                                                               |
| **Prometheus**     | Inference metrics, device utilization, proxy stats, component health                                    | Time-series collection via scrape endpoints. Dashboard reads directly for monitoring views.                                                           |

> See [ADR-009](adrs/adr-009-state-and-persistence.md) for the full rationale.

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

Each worker Pod runs a worker agent that spawns and supervises runners. Each runner loads its own Lmod environment and spawns its engine as a child process:

```text
Worker agent (long-lived, manages everything)
├── Runner A: module load vllm/0.19.1 → spawn vLLM → serve model X on :5001
├── Runner B: module load vllm/0.20.0 → spawn vLLM → serve model Y on :5002
└── Runner C: module load triton/2.40 → spawn Triton → serve model Z on :5003
```

### Communication Channels

| Channel                          | Direction                | Purpose                                                                      |
| -------------------------------- | ------------------------ | ---------------------------------------------------------------------------- |
| Control plane → Worker agent     | Process management       | `POST /runners` to start a runner, `DELETE /runners/{id}` to stop one        |
| Control plane → Runner           | Lifecycle management     | `/health`, `/sleep`, `/wake` — the runner contract                           |
| Proxy → Runner                   | Inference traffic        | Direct request forwarding, no control plane involvement on the hot path      |
| Worker agent → Redis / Valkey    | Self-registration        | Capabilities, devices, heartbeat, management URL                             |

### Why Runners Are Separate Processes

The key constraint is **Lmod environment isolation**. Lmod works by modifying `PATH`, `LD_LIBRARY_PATH`, `PYTHONPATH`, and other environment variables in the shell environment. Running multiple engines or engine versions on the same worker requires each to have its own isolated environment. A separate process per runner provides this naturally — each runner does its own `module load` and inherits the resulting environment. Trying to manage per-model environments within a single worker agent process would be fragile and fight against how Lmod is designed.

> See [ADR-004](adrs/adr-004-highlander-runtime.md) for the Highlander integration rationale and [ADR-010](adrs/adr-010-engine-runners.md) for the runner abstraction design.

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

### Inference Request — Model is Active

```mermaid
sequenceDiagram
    participant Client
    participant Proxy
    participant Redis as Redis / Valkey
    participant Runner as Runner (vLLM)

    Client->>Proxy: POST /v1/chat/completions<br/>{model: "llama-3"}
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

    Client->>Proxy: POST /v1/chat/completions<br/>{model: "llama-3"}
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
    Worker->>Runner: module load vllm/0.19.1<br/>→ spawn process

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

## Highlander Runtime

Engine runtimes are not baked into container images. Instead, workers use the Highlander model: runtimes are packaged as Lmod environment modules via EasyBuild and stored on shared network storage.

```mermaid
graph LR
    subgraph "Build Time"
        EC[easyconfigs/]
        EB[EasyBuild]
        EC -->|build| EB
    end

    subgraph "CephFS (Shared Storage)"
        subgraph "App Modules (ROX)"
            V1[vllm/0.19.1/]
            V2[vllm/0.20.0/]
            TR[triton/2.3/]
            KC[kvcached/0.1.5/]
        end
        subgraph "Model Weights (RWX)"
            MW1[llama-3-8b/]
            MW2[mistral-7b/]
        end
    end

    EB -->|deploy| V1 & V2 & TR & KC

    subgraph "Worker (slim container)"
        OS[Base OS + accelerator drivers]
        LMOD[Lmod]
        PROC[Runner process]
        LMOD -->|"module load vllm/0.19.1"| PROC
    end

    V1 -.->|mount| LMOD
    MW1 -.->|mount| PROC
```

Worker container images are slim — just a base OS and accelerator drivers. When the control plane instructs a worker to start a runner, the worker invokes `module load <engine>/<version>` to compose the runtime environment, then spawns the engine process.

This enables:

- **Fast engine iteration** — switch versions in seconds, not container rebuild cycles
- **Zero-downtime upgrades** — new version spawns as a parallel process, proxy shifts traffic, old process drains
- **Canary / A/B testing** — two engine versions serve traffic side-by-side from the same worker

Easyconfigs and the base worker container image live in this repository, making Sardeenz fully self-contained.

> See [ADR-004](adrs/adr-004-highlander-runtime.md) for the full Highlander integration rationale.

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

| ADR                                                          | Decision                                                       |
| ------------------------------------------------------------ | -------------------------------------------------------------- |
| [ADR-001](adrs/adr-001-l7-vram-scheduling.md)                | Software-defined device memory scheduling at Layer 7           |
| [ADR-002](adrs/adr-002-four-component-split.md)              | Four-component architecture split                              |
| [ADR-003](adrs/adr-003-rust-proxy.md)                        | Rust for the routing proxy                                     |
| [ADR-004](adrs/adr-004-highlander-runtime.md)                | Highlander runtime integration with self-contained easyconfigs |
| [ADR-005](adrs/adr-005-openapi-contracts.md)                 | OpenAPI as cross-language contract                             |
| [ADR-006](adrs/adr-006-new-platform.md)                      | New platform vs. v1 refactor                                   |
| [ADR-007](adrs/adr-007-redundancy-and-scaling.md)            | Redundancy and scaling strategy                                |
| [ADR-008](adrs/adr-008-monorepo.md)                          | Monorepo structure                                             |
| [ADR-009](adrs/adr-009-state-and-persistence.md)             | Shared state and persistence strategy                          |
| [ADR-010](adrs/adr-010-engine-runners.md)                    | Engine runners                                                 |
| [ADR-011](adrs/adr-011-worker-capabilities-and-placement.md) | Worker capabilities and workload placement                     |
| [ADR-012](adrs/adr-012-typescript-stack.md)                  | TypeScript stack for control plane and dashboard               |

---

**Note:** The [original design brief](archive/refactor-brief.md) that seeded this project is preserved in the archive for historical reference. Architecture and scope have evolved since; this overview and the ADRs above are the current source of truth.
