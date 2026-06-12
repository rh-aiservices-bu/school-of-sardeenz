# Development Setup

## Prerequisites

Sardeenz development uses a containerized environment ([ccbox](https://github.com/guimou/ccbox)) that provides all required tooling. If working outside the container, install:

- **Node.js** >= 22 with npm (version pinned in `.nvmrc`)
- **Rust** stable toolchain (via [rustup](https://rustup.rs/)) with `rust-analyzer`, `clippy`, and `rustfmt` components
- **Podman** with `podman-compose` (or Docker with Docker Compose) — for dev services (Redis/Valkey, later PostgreSQL)
- **direnv** (recommended — auto-switches Node version on `cd` via `.envrc`)
- **ripgrep** (recommended for fast code search)

## First-Time Setup

```bash
# If using direnv, trust the project .envrc (one-time)
direnv allow

# Install all npm workspace dependencies
# .npmrc enforces engine-strict — npm will refuse to install on Node < 22
npm install

# Start dev services (Redis/Valkey — see "Dev Services" below)
podman compose up -d

# Verify the setup
make all        # Type-check + lint (includes OpenAPI spec validation)
make test       # Run test suites (Vitest)
make format-check  # Prettier + rustfmt (if Rust available)
```

## Project Structure

The monorepo uses npm workspaces for TypeScript and a Cargo workspace for Rust:

```
sardeenz/
├── proxy/              # Rust — cargo workspace
├── control-plane/      # TypeScript — npm workspace
├── dashboard/          # TypeScript — npm workspace
├── packages/
│   ├── contracts/      # OpenAPI specs (source of truth)
│   ├── types/          # Generated TypeScript types
│   └── utils/          # Shared TypeScript utilities
```

## Running Components

```bash
make dev-cp         # Control plane (Fastify dev server)
make dev-dashboard  # Dashboard (Vite dev server)
make dev-proxy      # Proxy (cargo watch, requires Rust)
```

## Dev Services

Backend services (Redis/Valkey, and later PostgreSQL) run via Podman Compose. The compose file is at the repo root (`compose.yaml`).

```bash
# Start all services in the background
podman compose up -d

# Check service health
podman compose ps

# View logs
podman compose logs redis

# Stop services (data is preserved in volumes)
podman compose down

# Stop and remove all data volumes (clean slate)
podman compose down -v
```

Docker Compose works identically — replace `podman` with `docker`.

### Services

| Service | Image             | Default port | Used by                                                       |
| ------- | ----------------- | ------------ | ------------------------------------------------------------- |
| `redis` | `valkey/valkey:8` | 6379         | Proxy (routing map), control plane (state), integration tests |

Additional services (PostgreSQL, Prometheus) will be added in later phases.

### Connecting from code

The default connection URLs match the compose defaults with no extra configuration:

| Service      | Default URL              |
| ------------ | ------------------------ |
| Redis/Valkey | `redis://localhost:6379` |

## Common Commands

| Command              | Description                               |
| -------------------- | ----------------------------------------- |
| `make all`           | Type-check and lint everything            |
| `make lint`          | ESLint + clippy + OpenAPI spec validation |
| `make lint-specs`    | Validate OpenAPI specs only (Redocly)     |
| `make format`        | Auto-format all files                     |
| `make format-check`  | Check formatting (CI-safe)                |
| `make typecheck`     | TypeScript `tsc --build` + `cargo check`  |
| `make test`          | Run all test suites (Vitest + cargo test) |
| `make test-coverage` | Run tests with V8 coverage                |
| `make codegen`       | Regenerate types from OpenAPI specs       |
| `make services`      | Start dev services (Redis/Valkey)         |
| `make services-stop` | Stop dev services                         |
| `make clean`         | Remove all build artifacts                |

## Logs

Dev servers running on the host write their output to the `logs/` directory in the project root (gitignored). Since the project folder is bind-mounted into the ccbox container, Claude Code can read these logs directly to debug runtime issues without needing output pasted into the conversation.

Each component pipes its output to a separate log file:

```bash
# Example: start the control plane and capture logs
npm run dev -w @sardeenz/control-plane > logs/control-plane.log 2>&1 &
```

## Tooling Overview

| Tool               | Purpose                      | Config file                       |
| ------------------ | ---------------------------- | --------------------------------- |
| TypeScript 5.x     | Type checking                | `tsconfig.base.json`              |
| ESLint 9           | Linting (flat config)        | `eslint.config.js`                |
| Prettier           | Code formatting              | `.prettierrc.json`                |
| Vitest             | Testing                      | `vitest.config.ts`                |
| Redocly            | OpenAPI spec validation      | `packages/contracts/redocly.yaml` |
| openapi-typescript | Generate TS types from specs | —                                 |
| Cargo / clippy     | Rust build and linting       | `proxy/Cargo.toml`                |

## Versioning

The project uses a single version in the root `package.json`. Sub-packages are all `private: true` and do not carry their own version fields.

## IDE Configuration

The repo includes `.editorconfig` for baseline formatting. Most editors respect this automatically.

For VS Code (if not using ccbox), recommended extensions:

- ESLint
- Prettier
- rust-analyzer
- EditorConfig for VS Code
