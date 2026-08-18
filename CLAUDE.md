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

**Runtime delivery (Apptainer SIF):** engine runtimes are packaged as **Apptainer SIF** files on a shared RWX volume and executed in place with `apptainer exec` — no per-host image copy, hot-swappable versions, no engine baked into the worker image. This supersedes the original Highlander/EasyBuild-Lmod plan (see [ADR-015](docs/architecture/adrs/adr-015-sif-runtime-packaging.md), validated by the [Phase 4 spike](docs/project/phase4-apptainer-spike.md)). Runner `Containerfile`s and the base worker image live in `containers/`; Sardeenz builds+signs the images and converts them to SIFs (ADR-017). `easyconfigs/` is dropped.

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
│   ├── dev-worker/          # Dev worker agent with runner stubs (local dev)
│   └── vllm/               # First engine runner (reference implementation)
├── containers/             # Container image definitions (see containers/README.md)
│   ├── worker-base/        # Slim worker host image: UBI + Apptainer + FUSE (execs SIFs)
│   └── runner-<engine>/    # Runner images that become SIFs (e.g. runner-vllm/ = vLLM + kvcached)
├── deployment/             # K8s manifests
├── docs/                   # Project documentation
└── Makefile                # Build, dev, test across all components
```

## Delivery Phases

- **Phase 0:** Engine runner contract design (spec only)
- **Phase 1:** Rust proxy with connection parking
- **Phase 2:** Control plane sleep/wake orchestration
- **Phase 3:** Admin dashboard (fresh build)
- **Phase 4:** SIF runner runtime (Apptainer)

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

The project is in early development. Architecture docs, ADRs, and tooling scaffolding are complete. Phases 0–3.6 are complete. Phase 0 (engine runner contract), Phase 1 (Rust proxy with connection parking), Phase 2 (control plane sleep/wake orchestration), Phase 3 (admin dashboard), Phase 3.5 (admin UI finalization — notification system, theme toggle, masthead overhaul), and Phase 3.6 (dev worker agent — local-process worker with runner stubs for containerless dev) are done. Next phase: **Phase 4** (SIF runner runtime — Apptainer). The feasibility spike is complete (verdict: GO — [`docs/project/phase4-apptainer-spike.md`](docs/project/phase4-apptainer-spike.md)) and the implementation task breakdown is [`docs/project/phase4.md`](docs/project/phase4.md). Decisions: [ADR-015/016/017](docs/architecture/adrs/). Full plan: [`docs/project/overall-plan.md`](docs/project/overall-plan.md).

## Workflow Rules

- **Branching:** `dev` is the integration branch; `main` is for releases only. Create feature/fix branches from `dev` and PR back to `dev`. See [`docs/development/setup.md`](docs/development/setup.md#branching-strategy) for details.
- **CHANGELOG:** Always update `CHANGELOG.md` (under `[Unreleased]`) before committing changes.
- **Package manager:** Use npm, not pnpm. pnpm's hardlink store breaks across the container/host mount boundary.
- **Commit hygiene:** Run lint/typecheck before marking work complete. Stage specific files, not `git add -A`.

## Sardeenz v1 Reference

The [v1 codebase](https://github.com/rh-aiservices-bu/sardeenz) remains a living reference for cherry-picking UI components and implementation patterns. It is not being refactored — this is a new platform.
