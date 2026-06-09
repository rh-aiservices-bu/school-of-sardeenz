# ADR-011: Worker Capabilities and Workload Placement

## Status

Accepted

## Context

Not all workers are equal. A worker's capabilities depend on what accelerators (if any) are assigned to it, and those accelerators vary in type, architecture, and capacity:

- One worker might have two NVIDIA A100 GPUs with 80GB each
- Another might have Intel Gaudi accelerators
- Another might be CPU-only, suitable for lightweight predictive models

Similarly, not all runner types work on all hardware. A vLLM runner requires a compatible GPU. A Triton runner might support both GPU and CPU. A predictive model runner might only need CPU.

When a request comes in to deploy a model, the control plane must resolve a multi-level matching problem:

1. **Model requirements.** What does the workload need? (e.g., a specific accelerator type, minimum device memory, tensor parallelism across multiple devices)
2. **Runner compatibility.** Which runner type can serve this workload, and what hardware does it require?
3. **Worker capability.** Which workers have the right hardware available?
4. **Placement decision.** Among capable workers, which one to choose based on current capacity, load, and placement strategy?

Sardeenz v1 handles a simpler version of this — it picks GPUs based on available memory within a homogeneous NVIDIA environment. The new platform must support heterogeneous hardware.

## Decision

Workers self-report their capabilities — accelerator types, device counts, device memory per device, architecture identifiers — to the shared state store (Redis/Valkey) alongside the device memory usage they already push (ADR-009).

The control plane maintains a **capability registry** built from these reports. When placing a workload, it evaluates:

1. **Runner type selection.** Based on the workload type, identify which runner(s) can serve it.
2. **Hardware filtering.** Based on the runner's hardware requirements, filter to workers with compatible accelerators (or CPU capacity).
3. **Capacity filtering.** Among compatible workers, filter to those with sufficient available device memory (or CPU/RAM headroom).
4. **Placement strategy.** Among candidates, apply a placement policy to select the target. The initial strategy is simple (e.g., most available capacity), but the interface is designed for future strategies (balanced distribution, affinity/anti-affinity, cost-weighted).

Worker capabilities are treated as dynamic — a worker can come online with different hardware configurations, and the control plane adapts without requiring manual registration or static configuration.

## Relationship to Existing Schedulers

This placement logic shares functional similarities with infrastructure-level schedulers (Kubernetes, Slurm, Kueue): capability matching, resource tracking, placement strategies, eviction. A natural question is whether Sardeenz is reinventing those systems.

The distinction is in **what** is being scheduled and **at which layer**:

- **Kubernetes / Slurm / Kueue** schedule Pods or jobs onto nodes at the infrastructure level (L3). They allocate entire accelerator devices to workloads and manage container lifecycles.
- **Sardeenz** schedules model processes onto already-running workers at the application level (L7). It manages device memory within pre-allocated accelerator blocks, and controls model lifecycles (sleep, wake, evict) that infrastructure schedulers have no visibility into.

Sardeenz does not replace these schedulers — it complements them. Kubernetes still owns Pod placement onto nodes. Sardeenz owns model placement onto accelerators within those Pods. This is the L7 scheduling paradigm described in ADR-001: the infrastructure layer sees static, warm container topologies while Sardeenz manages the fluid workload landscape inside them.

## Consequences

- **Heterogeneous cluster support.** The platform can manage a mixed fleet of accelerator types and CPU-only nodes from a single control plane.
- **Placement logic is centralized.** The control plane owns the scheduling decision, with full visibility into cluster-wide state. Workers and runners don't choose where they run.
- **Extensible placement strategies.** The placement interface supports swapping strategies without replumbing the scheduling pipeline. Future strategies (priority tiers, affinity rules, cost optimization) can be added incrementally.
- **Capability discovery adds a data flow.** Workers must report their hardware profile on startup and at regular intervals. This is a natural extension of the device memory reporting already flowing to Redis/Valkey.
- **Matching complexity grows with diversity.** As more accelerator types and runner types are added, the compatibility matrix expands. The matching logic must remain clear and testable.
