# ADR-007: Redundancy and Scaling Strategy

## Status

Accepted

## Context

The platform comprises multiple components with different availability requirements and scaling profiles. Inference traffic must not be interrupted by failures in administrative components, and the system must support growth without requiring architectural changes.

Each component's scaling and redundancy approach should match its actual workload profile — over-engineering HA for components with light workloads adds complexity without meaningful benefit.

## Decision

### Routing Proxy

**Multiple stateless replicas behind a load balancer.**

The proxy is on the critical path of every inference request and is the component most likely to face scale pressure. It is fully stateless — it reads the routing map from the shared state store (Redis/Valkey) and holds no persistent state of its own. Horizontal scaling is straightforward: add replicas behind a Kubernetes Service or Ingress.

### Control Plane

**Single leader with standby failover (Kubernetes Lease-based election).**

The control plane's workload is coordination — eviction decisions, sleep/wake signals, routing map updates — not high-throughput request serving. Even with many models, these operations are infrequent relative to inference traffic. A single active leader is sufficient, with a standby replica that takes over via K8s Lease election on failure. On failover, the new leader reconstructs its view from Redis/Valkey (runtime state) and PostgreSQL (persistent config).

### Admin Dashboard

**Stateless by design, single replica by default, scalable without code changes.**

The dashboard (backend + frontend) does not affect inference availability. A single replica with restart-on-failure is the default deployment. However, the backend is designed stateless — it aggregates from external sources (control plane API, Redis/Valkey, Prometheus) and holds no local state. Administrators can scale to multiple replicas behind a Service if needed, with no code changes required.

### Workers

**Dynamic pool with manual provisioning initially, extensible to autoscaling later.**

Workers can be added to or removed from the pool at any time without restarting the control plane. The control plane detects new workers (through a registration or discovery mechanism) and incorporates them into its topology and placement decisions.

Initially, administrators provision and scale workers manually. The architecture does not preclude future autoscaling — the control plane's dynamic pool management lays the groundwork — but the logic to autonomously request new Pods or Nodes from Kubernetes is not implemented in the first iteration.

On worker failure, Kubernetes restarts the Pod and the control plane reconstructs model placement on the recovered worker.

## Consequences

- **Inference path is resilient.** Proxy replicas and worker restart-on-failure ensure model serving survives individual component failures.
- **Control plane simplicity.** Leader/standby avoids the complexity of multi-writer coordination for a component that doesn't need it.
- **Dashboard scales on demand.** No upfront cost for HA, but no code barrier to scaling when needed.
- **Worker pool is flexible.** Dynamic discovery supports both manual scaling today and automated scaling in the future, without architectural changes.
- **Leader failover has a brief gap.** During control plane leader election, no new eviction or sleep/wake decisions are made. Inference traffic continues unaffected through the proxy and already-running engine processes.
