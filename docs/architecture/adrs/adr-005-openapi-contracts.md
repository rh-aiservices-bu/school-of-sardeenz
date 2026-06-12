# ADR-005: OpenAPI as Cross-Language Contract

## Status

Accepted

## Context

The platform spans two languages — Rust (proxy) and TypeScript (control plane, dashboard). These components communicate through APIs that must stay type-safe and in sync across language boundaries.

Without a shared contract mechanism, API changes risk silent drift: a field renamed in the control plane but not in the proxy, a new enum variant missing from the dashboard's type definitions, or a schema mismatch that only surfaces at runtime.

## Decision

OpenAPI specifications maintained in `packages/contracts/` are the **single source of truth** for all inter-component communication schemas.

Type generation pipeline:

| Target                     | Approach                            | Output                           |
| -------------------------- | ----------------------------------- | -------------------------------- |
| Rust (proxy)               | Hand-maintained, mirroring the spec | Rust structs + (de)serialization |
| TypeScript (control plane) | `openapi-typescript` (generated)    | TypeScript types                 |
| TypeScript (dashboard)     | `openapi-typescript` (generated)    | TypeScript types + fetch client  |

Rust types are hand-maintained rather than auto-generated because codegen output (via `openapi-generator` / `progenitor`) was verbose and non-idiomatic. The type surface is small (~260 lines) and benefits from manual control over serde attributes, derive macros, and flattened metadata fields. The trade-off is manual synchronization when specs change.

The contracts cover:

- **Proxy ↔ Control Plane:** Routing map schema, model states, wake-up trigger API, health/metrics reporting
- **Dashboard ↔ Control Plane:** Model lifecycle operations, device memory budget views, engine module management, cluster state, real-time event streams
- **Engine Runner Contract:** Health check, memory reporting, lifecycle signals, capability declaration

**Workflow:** Edit the OpenAPI spec → run `make codegen` → TypeScript types are regenerated. Rust types in `proxy/src/generated/` must be updated manually to match.

## Backward-Compatibility Policy

### Versioning scheme

Each OpenAPI spec carries its own semver version in `info.version`. While specs are pre-1.0 (`0.x.y`):

- **Minor bump** (`0.1.0` → `0.2.0`): may contain breaking changes.
- **Patch bump** (`0.1.0` → `0.1.1`): additive and backward-compatible only.

After a spec reaches `1.0.0`, standard semver applies: breaking changes require a major bump.

### Breaking vs. non-breaking changes

| Change | Classification |
| --- | --- |
| Add optional field to request/response | Non-breaking |
| Add new endpoint | Non-breaking |
| Add new enum value (consumers must handle unknown) | Non-breaking |
| Add optional query/header parameter | Non-breaking |
| Remove or rename a field | **Breaking** |
| Change a field's type | **Breaking** |
| Make an optional field required | **Breaking** |
| Remove an enum value | **Breaking** |
| Change a URL path | **Breaking** |
| Remove an endpoint | **Breaking** |

### Rollout compatibility

All components live in a single monorepo and are released together. There is **no N-1 compatibility window** — when a spec changes, all consumers (Rust proxy types, generated TypeScript types, dashboard client) must be updated in the same release cycle.

This can be revisited if components ever deploy independently.

### Version mismatch detection

Each component logs the contract version it was built against at startup. There is no runtime version negotiation — the version is used for observability and debugging only.

## Consequences

- **Cross-language type safety.** Schema mismatches are caught at build time, not runtime.
- **Single source of truth.** No ambiguity about what an API accepts or returns — the spec is authoritative.
- **Contract-first development.** API changes start with the spec, encouraging deliberate interface design over ad-hoc evolution.
- **Generation tooling dependency.** The TypeScript build pipeline depends on `openapi-typescript`, which must be maintained and kept compatible with the OpenAPI spec version.
- **Spec maintenance overhead.** Every API change requires updating the spec first, then regenerating TypeScript types and manually updating Rust types. This is intentional friction — it prevents accidental drift — but adds steps to the development workflow.
- **Rust drift risk.** Hand-maintained Rust types can fall out of sync with the spec. Mitigated by keeping a small type surface, clear file headers referencing the source spec, and code review discipline on spec-changing PRs.
