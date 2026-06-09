# Development Setup

## Prerequisites

Sardeenz development uses a containerized environment ([ccbox](https://github.com/guimou/ccbox)) that provides all required tooling. If working outside the container, install:

- **Node.js** >= 22 with npm
- **Rust** stable toolchain (via [rustup](https://rustup.rs/)) with `rust-analyzer`, `clippy`, and `rustfmt` components
- **Prettier** (`npm install -g prettier`)
- **ripgrep** (recommended for fast code search)

## First-Time Setup

```bash
# Install all npm workspace dependencies
npm install

# Verify the setup
make typecheck  # TypeScript type checking
make lint       # ESLint + clippy (if Rust available)
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

## Common Commands

| Command             | Description                              |
| ------------------- | ---------------------------------------- |
| `make all`          | Type-check and lint everything           |
| `make lint`         | ESLint + clippy                          |
| `make format`       | Auto-format all files                    |
| `make format-check` | Check formatting (CI-safe)               |
| `make typecheck`    | TypeScript `tsc --build` + `cargo check` |
| `make test`         | Run all test suites                      |
| `make codegen`      | Regenerate types from OpenAPI specs      |
| `make clean`        | Remove all build artifacts               |

## Logs

Dev servers running on the host write their output to the `logs/` directory in the project root (gitignored). Since the project folder is bind-mounted into the ccbox container, Claude Code can read these logs directly to debug runtime issues without needing output pasted into the conversation.

Each component pipes its output to a separate log file:

```bash
# Example: start the control plane and capture logs
npm run dev -w @sardeenz/control-plane > logs/control-plane.log 2>&1 &
```

## IDE Configuration

The repo includes `.editorconfig` for baseline formatting. Most editors respect this automatically.

For VS Code (if not using ccbox), recommended extensions:

- ESLint
- Prettier
- rust-analyzer
- EditorConfig for VS Code
