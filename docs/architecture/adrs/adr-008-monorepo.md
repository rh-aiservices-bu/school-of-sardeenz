# ADR-008: Monorepo Structure

## Status

Accepted

## Context

The platform spans multiple languages (Rust, TypeScript) and components (proxy, control plane, dashboard, plugins, easyconfigs, worker container). These components share contracts (OpenAPI specs), types, and utilities, and cross-cutting changes (e.g., a new field in the routing map schema) touch multiple components simultaneously.

Two main organizational approaches exist:

- **Monorepo:** All components in a single repository.
- **Multi-repo:** Each component in its own repository with versioned dependencies between them.

## Decision

The project uses a **monorepo** with clear directory boundaries per component.

TypeScript components (`control-plane/`, `dashboard/`, `packages/`) are managed as npm workspaces. The Rust proxy (`proxy/`) uses its own Cargo workspace. A top-level `Makefile` provides a unified build, test, and dev interface across both ecosystems.

## Rationale

- **Atomic cross-cutting changes.** A contract change, the generated types on both sides, and the code that uses them ship in one commit — not three coordinated PRs across repos.
- **Full project visibility.** AI-assisted development tools and contributors see the entire platform in context, making it easier to reason about changes that span boundaries.
- **Simpler CI.** One pipeline validates everything. No dependency version matrix to manage between repos.
- **Easy extraction later.** If a component matures to the point where independent release cycles are needed, extracting it into its own repo is straightforward. Starting monorepo doesn't preclude this.

## Alternatives Considered

- **Multi-repo with versioned packages.** Each component publishes its own package/crate. Provides strict isolation and independent release cycles, but introduces significant overhead for a small team: dependency version management, cross-repo PR coordination, and risk of contract drift between releases.

## Consequences

- **Single clone, single CI pipeline.** Lower operational overhead for development and continuous integration.
- **Shared tooling configuration.** Linting, formatting, and commit conventions can be defined once at the root.
- **Repository size grows over time.** Rust build artifacts, node_modules, and easyconfigs all live under one tree. Mitigated by `.gitignore` and build output directories outside of source control.
- **Mixed toolchains.** Contributors need both the Rust and Node.js toolchains available. Mitigated by component-scoped development — most work touches only one language at a time.
