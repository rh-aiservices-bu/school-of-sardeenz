# Sardeenz v2 Documentation

**Sardeenz v2** is a high-density GPU workload orchestration platform: a software-defined VRAM
multiplexer that sleeps, wakes, and evicts models on demand. Kubernetes sees static, warm worker
Pods; Sardeenz sees a fluid canvas of device memory managed at the application layer (L7).

It is the production-grade successor to the
[Sardeenz v1 prototype](https://github.com/rh-aiservices-bu/sardeenz).

## Start here

- [**Architecture Flow Visualizer**](architecture-visualizer.html) — an interactive, animated
  walkthrough of the platform: cluster bootstrap, model deployment, the inference hot path,
  park-and-wake, LRU eviction, instance moves, control plane failover, and runner catalog imports.
- [**Architecture Overview**](architecture/overview.md) — system description, component
  responsibilities, data architecture, and request flows.

## Sections

- [`architecture/`](architecture/README.md) — System design, component specs, and design decisions
- [`usage/`](usage/README.md) — User-facing guides, API reference, and deployment instructions
- [`development/`](development/README.md) — Dev setup, coding standards, and contribution workflows

## Elsewhere

- [Architecture Decision Records](https://github.com/rh-aiservices-bu/school-of-sardeenz/tree/dev/docs/architecture/adrs)
  and [project planning and status](https://github.com/rh-aiservices-bu/school-of-sardeenz/tree/dev/docs/project)
  live in the repository
- [Source repository](https://github.com/rh-aiservices-bu/school-of-sardeenz) and
  [changelog](https://github.com/rh-aiservices-bu/school-of-sardeenz/blob/dev/CHANGELOG.md)
- [Runner catalog (`runners.yaml`)](https://github.com/rh-aiservices-bu/school-of-sardeenz/blob/dev/runners.yaml)
