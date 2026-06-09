# Coding Standards

## TypeScript

### Module System

- ESM only (`"type": "module"` in all package.json files)
- Use `.js` extensions in import paths (required for NodeNext module resolution)
- Prefer named exports over default exports

### Naming

- `camelCase` for variables, functions, and object properties
- `PascalCase` for types, interfaces, classes, and React components
- `SCREAMING_SNAKE_CASE` for constants and enum values
- File names: `kebab-case.ts` for modules, `PascalCase.tsx` for React components

### Error Handling

- Use explicit error returns or typed Result patterns over thrown exceptions
- Catch at system boundaries (HTTP handlers, event listeners), not in internal functions
- Log errors with structured context (tracing fields), not bare `console.error`

### Imports

Order imports in groups separated by blank lines:

1. Node built-ins (`node:fs`, `node:path`)
2. External packages (`fastify`, `react`)
3. Internal packages (`@sardeenz/types`, `@sardeenz/utils`)
4. Relative imports (`./routes`, `../config`)

### Type Safety

- `strict: true` is non-negotiable
- Never use `any` — use `unknown` and narrow
- Use `@sardeenz/types` for all contract-derived types — never duplicate definitions

## Rust

### General

- Follow standard Rust conventions and idioms
- Target Rust edition 2021, MSRV 1.82
- Run `cargo clippy -- -D warnings` before committing

### Error Handling

- Use `thiserror` for library-style error types
- Use `anyhow` for application-level error propagation
- Always provide context with `.context()` or custom error variants

### Naming

- `snake_case` for variables, functions, and modules
- `PascalCase` for types, structs, enums, and traits
- `SCREAMING_SNAKE_CASE` for constants

### Module Organization

- Keep `main.rs` minimal — delegate to modules
- One public type per module when the type is complex
- Use `mod.rs`-free module style (`module_name.rs` + `module_name/` for submodules)

## Cross-Language Alignment

OpenAPI contracts bridge the Rust and TypeScript sides. Naming conventions differ by language but map predictably:

| JSON (contract) | TypeScript           | Rust                  |
| --------------- | -------------------- | --------------------- |
| `modelId`       | `modelId`            | `model_id`            |
| `ModelState`    | `ModelState`         | `ModelState`          |
| `LOADING`       | `ModelState.LOADING` | `ModelState::Loading` |

`serde` rename attributes handle the Rust ↔ JSON mapping automatically. TypeScript types are generated and match JSON conventions directly.
