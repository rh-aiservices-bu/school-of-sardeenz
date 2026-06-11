# OpenAPI Contract Workflow

The OpenAPI specifications in `packages/contracts/` are the **single source of truth** for all inter-component communication (see [ADR-005](../architecture/adrs/adr-005-openapi-contracts.md)).

## Contract Files

| File                                 | Covers                           |
| ------------------------------------ | -------------------------------- |
| `specs/proxy-control-plane.yaml`     | Proxy ↔ Control Plane API        |
| `specs/dashboard-control-plane.yaml` | Dashboard ↔ Control Plane API    |
| `specs/engine-runner.yaml`           | Engine runner lifecycle contract |

## Making Changes

### 1. Edit the OpenAPI spec

Modify the relevant YAML file in `packages/contracts/specs/`. Start with the spec, not the code.

### 2. Validate

```bash
npm run validate -w @sardeenz/contracts
```

### 3. Regenerate types

```bash
make codegen
```

This runs `openapi-typescript` to regenerate TypeScript type definitions in `packages/types/src/generated/`.

### 4. Fix consumers

After regeneration, run `make typecheck` to find any code that no longer matches the updated types. Fix those call sites.

### 5. Commit everything together

The spec change, regenerated types, and consumer fixes should ship in a single commit. This is a key benefit of the monorepo (see [ADR-008](../architecture/adrs/adr-008-monorepo.md)).

## Spec Conventions

- OpenAPI version: 3.1
- Endpoint paths: `kebab-case` (`/model-state`, not `/modelState`)
- Schema names: `PascalCase` (`ModelState`, `DeviceInfo`)
- Field names: `camelCase` (`modelId`, `deviceName`)
- Enum values: `SCREAMING_SNAKE_CASE` (`LOADING`, `READY`)
- Every endpoint must document at least 200, 400, and 500 responses
- Every schema field must have a `description`

## Generated Code

Files in `packages/types/src/generated/` are machine-generated. Never edit them by hand — changes will be overwritten on the next `make codegen`. If the generated output is wrong, fix the spec.

These files are committed to the repo (not gitignored) so that consumers can depend on them without running codegen. The `.gitattributes` file marks them as `linguist-generated` so GitHub collapses them in pull request diffs.
