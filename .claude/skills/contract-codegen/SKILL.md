---
name: contract-codegen
description: Regenerate TypeScript types from OpenAPI specifications. Use after modifying any OpenAPI spec in packages/contracts/, or when asked to update, regenerate, or sync types/contracts.
---

# Contract Code Generation

Regenerate TypeScript types (and later Rust structs) from OpenAPI specifications.

## When to use

- After modifying any OpenAPI spec in `packages/contracts/`
- When asked to update, regenerate, or sync types/contracts
- When a type mismatch is found between components and the spec

## Steps

1. **Validate specs** — run `npm run validate -w @sardeenz/contracts` to lint all OpenAPI YAML files
2. **Generate TypeScript types** — run `npm run codegen -w @sardeenz/types` to regenerate types from specs using `openapi-typescript`
3. **Type-check** — run `make typecheck` to verify generated types compile and all consumers are compatible
4. **Report** — list which specs were processed and any breaking changes detected

## Important

- Never hand-edit files in `packages/types/src/generated/` — they are overwritten by codegen
- If a spec change breaks a consumer, fix the consumer code, not the generated types
- The OpenAPI specs in `packages/contracts/` are the single source of truth (ADR-005)
