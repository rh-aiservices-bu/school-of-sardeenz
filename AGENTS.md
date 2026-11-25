# AGENTS.md

**Sardeenz v2** is a high-density GPU workload orchestration platform — the production-grade
successor to the [Sardeenz v1 prototype](https://github.com/rh-aiservices-bu/sardeenz). It moves
VRAM scheduling from Kubernetes (L3) to the application layer (L7): a software-defined VRAM
multiplexer that sleeps, wakes, and evicts models on demand.

This file is the entry point. Each component has its own `AGENTS.md` with targeted instructions —
read the one for the directory you are working in. `CLAUDE.md` files are symlinks to `AGENTS.md`.

## Components

| Component       | Directory                    | Stack                                   | Agent guide                                                    |
| --------------- | ---------------------------- | --------------------------------------- | -------------------------------------------------------------- |
| Routing Proxy   | `proxy/`                     | Rust (axum/tokio)                       | [`proxy/AGENTS.md`](proxy/AGENTS.md)                           |
| Control Plane   | `control-plane/`             | TypeScript (Fastify, Postgres, Redis)   | [`control-plane/AGENTS.md`](control-plane/AGENTS.md)           |
| Admin Dashboard | `dashboard/`                 | React + PatternFly 6 (Vite) + BFF       | [`dashboard/AGENTS.md`](dashboard/AGENTS.md)                   |
| Engine Runners  | `runners/`                   | TypeScript dev worker, Python shims     | [`runners/AGENTS.md`](runners/AGENTS.md)                       |
| Contracts       | `packages/contracts/`        | OpenAPI 3.1 (source of truth)           | [`packages/contracts/AGENTS.md`](packages/contracts/AGENTS.md) |
| Images & Deploy | `containers/`, `deployment/` | Containerfiles, SIF pipeline, Kustomize | [`deployment/AGENTS.md`](deployment/AGENTS.md)                 |

**Architecture:** [`docs/architecture/overview.md`](docs/architecture/overview.md) (system
description, request flows, data architecture). **Decisions:**
[`docs/architecture/adrs/`](docs/architecture/adrs/). **Component specs:**
[`docs/architecture/components/`](docs/architecture/components/).

Key design facts an agent needs on first pass:

- Four strictly decoupled components talk only through the OpenAPI contracts in
  `packages/contracts/` (ADR-005). TypeScript types are generated; Rust types are hand-maintained.
- Engine runtimes ship as **Apptainer SIF** files on a shared volume, `apptainer exec`-ed by a slim
  worker image (ADR-015/016/017); official SIFs are distributed via ORAS from a
  [`runners.yaml`](runners.yaml) catalog ([`docs/usage/runner-catalog.md`](docs/usage/runner-catalog.md)).
- A logical model has one or more instances (ADR-019); configuration name and served model name
  are distinct (ADR-020); proxy paths are split by protocol family `/openai` | `/oip` (ADR-021).
- VRAM shown to users is **measured-only** (NVML); `requiredMemory` is a placement input, never a
  user-facing "reserved" figure.
- **Security fails closed (M15):** service tokens are required at startup (dev-only opt-out
  `SARDEENZ_ALLOW_UNAUTHENTICATED_API=true`, never in `deployment/**`); Valkey requires AUTH from
  `sardeenz-redis-credentials`; the `sardeenz` namespace ships default-deny ingress with explicit
  allow NetworkPolicies (flow table in `docs/usage/deployment-security.md` — add a rule per new
  flow); the worker allowlists `POST /runners` `entrypoint` argv against its configured
  `SARDEENZ_RUNNER_ENTRYPOINT`; the BFF `?token=` query fallback is SSE-routes-only.

## Repository Structure

```
sardeenz/
├── proxy/              # Rust proxy — cargo workspace root
├── control-plane/      # TypeScript (Fastify) orchestrator
├── dashboard/          # React + PatternFly 6 frontend, `server/` = BFF
├── packages/           # contracts/ (OpenAPI), types/ (generated TS), utils/ (type-only)
├── runners/            # dev-worker/ (TS worker agent + stubs), vllm/, mlserver/, conformance/
├── containers/         # Service images, worker-base, versioned runners/<engine>/<version> → SIFs
├── deployment/         # Kustomize manifests (control-plane, sif-runner, librarian)
├── docs/               # architecture/, project/, development/, usage/
├── scripts/, tests/    # build-sif.sh, dev-proxy.sh; tests/gates/ spike gates
└── Makefile            # `make help` lists every target
```

## Development

- Setup, dev services, logs, common commands: [`docs/development/setup.md`](docs/development/setup.md).
- Coding standards (TS, Rust, cross-language): [`docs/development/coding-standards.md`](docs/development/coding-standards.md).
- Contract workflow (edit spec → validate → `make codegen` → fix consumers): [`docs/development/contracts.md`](docs/development/contracts.md).
- `make lint typecheck test` is the pre-commit gate; `make test-python` covers the Python shims.
  `make test-integration` (Postgres + Valkey) runs in CI on every PR, staged advisory until its
  first green run — it self-skips and exits 0 when the services are absent, so use the CI job's
  executed-count gate as the proof, not a local exit code.

## Workflow Rules

- **Branching:** `dev` is the integration branch; `main` is for releases only. Branch from `dev`,
  PR back to `dev` ([details](docs/development/setup.md#branching-strategy)).
- **CHANGELOG:** always update `CHANGELOG.md` under `[Unreleased]` before committing.
- **Package manager:** npm, never pnpm (hardlink store breaks across the container/host mount).
- **Commit hygiene:** run lint/typecheck before marking work complete. Stage specific files, not
  `git add -A`.
- **Terminology:** engine abstractions are "runners", not "plugins".

## Project Status

Phases 0–5 and milestones M2–M17 are complete and merged to `dev`, as are M19's Phase 5 track and
its image/supply-chain half (#266 via #316, #267 via #318) plus the M19 docs/contracts items (#249
via #319, #248 via #320, #268 via #273). M18 (CI & Test Infrastructure) is **implemented on
`milestone/m18-ci-test-infrastructure` but not yet merged** — its integration job lands staged
(advisory until its first green run, currently blocked by #322). Next: merge M18, then M19's
remaining #315 (cluster-only), the vLLM SIF republish/rollout, M20, and the Parking Lot backlog.
Details and history: [`docs/project/status.md`](docs/project/status.md); full plan:
[`docs/project/overall-plan.md`](docs/project/overall-plan.md).

## Sardeenz v1 Reference

The [v1 codebase](https://github.com/rh-aiservices-bu/sardeenz) is a living reference for
cherry-picking UI components and patterns ([component mapping](docs/project/v1-component-mapping.md)).
It is not being refactored — v2 is a new platform (ADR-006).
