# PR draft — milestone-M10 → dev

> Drafted by the M10 execution (2026-09-02). Copy the title/body into the PR when
> ready; delete this file after use. The branch is local and not pushed.

**Title:**

```
M10: control-plane orchestration correctness (#140 DELETE race, #147 worker capability fields)
```

**Body:**

```markdown
## What this PR does

Closes both open issues of milestone M10 (control-plane orchestration
correctness), in the milestone's mandated order (#140 before #147).

### #140 — DELETE /models racing an in-flight launch (P2)

`DELETE /api/v1/models/{modelName}` on a model in a transient state
(`PENDING`/`STARTING`/`DRAINING`) tore down while the fire-and-forget
deploy/start/wake launch was still in flight: the VRAM reservation and the
lifecycle key were released while `startRunner` was still completing on the
worker — an orphaned runner holding VRAM the budget counts as free.

Per the decision comment on the issue (409, not force-teardown: no cancel
primitive exists for the dispatched launch, and the wedged-model escape hatch
is the `ERROR` state, which stays deletable):

- Both DELETE handlers (model-level and instance-scoped) now reject transient
  states `PENDING`/`STARTING`/`DRAINING`/`STOPPING` with 409 `INVALID_STATE`,
  mirroring the #121 Stop semantics; settled states
  (`ACTIVE`/`SLEEPING`/`STOPPED`/`ERROR`) remain deletable with 202.
- New model-level `deletingInFlight` claim set (guard → claim → backgrounded
  teardown, released in `finally`) closes the concurrent double-delete window.
- Guard is per-instance (`instances.some(…)`), not on the derived aggregate —
  a model with `ACTIVE`+`STARTING` instances cannot mask the race.
- Control-plane contract **v0.1.2** (additive, ADR-005 flow): 409 descriptions
  on both delete operations reworded to name the transient states and the
  in-progress-delete case; `503 NOT_LEADER` documented on both (pre-existing
  gap, sibling `stopModel` pattern); additive 409 on `deleteModelInstance`;
  generated TS types regenerated (commit carries the generated file).

### #147 — worker endpoints under-reported runner capabilities (P3)

`GET /api/v1/workers` and `GET /api/v1/workers/{workerId}` each mapped 5 of the
9 `WorkerRunnerCapability` schema fields inline — dropping
`maxTensorParallelism`/`kvCacheElasticSharing` (defaulted in the spec,
non-optional in the generated types) and the optional `engineVersion`/`features`
— so consumers typed against the contract saw `undefined` for fields the
response schema declares.

- One shared `toRunnerCapability` mapper now serves both call sites, emitting
  all 9 schema fields (optionals omitted when not worker-reported).
- The issue's part 2 (instance-state filter divergence) was already fixed
  in-tree by `51b567a`; it is executed as verify + regression pins: new tests
  prove a `PENDING` instance carrying a VRAM measurement is still excluded
  from the per-instance model lists in both `workers.ts` and `cluster.ts`.
- No contract change — the spec already declared all fields.

### Chore (environment follow-up to #143)

`d9d3c1a` — root eslint ignores `**/.qwen/worktrees/` (worktrees moved there
from `.claude/`; `make lint` from the main checkout flooded with parse errors
while a milestone worktree existed).

## Verification

All gates run locally on `milestone-M10` (cargo present in the execution
environment — no "needs host run" gates):

- `make typecheck` PASS (tsc --build, dashboard e2e, cargo check)
- `make lint` PASS (Redocly lint-specs, root eslint, cargo clippy -D warnings)
- Codegen drift check clean (fresh `npm run codegen -w @sardeenz/types` → zero diff)
- `@sardeenz/control-plane` vitest: 502/502 (13 new #140 cases, 6 new #147 tests)
- `cargo test` (proxy, untouched by both issues): 124/124
- Both issues additionally passed a 4-reviewer / 3-reviewer panel (spec
  conformance, code quality, security, contract boundary where applicable) and
  an independent fresh-agent acceptance check with an un-fakeable spot re-run.

**Not verifiable without a live environment (needs the dev stack / cluster):**

- Live smoke test: `DELETE` on a model in `PENDING`/`STARTING` returns 409;
  on `ERROR`/`ACTIVE` returns 202 (unit tests exercise the same paths).
- Live `GET /api/v1/workers` showing `maxTensorParallelism` /
  `kvCacheElasticSharing` / `engineVersion` in real responses.
- `npm run test:integration -w @sardeenz/control-plane` (needs Postgres/Redis
  from `compose.yaml`).
- Multi-node/leader-failover behavior (the new claim set is process-local by
  design, same pattern as the pre-existing `stoppingInFlight`).

## Deferred / tracked separately

- **#171** (Parking Lot, filed during #140's security review): the pre-existing
  record-only DELETE path (zero visible instances) racing a concurrent deploy's
  instance creation — identical in the pre-M10 tree, backstopped by
  `reapOrphanedInstances`, no VRAM over-subscription.
- #147 polish lows (recorded in the issue's status comment): a JSDoc line
  stating the mapper's parse-time invariant, a combined 9-field `toEqual`,
  the detail-harness worker-id mismatch, import placement.
- Pre-existing context noted during #147's security review (out of scope):
  uncapped worker-reported `features` object at ingest; endpoints
  unauthenticated when `SARDEENZ_API_TOKEN` is unset.

## Notes

- Contract bump is additive-only (v0.1.1 → v0.1.2); the proxy is stateless and
  never calls these endpoints — no Rust mirror change (verified: zero
  references in `proxy/`).
- Issues are left open and will auto-close on merge via the `Closes` lines.

Closes #140
Closes #147
```
