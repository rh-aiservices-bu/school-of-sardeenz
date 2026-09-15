---
name: scaffold-component
description: Create a new component within the Sardeenz monorepo with correct boilerplate. Use when asked to set up, initialize, or scaffold a new TypeScript or Rust component.
---

# Scaffold Component

Create a new component within the Sardeenz monorepo with correct boilerplate.

## When to use

- When asked to set up, initialize, or scaffold a new component
- When bootstrapping a component directory that currently has no package.json or Cargo.toml

## Steps

### For TypeScript components

1. Create `package.json` with:
   - Name scoped under `@sardeenz/`
   - `"private": true`, `"type": "module"`
   - Dependency on `@sardeenz/types` for shared contract types
   - Scripts: `build`, `dev`, `test`, `lint`, `typecheck`
2. Create `tsconfig.json` extending `../../tsconfig.base.json` (adjust path depth)
3. Create directory structure: `src/`, `tests/`
4. Create entry point: `src/index.ts`
5. Run `npm install` from root to link workspace

### For Rust components

1. Create `Cargo.toml` as workspace member under `proxy/`
2. Create `src/main.rs` or `src/lib.rs` with minimal boilerplate
3. Add the crate to the proxy workspace members list

## Important

- Follow naming conventions from `docs/development/coding-standards.md`
- TypeScript components use ESM (`"type": "module"`)
- All components must be registered in the root workspace config
- Use existing `@sardeenz/types` for any contract-derived types — never duplicate
