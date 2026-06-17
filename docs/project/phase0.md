# Phase 0 — Engine Runner Contract Design

## Goal

Define the contract that every inference engine runner must implement so the rest of the platform can manage it uniformly. This phase produces an OpenAPI specification, generated TypeScript types, and a design document — no runtime code. Every subsequent phase depends on this boundary: the proxy needs model state definitions (Phase 1), the control plane needs lifecycle and sleep/wake interfaces (Phase 2), and the dashboard needs to display runner state (Phase 3).

## Scope

### In scope

The runner contract covers five interface areas for a **running** runner process:

1. **Health checking** — readiness probes, loading progress
2. **Memory reporting** — current device memory consumption per runner
3. **Sleep/wake** — memory offload commands with level support (L1: offload to host RAM; future levels TBD)
4. **Progress reporting** — structured loading progress
5. **Capability declaration** — supported platform features (tensor parallelism, KV cache offload, specific sleep levels, supported model types)

Lifecycle management (drain, stop) is a worker-level concern — the control plane updates the routing map to stop traffic, then the worker sends SIGTERM to the runner process.

### Out of scope

- **Startup parameters** — how runners get started (model to load, engine config, device assignments) belongs to the worker/control plane boundary, deferred to Phase 2.
- **Runtime code** — no runner implementation; this is specification only.
- **Non-vLLM engine implementations** — vLLM is the reference. Triton and CPU-only runners are validated structurally against the contract, not implemented.

## Approach

1. Study the v1 vLLM integration to extract real-world patterns
2. Design and write the OpenAPI spec covering all five interface areas
3. Wire up code generation and produce TypeScript types
4. Write a design document explaining rationale and usage patterns
5. Validate the contract against three runner scenarios (vLLM, Triton, CPU-only)

## Tasks

| #   | Task                                  | Status   | Output                                            |
| --- | ------------------------------------- | -------- | ------------------------------------------------- |
| 0.1 | Study v1 vLLM integration             | Complete | Reference notes (internal)                        |
| 0.2 | Write runner contract OpenAPI spec    | Complete | `packages/contracts/specs/engine-runner.yaml`     |
| 0.3 | Set up codegen and generate types     | Complete | `packages/types/src/generated/engine-runner.ts`   |
| 0.4 | Write runner contract design document | Complete | `docs/architecture/components/runner-contract.md` |
| 0.5 | Scenario validation                   | Complete | Confirmed coverage of vLLM, Triton, CPU-only      |

## Task Details

### 0.1 — Study v1 vLLM Integration

