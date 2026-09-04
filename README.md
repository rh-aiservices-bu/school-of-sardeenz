# Sardeenz

<p align="center">
  <img src="img/sardeenz-highlander.png" alt="Sardeenz" width="600">
</p>

**High-density GPU workload orchestration platform.**

Sardeenz enables enterprise clusters to host and serve more accelerator-based workloads (LLMs, diffusion models, predictive models) than can fit simultaneously in device memory — without the operational overhead and resource rigidity of traditional frameworks.

Instead of letting Kubernetes allocate accelerators per-workload at the infrastructure level, Sardeenz permanently assigns accelerator blocks to persistent worker processes and manages workload placement at the application level (L7). Kubernetes sees static, warm containers. Sardeenz sees a fluid canvas of device memory that can be packed, swapped, or put to sleep on the fly.

## Architecture

The platform comprises four decoupled components:

| Component           | Role                                                                   |
| ------------------- | ---------------------------------------------------------------------- |
| **Routing Proxy**   | High-performance request routing with connection parking               |
| **Control Plane**   | Orchestration, scheduling, device memory management                    |
| **Admin Dashboard** | Web UI for model management and cluster monitoring                     |
| **Engine Runners**  | Abstraction layer for different inference engines (vLLM, Triton, etc.) |

For the full architecture description, diagrams, and request flows, see the [Architecture Overview](docs/architecture/overview.md).

For individual design decisions, see the [ADRs](docs/architecture/adrs/).

## Getting Started

Clone the repo, then follow [First-Time Setup](docs/development/setup.md#first-time-setup): `npm install`, `make services`, and `make dev` start the proxy, control plane, dashboard, and BFF locally.

## Development

See [`docs/development/setup.md`](docs/development/setup.md) for prerequisites, dev services, and common commands, and [`AGENTS.md`](AGENTS.md) for the repository map.

## Deployment

See [`deployment/`](deployment/README.md) for the Kustomize manifests, [`docs/usage/deployment-security.md`](docs/usage/deployment-security.md) for the security requirements, and [`docs/usage/runner-catalog.md`](docs/usage/runner-catalog.md) for importing runner SIFs.

## Project Status

Phases 0–4 and milestones M2–M12 are complete. See [`docs/project/status.md`](docs/project/status.md) for details and the [overall plan](docs/project/overall-plan.md) for the delivery phases.

## License

[Apache License 2.0](LICENSE)
