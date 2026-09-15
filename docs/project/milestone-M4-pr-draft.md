# PR: Milestone M4 — Worker & Runner Lifecycle

**Branch:** `milestone-M4` → `dev`

## Summary

Five bug fixes hardening the dev-worker agent for real cluster operation: runner death handling, in-cluster reachability, port reclamation, launch-failure log retention, and deployment probes.

- **#112** — Failed launch leaks log buffers, hangs SSE log clients, discards failure logs. Fixed with TTL-based buffer retention (`retain()` + 5-min auto-drop, capped at 20), idempotent SSE cleanup with server-side `reply.raw.end()`.
- **#111** — Worker registers `managementUrl` as `http://localhost` (unreachable in-cluster) and the spec marks it optional while the control plane hard-requires it. Added `SARDEENZ_WORKER_ADVERTISE_HOST` (default `localhost`, set from `status.podIP` in K8s). Marked `managementUrl` required in the OpenAPI spec, rejecting workers without it at discovery.
- **#109** — Signal-killed runners never reaped (stop hangs forever, VRAM stays reserved) and no post-startup supervision. Fixed `stopChild()` to use an `exited` closure instead of `exitCode`-only check; added backstop timer (NOT unref'd) guaranteeing resolution; added `onExit` supervision callback that frees VRAM and cleans up on unexpected exit.
- **#114** — Runner ports allocated monotonically, never reclaimed. Replaced `nextPort` counter with bounded-range scanning (`SARDEENZ_MAX_RUNNERS`, default 32), port reuse via `usedPorts` Set, release in all cleanup paths, workerPort exclusion, injectable bind probe.
- **#118** — Signing-key import silently no-ops, no probes, heartbeat independent of health. Entrypoint now fails fast when verify is enabled and keyring is empty; added startup/liveness/readiness probes against `/healthz`; heartbeat gated on health check with TTL.

## Per-issue commits

| Issue | Commit    | Title                                                                                  |
| ----- | --------- | -------------------------------------------------------------------------------------- |
| #112  | `489f70a` | fix(dev-worker): fix failed launch log leak, SSE hang, and buffer retention            |
| #111  | `ee97e9f` | fix(dev-worker): use configurable advertise host and require managementUrl in contract |
| #109  | `2b0a377` | fix(dev-worker): reap signal-killed runners and add post-startup supervision           |
| #114  | `9e2f8e9` | fix(dev-worker): reclaim runner ports on stop/crash, bound allocation range            |
| #118  | `dcec239` | fix(dev-worker): validate signing-key import, add K8s probes, health-gate heartbeat    |

## Verification status

- **TypeScript compilation**: clean (TS + Rust cargo check)
- **ESLint**: clean
- **Lint-specs**: valid
- **Dev-worker tests**: 10 files, 154 tests — all pass
- **Control-plane tests**: 24 files, 273 tests — all pass
- **Codegen drift**: none

### Not locally verifiable (needs host/cluster)

- K8s probes behavior (pod restart on wedge, readiness gating)
- Signing-key import fail-fast (requires `apptainer` binary)
- In-cluster `managementUrl` reachability (requires multi-pod deployment)

## New configuration

| Env var                          | Default     | Component  | Description                                                                       |
| -------------------------------- | ----------- | ---------- | --------------------------------------------------------------------------------- |
| `SARDEENZ_WORKER_ADVERTISE_HOST` | `localhost` | dev-worker | Advertised host for managementUrl and runner host; set from `status.podIP` in K8s |
| `SARDEENZ_MAX_RUNNERS`           | `32`        | dev-worker | Max concurrent runners; bounds the port allocation range                          |

## Closes

Closes #109, Closes #111, Closes #112, Closes #114, Closes #118
