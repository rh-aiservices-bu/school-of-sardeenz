# PR draft — Milestone M7: Multi-Instance & Move Foundations

> Working file for the milestone PR from `milestone-M7` into `dev`. Delete after use.

## Title

```
Milestone M7: Multi-Instance & Move Foundations (#121, #120)
```

## Body

Executes milestone **M7** issue by issue on `milestone-M7` (5 commits, one squash per issue plus
verification/DX fixes). Each issue went through blueprint → implementation → multi-dimension
review rounds → post-integration verification → independent acceptance audit.

### #121 — Model-record semantics + Stop/Start lifecycle (`d8339de` + `c2cf5a2`)

- **Decision (option A, recorded on the issue):** a model record is a configuration registry
  entry that outlives its runner. No schema change, no migration; `STOPPED` = absence of Redis
  lifecycle state (synthesized at read).
- New `POST /api/v1/models/{modelName}/stop` (teardown runner, keep record; settled states only,
  409 on transient states, synchronous claim kills the double-Stop race) and
  `POST /api/v1/models/{modelName}/start` (re-deploy from the stored record via the extracted
  `deployFromRecord` helper; re-validates weights-path containment; 409 when runtime state
  exists). Placement re-runs on Start — the model may land on a different worker.
- Dashboard per-state Start/Stop actions (list + detail, confirm modals, i18n); contract + docs
  now describe `STOPPED` as "configured but not running" everywhere (grep-verified).
- Review arc: 4 parallel reviewers → 1 real medium (Stop-on-transient-state race → orphaned
  runner holding unbudgeted VRAM) fixed in round 1; round 2 clean.

### #120 — Logical model vs. instance split (`6628e09`)

- **ADR-019** (Accepted, in-diff): model name = logical model; N instances per model, each a
  runner process with its own lifecycle, VRAM reservation, and endpoint. Refines ADR-014
  (eviction candidacy per-instance; recency per logical model).
- `instances` table (migration `003-instances.sql`, additive, no backfill); instance-keyed Redis
  lifecycle (`models:{name}:{instanceId}`, CP-minted `inst-<12hex>`); derived aggregate state
  (ACTIVE if ≥1 instance ACTIVE).
- API: `POST /models/{name}/instances` creates a replica (**same or different worker** — the
  dev-worker agent now runs N runners per model, takes `StartRunnerRequest.instanceId`, serves
  `GET /runners/by-instance/{id}/logs`); instance-scoped `DELETE`/`sleep`/`wake`; model-level
  actions fan out per-instance with error isolation. **Breaking `control-plane.yaml` response
  change** (`instances[]`, aggregate state, counts) — dashboard/BFF/e2e mocks updated in the
  same diff.
- Internal `updateEndpointWeight` routing-map primitive (atomic Lua, inherits the #79-safe
  encoder): the scripted move (deploy new → weight→0 → drain → remove old) completes with
  **zero failed requests** under concurrent load in the integration suite.
- Reconciliation: per-instance recovery, run-once legacy-key prune, orphaned-instance reaper
  (read-skew-safe sequential two-store read + per-candidate recheck).
- **Proxy: zero diff** across the milestone — the data path was already multi-endpoint.
- Review arc: 4 rounds, each catching real defects in the prior round (SCAN-glob injection,
  teardown abort, key orphans → claim-leak regression → HIGH read-skew race in the reaper →
  fixed + confirmed). Round 4 was a single-HIGH surgical fix approved past the 3-round cap.

### #141 — Integration harness fixture vs. M6 WorkerInfo validation (`cd30961`)

Adopted into the run (blocked all integration verification): harness fixtures rebuilt from the
generated contract types (enum-typed; future drift fails `tsc`). Suite went 3/11 → 10/11 on
`dev`; the remaining failure is #142 (pre-existing, filed).

### DX (`15026ae`)

`make dev-full-logged` — full stack + one worker via the `:logged` scripts, worker tee'd to
`logs/worker.log`, catalog path corrected for repo-root cwd.

## Verification status

- All gates green at `6628e09`: `make typecheck` / `make lint` / `make lint-specs` /
  codegen-drift clean (cargo gates ran in-container — Rust toolchain available).
- Unit: control-plane 376/376, dashboard 379/379, dev-worker 173/173.
- Integration (live dev Postgres/Redis): 16/17 — the 1 failure is the pre-existing #142 regex
  mismatch. New instances file 5/5 (all four #120 acceptance criteria, incl. the scripted move).
- Live dev-stack runtime: #121 stop/start round-trip and #120 same-worker second replica,
  independent instance delete, glob-guard 400, model-level stop/start/delete all verified via
  curl; a real model reached ACTIVE under a genuine vLLM SIF.
- **Not verified locally:** instances UI has no e2e/browser coverage (unit+typecheck only) —
  explicit requirement added to #128; M8 (#123/#124) rebuilds these views. Two-ACTIVE-endpoint
  live traffic not reproducible on the single stub worker (integration test is the evidence).
- **Needs cluster:** nothing new — no proxy, container, or manifest changes in this milestone.

## Issues filed during the run

- #140 — DELETE-during-deploy race (pre-existing class; Stop's variant fixed in #121)
- #141 — integration fixture staleness (fixed in this PR)
- #142 — deploy-timeout test regex mismatch (pre-existing, unmasked by #141)
- #143 — root eslint should ignore `.claude/` worktrees
- #144 — dev-worker `npm test -w` vitest cwd resolution

## Closes

closes #121, closes #120, closes #141