**Depends on:** v1 repo access ([github.com/rh-aiservices-bu/sardeenz](https://github.com/rh-aiservices-bu/sardeenz))

Fetch the v1 codebase and extract the runner-related patterns that the contract must accommodate:

- Health check endpoints and response format (readiness detection, loading state)
- Memory reporting mechanism (what's reported, units, frequency)
- Sleep/wake API (commands, levels, parameters, timeout handling)
- Log format and progress extraction (how loading progress is surfaced)
- Capability-like declarations (what features the v1 vLLM integration supports)
- Any edge cases or failure modes discovered during v1 development

This produces internal reference notes, not a deliverable. The notes inform Task 0.2.

### 0.2 — Write Runner Contract OpenAPI Spec

**Depends on:** Task 0.1

The core deliverable. Design and write an OpenAPI 3.1 specification at `packages/contracts/specs/engine-runner.yaml` covering all five interface areas.

**Conventions** (from [`docs/development/coding-standards.md`](../development/coding-standards.md)):

- Endpoint paths: `kebab-case` (e.g., `/health`, `/memory-report`)
- Schema names: `PascalCase` (e.g., `HealthStatus`, `MemoryReport`)
- Field names: `camelCase` (e.g., `deviceMemoryUsed`, `sleepLevel`)
- Enum values: `SCREAMING_SNAKE_CASE` (e.g., `READY`, `SLEEPING`)
- Every endpoint: document 200, 400, 500 responses
- Every field: include a `description`

**Validation:** `npm run validate -w @sardeenz/contracts` must pass with zero errors.

### 0.3 — Set Up Codegen and Generate Types

**Depends on:** Task 0.2

`openapi-typescript` v7.6.1 is already installed as a root devDependency. This task:

1. Updates the codegen script in `packages/types/package.json` (currently a no-op) to generate from the new spec
2. Creates `packages/types/src/generated/engine-runner.ts` via `make codegen`
3. Updates `packages/types/src/index.ts` to re-export generated types
4. Verifies the output compiles cleanly with `make typecheck`

Generated files are committed to the repo (not gitignored). Never edit them by hand — fix the spec if the output is wrong.

### 0.4 — Write Runner Contract Design Document

**Depends on:** Task 0.2

Narrative companion to the OpenAPI spec at `docs/architecture/components/runner-contract.md`. This is not a repeat of the spec — it explains the _why_ and _how_ for implementers.

Covers:

- Runner state model — states and valid transitions (with a Mermaid diagram)
- Communication patterns — what the runner exposes via HTTP vs. what it pushes to Redis/Valkey
- Capability declaration semantics — how runner types declare their features and hardware requirements
- Sleep level definitions — what each level means, which are mandatory vs. optional
- Relationship to the placement pipeline ([ADR-011](../architecture/adrs/adr-011-worker-capabilities-and-placement.md))
- Extension points — how future runner types plug in

### 0.5 — Scenario Validation

**Depends on:** Tasks 0.2, 0.3, 0.4

Review the contract against three runner scenarios from the [architecture overview](../architecture/overview.md#worker-and-runner-model):

1. **vLLM runner on GPU** — full lifecycle including sleep/wake with L1 offload, tensor parallelism capability, KV cache reporting, streaming inference
2. **Triton runner on GPU** — different engine with different capabilities, may not support sleep/wake, serves non-LLM workloads
3. **MLServer / predictive runner on CPU-only** — no GPU, no sleep/wake, CPU-only capabilities, lightweight memory reporting

For each scenario, confirm:

- The capability declaration schema can express the runner's features and limitations
- The health and memory reporting endpoints return meaningful data
- Optional interfaces (sleep/wake) can be cleanly absent without breaking the contract
- The state model covers the runner's lifecycle

## Definition of Done

From the [overall project plan](overall-plan.md#phase-0-engine-runner-contract-design):

- [x] OpenAPI spec passes `redocly lint` with zero errors
- [x] Generated TypeScript types compile cleanly (`make typecheck`)
- [x] Design document covers all five interface areas
- [x] Contract reviewed against the Sardeenz v1 vLLM integration to confirm no capability gaps
- [x] Contract validated against vLLM, Triton, and CPU-only runner scenarios

## Open Questions (Resolved)

- **Memory reporting granularity:** Per-device. The control plane needs per-device data for placement on tensor-parallel models. The `MemoryReport` includes a `devices` array with one entry per device.
- **Sleep level extensibility:** Fixed enum with capability declaration. `SleepLevel` enum defines `L1_HOST_RAM`. Runners declare which levels they support in `GET /capabilities`. Future levels added to the enum.
- **Log format transport:** Structured progress endpoint. The contract defines `GET /progress` for loading phase/percentage. Raw log capture (stdout/stderr) is a worker-level concern, not part of the runner HTTP contract.

## References

- [Overall project plan](overall-plan.md) — Phase 0 deliverables and definition of done
- [Architecture overview](../architecture/overview.md) — system design, request flows, worker/runner model
- [ADR-010: Engine runners](../architecture/adrs/adr-010-engine-runners.md) — runner abstraction rationale
- [ADR-011: Worker capabilities and placement](../architecture/adrs/adr-011-worker-capabilities-and-placement.md) — capability reporting and placement pipeline
- [Sardeenz v1](https://github.com/rh-aiservices-bu/sardeenz) — reference implementation for vLLM patterns
