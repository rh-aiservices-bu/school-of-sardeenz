# Sardeenz

<p align="center">
  <img src="img/sardeenz-highlander.png" alt="Sardeenz" width="600">
</p>

**High-density GPU workload orchestration platform.**

Sardeenz enables enterprise clusters to host and serve more accelerator-based workloads (LLMs, diffusion models, predictive models) than can fit simultaneously in device memory — without the operational overhead and resource rigidity of traditional frameworks.

Instead of letting Kubernetes allocate accelerators per-workload at the infrastructure level, Sardeenz permanently assigns accelerator blocks to persistent worker processes and manages workload placement at the application level (L7). Kubernetes sees static, warm containers. Sardeenz sees a fluid canvas of device memory that can be packed, swapped, or put to sleep on the fly.

## Architecture

The platform comprises four decoupled components:

| Component | Role |
| --- | --- |
| **Routing Proxy** | High-performance request routing with connection parking |
| **Control Plane** | Orchestration, scheduling, device memory management |
| **Admin Dashboard** | Web UI for model management and cluster monitoring |
| **Engine Runners** | Abstraction layer for different inference engines (vLLM, Triton, etc.) |

For the full architecture description, diagrams, and request flows, see the [Architecture Overview](docs/architecture/overview.md).

For individual design decisions, see the [ADRs](docs/architecture/adrs/).

## Getting Started

_Coming soon._

## Development

_Coming soon._ <!-- See docs/development/ when available -->

## Deployment

_Coming soon._ <!-- See docs/usage/ when available -->

## Project Status

Sardeenz is in early development. See the [overall plan](docs/project/overall-plan.md) for the delivery phases.

## License

[Apache License 2.0](LICENSE)
