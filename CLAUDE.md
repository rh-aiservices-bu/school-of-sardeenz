# CLAUDE.md

## Project Overview

**Sardeenz v2** is a high-density GPU workload orchestration platform — the production-grade successor to the [Sardeenz v1 prototype](https://github.com/rh-aiservices-bu/sardeenz). It solves the GPU multi-tenancy and overcommitment problem by moving VRAM scheduling from Kubernetes (L3) to the application layer (L7), acting as a software-defined VRAM multiplexer.

## Architecture

**Full architecture:** [`docs/architecture/overview.md`](docs/architecture/overview.md) — system description, Mermaid diagrams, request flows, data architecture. **ADRs:** [`docs/architecture/adrs/`](docs/architecture/adrs/).

Four strictly decoupled components:

| Component       | Directory        | Language                                | Role                                                                          |
| --------------- | ---------------- | --------------------------------------- | ----------------------------------------------------------------------------- |
| Routing Proxy   | `proxy/`         | Rust (axum/tokio)                       | Stateless OpenAI-compatible proxy, connection parking, thundering herd dedup  |
| Control Plane   | `control-plane/` | TypeScript (Fastify)                    | VRAM budget tracking, LRU eviction, sleep/wake orchestration, model lifecycle |
| Admin Dashboard | `dashboard/`     | TypeScript (React + PatternFly 6, Vite) | Model management, VRAM visualization, cluster monitoring                      |
| Engine Runners  | `runners/`       | TBD                                     | Engine abstraction (vLLM reference impl first, then Triton, diffusion, etc.)  |

**Cross-language contracts:** OpenAPI specs in `packages/contracts/` are the single source of truth. TypeScript types are generated via `openapi-typescript`; Rust types are hand-maintained (see ADR-005).

**Highlander integration:** HPC-style Lmod/EasyBuild modules on CephFS replace container image pulls. Easyconfigs and the base worker/runner container image live in this repo — Sardeenz is fully self-contained. See [ODH Highlander](https://odh-highlander.github.io/) for the upstream module management system.

## Repository Structure

```
sardeenz/
├── proxy/                  # Rust (axum/tokio) — cargo workspace root
├── control-plane/          # TypeScript (Fastify)
├── dashboard/              # TypeScript (React + PatternFly 6, Vite)
├── packages/
│   ├── contracts/          # OpenAPI specs (single source of truth)
│   ├── types/              # Generated TypeScript types from OpenAPI
│   └── utils/              # Shared TypeScript utilities
├── runners/
│   └── vllm/               # First engine runner (reference implementation)
├── easyconfigs/            # EasyBuild configs for Highlander runtime modules
├── containers/
│   └── worker-base/        # Base container image for workers/runners
├── deployment/             # K8s manifests
├── docs/                   # Project documentation
└── Makefile                # Build, dev, test across all components
```

## Delivery Phases

- **Phase 0:** Engine runner contract design (spec only)
- **Phase 1:** Rust proxy with connection parking
- **Phase 2:** Control plane sleep/wake orchestration
- **Phase 3:** Admin dashboard (fresh build)
- **Phase 4:** Highlander runtime integration

Details in [`docs/project/`](docs/project/).

## Documentation

- [`docs/architecture/`](docs/architecture/) — System design, component specs, design decisions
- [`docs/project/`](docs/project/) — Project planning, phases, status, decisions log
- [`docs/development/`](docs/development/) — Dev setup, contribution guidelines, coding standards
- [`docs/usage/`](docs/usage/) — User-facing guides, API reference, deployment instructions

## PatternFly 6 (Dashboard)

- **Do NOT use Context7** for PatternFly components — it may have outdated versions
- Use PatternFly.org and the local PF6 guide (to be created under `docs/development/`)
- Context7 is fine for React, Axios, React Router, Vitest, and other non-PF libraries
- All PF classes must use `pf-v6-` prefix; use `--pf-t--` semantic design tokens only

## Project Status

The project is in early development. Architecture docs, ADRs, and tooling scaffolding are complete. Phase 0 (engine runner contract) is complete. Current phase: **Phase 1** (Rust proxy with connection parking). Task breakdown and progress: [`docs/project/phase1.md`](docs/project/phase1.md). Full plan: [`docs/project/overall-plan.md`](docs/project/overall-plan.md).

## Workflow Rules

- **Branching:** `dev` is the integration branch; `main` is for releases only. Create feature/fix branches from `dev` and PR back to `dev`. See [`docs/development/setup.md`](docs/development/setup.md#branching-strategy) for details.
- **CHANGELOG:** Always update `CHANGELOG.md` (under `[Unreleased]`) before committing changes.
- **Package manager:** Use npm, not pnpm. pnpm's hardlink store breaks across the container/host mount boundary.
- **Commit hygiene:** Run lint/typecheck before marking work complete. Stage specific files, not `git add -A`.

## Sardeenz v1 Reference

The [v1 codebase](https://github.com/rh-aiservices-bu/sardeenz) remains a living reference for cherry-picking UI components and implementation patterns. It is not being refactored — this is a new platform.
