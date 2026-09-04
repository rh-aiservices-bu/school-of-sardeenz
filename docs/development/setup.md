# Development Setup

## Prerequisites

Sardeenz development uses a containerized environment ([ccbox](https://github.com/guimou/ccbox)) that provides all required tooling. If working outside the container, install:

- **Node.js** >= 22 with npm (version pinned in `.nvmrc`)
- **Rust** stable toolchain (via [rustup](https://rustup.rs/)) with `rust-analyzer`, `clippy`, and `rustfmt` components
- **Podman** with `podman-compose` (or Docker with Docker Compose) — for dev services (Redis/Valkey, PostgreSQL)
- **direnv** (recommended — auto-switches Node version on `cd` via `.envrc`)
- **ripgrep** (recommended for fast code search)

## First-Time Setup

```bash
# If using direnv, trust the project .envrc (one-time)
direnv allow

# Install all npm workspace dependencies
# .npmrc enforces engine-strict — npm will refuse to install on Node < 22
npm install

# Create your local config (git-ignored) — see "Local configuration" below
cp .env.example .env

# Start dev services (Redis/Valkey, PostgreSQL — see "Dev Services" below)
podman compose up -d

# Verify the setup
make all        # Type-check + lint (includes OpenAPI spec validation)
make test       # Run test suites (Vitest)
make format-check  # Prettier + rustfmt (if Rust available)
```

## Local Configuration (`.env`)

All configurable ports and connection URLs live in a single git-ignored `.env` file at
the repo root. Copy [`.env.example`](../../.env.example) to `.env` and change only what you
need — every value has a built-in default, so an empty (or absent) `.env` reproduces the
stock ports. This is the place to resolve port clashes with other projects on your machine.

The file drives everything from one source:

- **`compose.yaml`** reads it automatically for the container **host-port mappings**
  (`SARDEENZ_REDIS_HOST_PORT`, `SARDEENZ_POSTGRES_HOST_PORT`) and Postgres credentials. Only
  the host side of a mapping changes; the in-container port stays fixed.
- **Application services** load it at startup: the Rust proxy via `dotenvy`, the Node
  services (control plane, dashboard BFF, dev worker) via a small per-service `loadRootEnv()`
  helper (built on `dotenv`), and the Vite dev server via `loadEnv()`.

Values already set in the real environment always take precedence over the file, so
per-process overrides still work (e.g. `SARDEENZ_WORKER_PORT=9200 make dev-worker`), and the
loaders are no-ops in production. Integration and E2E suites load the same `.env`, so they
connect to whatever host ports you configured.

> **Two knobs per backing service.** When you move Redis/Postgres to a non-default host
> port, update **both** the compose host-port mapping **and** the matching connection URL
> (`SARDEENZ_REDIS_URL` / `SARDEENZ_DATABASE_URL`) so the apps dial the new port.

> **Note on `SARDEENZ_LISTEN_ADDR`.** The proxy and control plane historically shared this
> name. They now read `SARDEENZ_PROXY_LISTEN_ADDR` and `SARDEENZ_CONTROL_PLANE_LISTEN_ADDR`
> respectively (each still falling back to the legacy `SARDEENZ_LISTEN_ADDR`), so a single
> `.env` can set both independently.

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

Run `make` (or `make help`) to see all targets. Common combos (start `make services` first):

```bash
make dev-full       # whole stack + ONE worker (proxy, cp, dashboard, BFF, worker)
make dev            # stack only (proxy, cp, dashboard, BFF) — same as `npm run dev`; pair with your own worker
make dev-worker     # a single worker on its own (mode/ports from .env)
```

Or start pieces individually:

```bash
make dev-cp         # Control plane (Fastify dev server, :3000)
make dev-bff        # Dashboard BFF server (:4000) — the dashboard's /api backend
make dev-dashboard  # Dashboard Vite client (:5173) — needs the BFF too (dev-bff / dev)
make dev-proxy      # Proxy (cargo watch, requires Rust)
```

> The dashboard is two processes: the Vite client **and** the BFF. `make dev-dashboard` starts only
> the client (it proxies `/api` to the BFF), so run `make dev-bff` alongside it — or just use
> `make dev` / `make dev-full`, which start both.

## Dev Services

Backend services (Redis/Valkey and PostgreSQL) run via Podman Compose. The compose file is at the repo root (`compose.yaml`).

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

Host ports are the defaults; override them in `.env` (see "Local configuration").

| Service    | Image             | Default host port | Host-port var                 | Used by                                                       |
| ---------- | ----------------- | ----------------- | ----------------------------- | ------------------------------------------------------------- |
| `redis`    | `valkey/valkey:8` | 6379              | `SARDEENZ_REDIS_HOST_PORT`    | Proxy (routing map), control plane (state), integration tests |
| `postgres` | `postgres:16`     | 5432              | `SARDEENZ_POSTGRES_HOST_PORT` | Control plane (model + budget state)                          |

Prometheus will be added in a later phase.

### Connecting from code

The default connection URLs match the compose defaults with no extra configuration; change
them in `.env` if you remap the host ports above:

| Service      | Default URL                                              | Var                     |
| ------------ | -------------------------------------------------------- | ----------------------- |
| Redis/Valkey | `redis://localhost:6379`                                 | `SARDEENZ_REDIS_URL`    |
| PostgreSQL   | `postgresql://sardeenz:sardeenz@localhost:5432/sardeenz` | `SARDEENZ_DATABASE_URL` |

### Integration tests and the database

The control-plane integration tests **TRUNCATE tables**, so they never touch your dev database.
They reach the same Postgres/Redis **server** as the apps (via `.env`) but on a **dedicated test
database**, derived by suffixing the dev DB name with `_test` (e.g. `sardeenz` → `sardeenz_test`)
and a separate Redis logical DB (`1`). The test database is **auto-created** on first run if you
have `CREATE DATABASE` privileges (the local compose `sardeenz` superuser does); otherwise the
integration suite skips. As a safety net, the harness **refuses to run against any database whose
name doesn't end in `_test`**.

| Purpose                              | Var                          | Default                                     |
| ------------------------------------ | ---------------------------- | ------------------------------------------- |
| Override test Postgres               | `SARDEENZ_TEST_DATABASE_URL` | `<SARDEENZ_DATABASE_URL>` with `_test` name |
| Override test Redis                  | `SARDEENZ_TEST_REDIS_URL`    | `<SARDEENZ_REDIS_URL>` on logical DB `1`    |
| Bypass the `_test` guard (dangerous) | `SARDEENZ_ALLOW_NON_TEST_DB` | unset (guard active)                        |

## Common Commands

| Command              | Description                                                                     |
| -------------------- | ------------------------------------------------------------------------------- |
| `make` / `make help` | List all targets with descriptions                                              |
| `make all`           | Type-check and lint everything                                                  |
| `make lint`          | ESLint + clippy + OpenAPI spec validation                                       |
| `make lint-specs`    | Validate OpenAPI specs only (Redocly)                                           |
| `make format`        | Auto-format all files                                                           |
| `make format-check`  | Check formatting (CI-safe)                                                      |
| `make typecheck`     | TypeScript `tsc --build` + `cargo check`                                        |
| `make test`          | Run all test suites (Vitest + cargo test)                                       |
| `make test-python`   | Run the Python runner-shim + conformance suites (after `make test-python-deps`) |
| `make test-coverage` | Run tests with V8 coverage                                                      |
| `make codegen`       | Regenerate types from OpenAPI specs                                             |
| `make services`      | Start dev services (Redis + Postgres)                                           |
| `make services-stop` | Stop dev services                                                               |
| `make clean`         | Remove all build artifacts                                                      |

## Logs

Dev servers running on the host write their output to the `logs/` directory in the project root (gitignored). Since the project folder is bind-mounted into the ccbox container, Claude Code can read these logs directly to debug runtime issues without needing output pasted into the conversation.

### Starting dev servers with logging

```bash
# All components (proxy + control plane + dashboard + BFF) with file logging
npm run dev:logged

# All components without file logging (terminal only)
npm run dev

# Individual components with file logging
npm run dev:logged -w @sardeenz/control-plane
npm run dev:logged -w @sardeenz/dashboard
npm run dev:server:logged -w @sardeenz/dashboard
```

Each logged variant uses `tee` to write to both the terminal and a log file:

| Component     | Log file                    |
| ------------- | --------------------------- |
| Proxy         | `logs/proxy.log`            |
| Control plane | `logs/control-plane.log`    |
| Dashboard     | `logs/dashboard.log`        |
| BFF server    | `logs/dashboard-server.log` |

The proxy requires Rust/cargo — if not installed, it prints a warning and is skipped (the TypeScript components still start).

### Reading and clearing logs

```bash
npm run logs:proxy       # tail -f proxy logs
npm run logs:cp          # tail -f control-plane logs
npm run logs:dashboard   # tail -f dashboard logs
npm run logs:bff         # tail -f BFF server logs
npm run logs:all         # tail -f all log files
npm run logs:clear       # remove all log files
```

## Branching Strategy

The project uses `dev` as the integration branch and `main` as the release branch.

```
main ← stable releases only (PR from dev)
 └── dev ← active development (PR target for features and fixes)
      ├── feature/phase2-wake-orchestration
      ├── feature/dashboard-model-list
      └── fix/parking-timeout-race
```

**Rules:**

- **`main`** — always releasable. Only updated via PR from `dev`.
- **`dev`** — integration branch for all new work. Create feature and fix branches from `dev`, then PR back to `dev`.
- **Feature branches** — one per phase, feature, or fix. Branch from `dev`, PR to `dev`. Use prefixes: `feature/`, `fix/`, `chore/`.
- **Releases** — when `dev` is stable and tested, PR from `dev` to `main`. The merge to `main` marks a release.

**Workflow:**

```bash
# Start new work
git checkout dev
git pull origin dev
git checkout -b feature/my-feature

# ... develop, commit, push ...

# PR to dev (not main)
gh pr create --base dev

# After features accumulate on dev, release to main
gh pr create --base main --head dev
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
