# Contracts — AGENTS.md

OpenAPI 3.1 specs are the **single source of truth** for every inter-component API (ADR-005).
Change the spec first, then the code.

**Workflow and conventions:** [`docs/development/contracts.md`](../../docs/development/contracts.md)
(edit → validate → codegen → fix consumers → commit together; naming rules; generated-code policy).

## Specs

| File                             | Boundary                                  | Consumers                                                              |
| -------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------- |
| `specs/control-plane.yaml`       | Dashboard BFF ↔ Control Plane             | `control-plane/`, `dashboard/server`, `dashboard/src`                  |
| `specs/proxy-control-plane.yaml` | Proxy ↔ Control Plane (routing map, wake) | `proxy/src/generated/` (hand-maintained), `control-plane/`             |
| `specs/engine-runner.yaml`       | Worker/Control Plane ↔ engine runner      | `runners/*`, `proxy/src/generated/`, `control-plane/clients/runner.ts` |
| `specs/worker-agent.yaml`        | Control Plane ↔ worker agent              | `runners/dev-worker/`, `control-plane/clients/worker.ts`               |

## Rules

- Validate with `npm run validate -w @sardeenz/contracts` (Redocly); lint ignores live in
  `.redocly.lint-ignore.yaml` — do not add to it without a comment explaining why.
- Regenerate with `make codegen` → `packages/types/src/generated/`. Never edit generated files.
- **Rust is not generated:** any change to `proxy-control-plane.yaml` or `engine-runner.yaml`
  needs a matching hand edit in `proxy/src/generated/` in the same PR.
- Document `409` conflict semantics via `details.reason` enums, and every endpoint's 200/400/500.
- The `contract-reviewer` agent exists for reviewing spec diffs — use it before merging.
