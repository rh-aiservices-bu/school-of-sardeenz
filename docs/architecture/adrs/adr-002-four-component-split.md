# ADR-002: Four-Component Architecture Split

## Status

Accepted

## Context

Sardeenz v1 runs as a single Fastify process that handles everything: API control, inference proxying, model lifecycle management, and serving the frontend. This monolithic design was appropriate for a prototype — fast to iterate, simple to deploy — but it creates several problems as the platform evolves:

- **Blast radius.** A bug or resource exhaustion in one concern (e.g., a memory leak during model loading) can take down the entire system, including active inference streams.
- **Scaling constraints.** The proxy sits on the critical path of every inference request, but it cannot be scaled independently from the control plane or the dashboard.
- **Language lock-in.** The entire system must be written in the same language, even when a different one would be a significantly better fit for a specific concern (e.g., high-throughput connection handling).
- **Engine coupling.** V1 is tightly coupled to vLLM — process spawn commands, health polling, log parsing, sleep/wake APIs are all hardcoded. Supporting additional engines or accelerator types would mean threading conditionals throughout the codebase.

## Decision

The platform is split into four strictly decoupled components, each with a clear responsibility boundary:

| Component           | Role                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Routing Proxy**   | Stateless, high-performance proxy with a modular architecture. Initially supports OpenAI-compatible traffic (vLLM), but designed to accommodate additional model serving protocols (e.g., MLServer for predictive models) as new model types are added. Handles request routing, connection parking, cluster forwarding, circuit breaking. On the critical path — optimized for throughput and latency. |
| **Control Plane**   | Manages the global topology: device memory budgets, model lifecycle state machine, eviction strategies, sleep/wake coordination, cluster orchestration. The brain of the system.                                                                                                                                                                                                                        |
| **Admin Dashboard** | Backend + frontend pair. The frontend is a web UI for model management, device memory visualization, cluster monitoring, and operational tooling. The backend acts as a BFF (backend-for-frontend), aggregating data from multiple sources independently — it is not a pass-through to the control plane.                                                                                               |
| **Engine Runners**  | Abstraction layer that encapsulates engine-specific behavior (health checks, memory reporting, lifecycle signals, sleep/wake support) behind a common contract. Each supported engine (vLLM, Triton, diffusion pipelines, etc.) implements this contract. See [ADR-010](adr-010-engine-runners.md).                                                                                                     |

Components communicate through well-defined APIs and shared infrastructure:

- **Redis / Valkey** serves as the shared real-time state store. The control plane writes orchestration state (routing map, model states, device memory budgets, cluster topology); workers push their own device memory usage directly. The proxy and dashboard backend read from it. This avoids coupling consumers to the control plane API for high-frequency state reads.
- **PostgreSQL** provides durable persistence for configurations, benchmarks, memory profiles, and other data that must survive restarts.
- **Prometheus** provides metrics. The dashboard backend reads from Prometheus directly for monitoring and visualization, rather than proxying metrics through the control plane.

The **dashboard backend** aggregates from these sources independently: control plane API for orchestration commands, Redis/Valkey for real-time state, Prometheus for metrics. This keeps it decoupled — it can function and display cluster state even if the control plane is temporarily unavailable.

The **proxy** consumes a read-only routing map from the shared state store. **Engine runners** are invoked by the control plane through the runner contract.

## Consequences

- **Independent scaling and deployment.** The proxy can scale horizontally under load without touching the control plane or dashboard. Components can be updated independently.
- **Fault isolation.** A control plane restart doesn't drop active inference connections. A dashboard crash has no impact on model serving.
- **Right tool for each job.** Each component can use the language and runtime best suited to its specific performance and development requirements.
- **Multi-engine support.** New engines are added by implementing the runner contract, not by modifying core platform code.
- **Operational complexity increases.** Multiple components to deploy, monitor, and version. Mitigated by the monorepo structure (atomic cross-cutting changes) and shared contract definitions.
- **Inter-component contracts must be maintained.** API compatibility between components becomes a first-class concern, managed through OpenAPI specs as the single source of truth.
