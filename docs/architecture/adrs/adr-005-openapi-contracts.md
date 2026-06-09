# ADR-005: OpenAPI as Cross-Language Contract

## Status

Accepted

## Context

The platform spans two languages — Rust (proxy) and TypeScript (control plane, dashboard). These components communicate through APIs that must stay type-safe and in sync across language boundaries.

Without a shared contract mechanism, API changes risk silent drift: a field renamed in the control plane but not in the proxy, a new enum variant missing from the dashboard's type definitions, or a schema mismatch that only surfaces at runtime.

## Decision

OpenAPI specifications maintained in `packages/contracts/` are the **single source of truth** for all inter-component communication schemas. Types are never hand-written on the consumer side — they are generated from the specs.

Code generation pipeline:

| Target | Tooling | Output |
| --- | --- | --- |
| Rust (proxy) | `openapi-generator` or `utoipa` | Rust structs + (de)serialization |
| TypeScript (control plane) | `openapi-typescript` | TypeScript types |
| TypeScript (dashboard) | `openapi-typescript` | TypeScript types + fetch client |

The contracts cover:

- **Proxy ↔ Control Plane:** Routing map schema, model states, wake-up trigger API, health/metrics reporting
- **Dashboard ↔ Control Plane:** Model lifecycle operations, device memory budget views, engine module management, cluster state, real-time event streams
- **Engine Runner Contract:** Health check, memory reporting, lifecycle signals, capability declaration

**Workflow:** Edit the OpenAPI spec → run code generation → both Rust and TypeScript components get updated types. CI ensures generated code is never out of sync with the spec.

## Consequences

- **Cross-language type safety.** Schema mismatches are caught at build time, not runtime.
- **Single source of truth.** No ambiguity about what an API accepts or returns — the spec is authoritative.
- **Contract-first development.** API changes start with the spec, encouraging deliberate interface design over ad-hoc evolution.
- **Generation tooling dependency.** The build pipeline depends on code generation tools that must be maintained and kept compatible with the OpenAPI spec version.
- **Spec maintenance overhead.** Every API change requires updating the spec first, then regenerating. This is intentional friction — it prevents accidental drift — but adds a step to the development workflow.
