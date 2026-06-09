# ADR-009: Shared State and Persistence Strategy

## Status

Accepted

## Context

The four-component architecture (ADR-002) requires multiple components to access shared data without coupling them through direct API calls. Different categories of data have fundamentally different access patterns:

- **Real-time state** (routing map, model states, device memory budgets, cluster topology) changes frequently and must be readable with minimal latency by the proxy and dashboard.
- **Durable configuration** (model presets, benchmark results, memory profiles, user settings) changes infrequently but must survive restarts and failures.
- **Metrics** (inference latency, throughput, device utilization, proxy connection counts) are time-series data consumed for monitoring and visualization.

Routing all of these through the control plane API would make it a bottleneck and a single point of failure for reads that don't require orchestration logic.

## Decision

Data is split across three purpose-matched stores:

| Store              | Data                                                                                                                      | Access Pattern                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **Redis / Valkey** | Routing map, model states, device memory budgets, worker-reported device memory usage, cluster topology, real-time events | High-frequency reads by proxy and dashboard. Written by the control plane and workers. Pub/sub for state change notifications. |
| **PostgreSQL**     | Configurations, benchmarks, memory profiles, persistent settings                                                          | Low-frequency reads/writes. Must survive full cluster restarts. Queried by the control plane and dashboard backend.            |
| **Prometheus**     | Inference metrics, device utilization, proxy stats, component health                                                      | Time-series collection via scrape endpoints. Read directly by the dashboard backend for monitoring views.                      |

### Why Redis/Valkey for Real-Time State

The proxy needs the routing map on every request — it cannot afford a network round-trip to the control plane for each lookup. Redis/Valkey provides:

- Sub-millisecond reads for the routing map
- Pub/sub for pushing state changes to interested consumers (proxy, dashboard) without polling
- Natural TTL semantics for transient state (e.g., model loading progress)

The control plane writes orchestration state (routing map, model lifecycle states, device memory budgets). Workers push their own device memory usage (including volatile data like KV cache consumption) directly to Redis/Valkey at regular intervals. This inverts the polling model from Sardeenz v1, where the controller pulled memory data from each worker — instead, workers self-report and both the control plane (for eviction decisions) and the dashboard (for display) consume the data independently. This scales naturally as the worker pool grows, without the control plane needing to poll N workers on a tight loop.

### Why PostgreSQL for Persistence

Configurations and operational data (benchmarks, profiles) need durability, queryability, and transactional guarantees. PostgreSQL is a proven choice, already validated in Sardeenz v1 for the same use cases.

### Why Prometheus for Metrics

Metrics are a separate concern from application state. Prometheus's pull-based model, built-in time-series storage, and ecosystem (Grafana, alerting rules) make it the standard for this role. Components expose scrape endpoints; Prometheus collects. The dashboard backend queries Prometheus directly for visualization.

## Consequences

- **No single bottleneck for reads.** Each consumer reads from the store closest to its needs without routing through the control plane.
- **Dashboard resilience.** The dashboard backend can display cluster state and metrics even during a control plane failover, since it reads from Redis/Valkey and Prometheus independently.
- **Three stores to operate.** Redis/Valkey, PostgreSQL, and Prometheus must all be deployed and maintained. Mitigated by their ubiquity in Kubernetes environments — all three have well-established operators and deployment patterns.
- **Data consistency model.** Real-time state in Redis/Valkey is eventually consistent with the control plane's decisions. The propagation delay is expected to be negligible in practice, but components must tolerate briefly stale reads (e.g., the proxy may route to a model that just entered sleep — the engine will respond with an appropriate error, and the proxy retries or parks).
