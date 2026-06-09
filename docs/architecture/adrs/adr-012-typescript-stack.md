# ADR-012: TypeScript Stack for Control Plane and Dashboard

## Status

Accepted

## Context

The control plane and dashboard need a technology stack that balances developer velocity, ecosystem maturity, and maintainability. Unlike the routing proxy (ADR-003), these components are not on the critical path of every inference request — the control plane handles orchestration decisions at moderate frequency, and the dashboard serves a human-facing UI.

Sardeenz v1 validated TypeScript across the full stack (Fastify backend, React frontend). The team has deep experience with this ecosystem.

## Decision

### Control Plane: TypeScript + Fastify

The control plane is built with **Node.js**, **TypeScript**, and **Fastify**.

- **TypeScript** provides type safety across the codebase, with strong tooling for code generation from OpenAPI specs (ADR-005).
- **Fastify** is a high-performance Node.js framework with a rich plugin ecosystem (JWT, OAuth2, rate limiting, Swagger, metrics). It was proven in Sardeenz v1 for the same class of work.
- **Node.js 22.x** is the runtime target, providing native ESM, built-in fetch/undici, and stable async APIs.

### Dashboard Frontend: React + PatternFly 6 + Vite

The dashboard frontend is built with **React 18**, **PatternFly 6**, and **Vite**.

- **React** is the established standard for component-based UIs, with a large ecosystem and strong TypeScript support.
- **PatternFly 6** is Red Hat's design system. It provides enterprise-grade UI components (tables, forms, charts, navigation) with built-in accessibility and theming. Using it ensures visual and UX consistency with other Red Hat products.
- **Vite** provides fast development builds with HMR and optimized production builds.

### Dashboard Backend: TypeScript + Fastify

The dashboard backend (BFF) uses the same stack as the control plane — **TypeScript + Fastify**. It aggregates data from multiple sources (control plane API, Redis/Valkey, Prometheus) and serves the frontend.

Using the same stack for both TypeScript components enables shared tooling, shared types from `packages/types/`, and reduced cognitive overhead when moving between components.

### Shared Packages

TypeScript components share code through npm workspace packages:

- `packages/types/` — Generated TypeScript types from OpenAPI specs
- `packages/utils/` — Shared utility functions
- `packages/contracts/` — OpenAPI specifications (source of truth)

## Alternatives Considered

- **Go** for the control plane: Strong concurrency model, good Kubernetes client libraries. Would introduce a third language to the monorepo and lose the shared-types advantage with the dashboard.
- **Python** for the control plane: Rich ML/AI ecosystem, but weaker for async web services and less natural fit for the orchestration workload.

## Consequences

- **Shared language across control plane and dashboard.** Types, utilities, and patterns are reusable. Contributors work in one language for most of the platform.
- **Proven stack.** Fastify, React, and PatternFly 6 were validated in Sardeenz v1. Known performance characteristics and failure modes.
- **Strong OpenAPI integration.** TypeScript has mature codegen tooling for consuming OpenAPI specs, keeping the cross-language contract (ADR-005) practical.
- **Two languages in the monorepo.** Rust (proxy) and TypeScript (everything else) require two toolchains. Mitigated by clear component boundaries and a unified Makefile.
