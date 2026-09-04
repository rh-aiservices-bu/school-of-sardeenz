# Control Plane — AGENTS.md

TypeScript (Fastify) orchestrator: model lifecycle, instance placement, VRAM budget, LRU eviction,
sleep/wake, worker pool, runner catalog import, and the routing map the proxy consumes. State is
Postgres (models, instances) + Redis/Valkey (routing map, worker reports, pub/sub, claims).

**Architecture:** [`docs/architecture/overview.md`](../docs/architecture/overview.md) (Control
Plane section, request flows, data architecture). **Key ADRs:**
[009 state & persistence](../docs/architecture/adrs/adr-009-state-and-persistence.md),
[011 placement](../docs/architecture/adrs/adr-011-worker-capabilities-and-placement.md),
[014 recency tracking](../docs/architecture/adrs/adr-014-inference-recency-tracking.md),
[019 model vs instance](../docs/architecture/adrs/adr-019-logical-model-vs-instance-split.md),
[020 naming split](../docs/architecture/adrs/adr-020-config-name-vs-served-model-name.md).
**API:** [`packages/contracts/specs/control-plane.yaml`](../packages/contracts/specs/control-plane.yaml)
(dashboard-facing), `proxy-control-plane.yaml` (proxy-facing), `worker-agent.yaml` (what it calls
on workers).

## Layout

| Path            | Role                                                                                                                                                                                                                                                                                        |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/config.ts` | All `SARDEENZ_*` env vars with defaults and validation                                                                                                                                                                                                                                      |
| `src/server.ts` | Fastify app assembly, auth hook, route registration                                                                                                                                                                                                                                         |
| `src/routes/`   | `models`, `workers`, `cluster`, `catalog`, `weights`, `model-logs`, `notifications`, `internal` (proxy wake), `deps` (typed DI bag)                                                                                                                                                         |
| `src/services/` | One service per concern: `model-lifecycle`, `deploy-orchestration`, `placement`, `memory-budget`, `eviction`, `sleep-wake`, `reconciliation`, `routing-map`, `worker-pool`, `leader-election`, `catalog-service`, `sif-importer`, `module-store`, `instance-repository`, `model-repository` |
| `src/clients/`  | `database` (pg), `redis`, `worker` (worker-agent API), `runner` (engine-runner API), `migrations`                                                                                                                                                                                           |
| `src/health/`   | Probes + Prometheus metrics                                                                                                                                                                                                                                                                 |
| `migrations/`   | Numbered SQL migrations, applied at startup                                                                                                                                                                                                                                                 |

## Invariants (do not break)

- **Model vs instance (ADR-019):** a logical model owns N instances; state, placement, and
  routing entries are per instance. Never collapse them.
- **Naming (ADR-020):** `name` is the configuration name (unique key), `servedModelName` is what
  the engine serves and the proxy routes on, `displayName` is cosmetic.
- **Memory doctrine (#163):** `usedBytes` **is** the measured NVML figure; there is no separate
  ledger and no user-facing "reserved" number. In-flight placement holds only lower
  `availableBytes` internally and are never exposed as a field. Read the header comment in
  `services/memory-budget.ts` before touching budget math.
- **Long-running ops hold a claim** (delete / stop / instance ops). Conflicts answer `409` with
  `details.reason` (`delete-in-progress`, `stop-in-progress`, …) as documented in the contract.
- **Leader election:** background loops (reconciliation, eviction, health) only run on the leader.
- **Trust boundary:** every route is behind the auth hook (`SARDEENZ_API_TOKEN`); workers use
  `SARDEENZ_WORKER_TOKEN`. Plain `http://` catalog sources are rejected unless
  `SARDEENZ_ALLOW_INSECURE_CATALOG` is set (dev only); imported SIFs are verified unless
  `SARDEENZ_VERIFY_SIF` is disabled.

## Build & Test

```bash
npm run typecheck -w @sardeenz/control-plane
npm run test -w @sardeenz/control-plane               # vitest unit tests (services/__tests__, routes/__tests__)
npm run test:integration -w @sardeenz/control-plane   # needs Postgres + Redis (see setup.md "Dev Services")
```

Dev server: `make dev-cp` (or `npm run dev:logged` → `logs/control-plane.log`). Env comes from
the repo-root `.env` via `src/load-env.ts`. Migrations: add a new numbered file in `migrations/`,
never edit an applied one.
