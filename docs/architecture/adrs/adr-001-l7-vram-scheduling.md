# ADR-001: Software-Defined VRAM Scheduling at Layer 7

## Status

Accepted

## Context

Traditional enterprise AI platforms allocate accelerators at the Kubernetes scheduler level (Layer 3 — infrastructure). Once a Pod claims a GPU (or other accelerator), that hardware block and its device memory are locked to the Pod's lifecycle. Even if the inference engine sleeps a model and frees memory, Kubernetes has no visibility into that freed capacity and cannot reclaim it for other workloads.

This creates three compounding problems:

1. **Rigid allocation.** GPU resources are structurally locked regardless of actual utilization. A sleeping model still "owns" its GPU from Kubernetes' perspective.
2. **Heavyweight cold starts.** Scaling from zero forces the full container lifecycle: Pod scheduling, image pull, accelerator runtime init, graph capture. Depending on the context, cold starts may reach 10-15 minutes or more on uncached nodes.
3. **Engine version rigidity.** Testing a different inference engine version requires a full container image rebuild and redeployment cycle.

Beyond removing these constraints, moving orchestration to the software layer opens up capabilities that are impractical at the infrastructure tier: application-aware load balancing, automated model placement and rebalancing, predictive scaling, and other operational strategies that maximize utilization of the available infrastructure.

Sardeenz v1 validated that this approach — treating device memory as a software-managed resource — works in practice.

## Decision

Sardeenz v2 permanently allocates entire accelerator blocks to persistent worker processes at cluster startup. The platform manages device memory as a fluid, software-defined resource at Layer 7 (application/process tier). The initial implementation targets GPUs, but the model is designed to extend to other accelerator types and CPU-only platforms.

Kubernetes sees static, warm container topologies. Sardeenz sees a canvas of device memory that can be packed, swapped, paged, or put to sleep on the fly.

The control plane tracks VRAM budgets, runs eviction algorithms, and coordinates sleep/wake cycles with engine processes — all without touching the Kubernetes scheduler.

## Consequences

- **Accelerator overcommitment becomes possible.** The cluster can host more models than fit in device memory simultaneously by sleeping inactive ones.
- **Cold starts drop from minutes to seconds.** No container lifecycle involved — just memory allocation and weight loading within an already-warm process.
- **Engine upgrades decouple from infrastructure.** New engine versions load as processes inside existing containers (via Highlander modules), not as new Pod deployments.
- **Application-aware operations become possible.** The platform can implement intelligent load balancing, automated model placement, rebalancing across nodes, and other management strategies that infrastructure-level scheduling cannot express.
- **Kubernetes-level accelerator monitoring becomes misleading.** Standard utilization metrics reflect the static allocation, not actual usage. Sardeenz must provide its own observability layer.
- **The platform owns availability.** If a Sardeenz worker crashes, Kubernetes restarts the Pod, but model placement and device memory state must be reconstructed by the control plane.
