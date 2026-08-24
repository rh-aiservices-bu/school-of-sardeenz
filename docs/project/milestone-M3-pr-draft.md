# PR: Milestone M3 — Orchestration Correctness (Control Plane)

**Branch:** `milestone-M3` (9 commits, local — not pushed)
**Base:** `dev`

## Summary

Control-plane state stays correct under failure: crash on delete, eviction tombstones and scoping, VRAM reservation accounting, sleep timeouts, SSE leaks, leader election — plus truthful shim memory reporting (#116) that the accounting depends on.

- **#84** — Background model deletion no longer risks crashing the process on an unhandled promise rejection
- **#90** — Deleted the consumer-less `GET /api/v1/events` SSE route (contract change: path removed from OpenAPI spec)
- **#91** — Leader election requires `SARDEENZ_SINGLE_INSTANCE` for non-K8s; lease failures logged with throttling; `/readyz` distinguishes follower from failing election
- **#116** — vLLM shim reports cluster-global GPU indices via `SARDEENZ_DEVICE_INDICES` env var; `activeRequests` scraped from vLLM `/metrics` instead of hardcoded 0; control plane treats missing value as "unknown" (keeps draining)
- **#86** — Deploy-path eviction scoped to eligible workers via `PlacementPipeline.eligibleWorkerIds()`; eviction moved off the HTTP request path into a background task (202 immediate)
- **#85** — DELETE accepts evicted tombstone models (DB-only) and STOPPED state; registry semantics per #121
- **#87** — VRAM reservations tracked per-model with explicit release on every terminal transition; `clearSatisfiedReservations` heuristic deleted
- **#89** — `/sleep` call uses configured `SARDEENZ_SLEEP_TIMEOUT_SECS` instead of 30s client default
- **#96** — Low-severity bundle: graceful shutdown (hijacked-response registry + hard-exit timer), unreachable `RUNNER_TIMEOUT` (new `delaySafe()`), zero-size eviction filter, per-device gauge label, notification read-set elimination, `modelName` pattern validation

## Verification status

| Gate                                        | Result                         |
| ------------------------------------------- | ------------------------------ |
| `tsc --build` (TS + Rust)                   | PASS                           |
| ESLint                                      | PASS                           |
| `cargo clippy --all-targets -- -D warnings` | PASS                           |
| `make lint-specs` (Redocly)                 | PASS (5 pre-existing warnings) |
| Vitest unit tests                           | 274/274 PASS (24 files)        |
| pytest (vLLM shim)                          | 17/17 PASS                     |
| Vitest (dev-worker)                         | 129/129 PASS                   |

### Needs host run

- `cargo test` — ran locally in the container (PASS), but verify on host
- Integration tests (`npm run test:integration -w @sardeenz/control-plane`) — require Postgres + Redis from `compose.yaml`

### Not locally verifiable

- Cluster-gated: SIF signing chain, CephFS perf, kvcached co-location
- Dashboard visual verification (no Playwright in this environment)

## Deferred items

- **#116 co-tenancy double-count:** Device index fix is complete; actual VRAM dedup under co-location deferred to Phase 5 co-location policy
- **#96 item 5 markAsRead TOCTOU:** LRANGE+LSET is not atomic; concurrent LPUSH can shift indices. Acceptable for notification-tier data.

Closes #84, #85, #86, #87, #89, #90, #91, #96, #116
