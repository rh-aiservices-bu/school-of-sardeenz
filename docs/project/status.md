# Project Status

Living record of what is delivered and what comes next. Update when a phase or milestone closes.
Last update: 2026-11-25 (M18 CI & test infrastructure implemented on
`milestone/m18-ci-test-infrastructure` — four issues delivered, the new CI integration job is
staged advisory until #322 lands — and the M19 docs/contracts items closed: #249 via #319, #248 via
#320, #268 via #273. Release 0.2.1 remains recorded in `CHANGELOG.md` and the proxy's Cargo version.
The vLLM SIF republish (`rc2` + `runners.yaml` digest bump) and the on-cluster rollout proof for
#247 remain pending.)

## Phases (complete)

| Phase | Scope                                                                    | Plan                                                                                                                   |
| ----- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| 0     | Engine runner contract (spec only)                                       | [`phase0.md`](phase0.md)                                                                                               |
| 1     | Rust proxy with connection parking                                       | [`phase1.md`](phase1.md)                                                                                               |
| 2     | Control plane sleep/wake orchestration                                   | [`phase2.md`](phase2.md)                                                                                               |
| 3     | Admin dashboard (fresh build)                                            | [`phase3.md`](phase3.md)                                                                                               |
| 3.6   | Dev worker agent — local-process worker with runner stubs                | [`phase3.6.md`](phase3.6.md)                                                                                           |
| 4     | SIF runner runtime (Apptainer) — spike verdict GO                        | [`phase4.md`](phase4.md), [`phase4-apptainer-spike.md`](phase4-apptainer-spike.md), [`phase4-perf.md`](phase4-perf.md) |
| 5     | kvcached oversubscription & co-location policy — Gate 9b PASS on-cluster | [`phase5.md`](phase5.md), [`phase5-gate9b-run.md`](phase5-gate9b-run.md)                                               |

Phase 4 delivered the `containers/` runner images, the `RunnerLauncher`/`ApptainerLauncher`
worker-agent abstraction, the vLLM runner shim (`runners/vllm/`), the
`runtimeModule`/`kvCacheElasticSharing` contract additions, the SIF librarian pipeline
(`deployment/librarian/`, `scripts/build-sif.sh`), the worker security + Deployment manifests
(`deployment/sif-runner/`), and the spike-gate integration suite (`tests/gates/`).
Cluster/GPU-gated acceptance (live image builds, SIF conversion, SCC admission, kvcached Gate 9,
CephFS perf) is tracked in [`phase4.md`](phase4.md) and [`phase4-perf.md`](phase4-perf.md).

## Phase 5 delivered (merged to `dev`)

Phase 5 merged via PR #281 (`06ff80a`), with the decisions ratified as
[ADR-029](../architecture/adrs/adr-029-colocation-hold-and-pressure-stop.md) (#283). It delivered the
co-location placement policy (#276: `allowCoLocation` opt-in, fail-closed capability guard,
capped KV-pool headroom, per-device wake pre-check with group-scoped wake eviction), the
consumer-side attribution rule (#278: `attribution` on `InstanceMemoryMeasurement` with the
shared control-plane summation helper — closing the #244 per-model double-count residual), the
shared-pool pressure response (#277: reconciliation pressure step, stop-based relief from the
device's co-location group, off by default), and [`phase5.md`](phase5.md) with the Gate 9b
recipe (#279). Gate 9b ran on-cluster on 2026-11-17 —
[`phase5-gate9b-run.md`](phase5-gate9b-run.md) — and passed: the control plane admitted a 20 GiB
requirement against 18.01 GiB of available device memory (elastic headroom), refused the same
requirement with the opt-in off, and NVML under concurrent inference on two co-located models
stayed at 5,934 of 23,034 MiB. The run surfaced four follow-up bugs
([#286](https://github.com/rh-aiservices-bu/school-of-sardeenz/issues/286),
[#287](https://github.com/rh-aiservices-bu/school-of-sardeenz/issues/287),
[#288](https://github.com/rh-aiservices-bu/school-of-sardeenz/issues/288),
[#289](https://github.com/rh-aiservices-bu/school-of-sardeenz/issues/289)).

## Milestones (merged to `dev`, plus the open ones)

| Milestone | Theme                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M2        | Reliable Wake-on-Request                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| M3        | Orchestration Correctness                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| M4        | Worker & Runner Lifecycle                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| M5        | Security & Trust Boundaries                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| M6        | Contracts & Docs Accuracy                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| M7        | Multi-Instance & Move Foundations ([ADR-019](../architecture/adrs/adr-019-logical-model-vs-instance-split.md))                                                                                                                                                                                                                                                                                                                                                            |
| M8        | Dashboard v1 Parity                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| M9        | Engine Expansion — MLServer, `/openai` and `/oip` proxy split ([ADR-021](../architecture/adrs/adr-021-protocol-family-path-prefixes.md))                                                                                                                                                                                                                                                                                                                                  |
| M10       | Control-Plane Orchestration Correctness — delete/stop/instance-op claims, 409 `details.reason`                                                                                                                                                                                                                                                                                                                                                                            |
| M11       | Dashboard Stability & Test Infrastructure — Playwright e2e green and enforced in CI                                                                                                                                                                                                                                                                                                                                                                                       |
| M12       | Runner & Engine Hardening — configurable vLLM bind host, per-runner 4-port blocks, Python suites gated in CI                                                                                                                                                                                                                                                                                                                                                              |
| M13       | Feature & Resilience Backlog — move-model action (#146), playground stream cap (#149), dashboard notification/e2e follow-ups (#178/#179), proxy→engine NetworkPolicy rule (#181), CI container-image builds (#187)                                                                                                                                                                                                                                                        |
| M14       | Dependency Security Remediation — Dependabot alert sweep across npm/cargo: fast-jwt (#224), undici (#225), react-router-dom (#226, → v7 in #229), @fastify/static → v10 (#231), rustls/quinn-proto (#259), vitest → 4 (#228/#262), transitive sweep (#261)                                                                                                                                                                                                                |
| M15       | Security Hardening — Cluster & Auth — Dependabot automation (#233), labeled Namespace prereq (#232), Valkey AUTH + default-deny NetworkPolicies (#230), manifest hardening manifest-half (#235), instanceId validation (#236), fail-closed tokens (#234), SSE-only query-token gate (#237), worker entrypoint allowlist (#238)                                                                                                                                            |
| M16       | Orchestration Resilience — Proxy & Control Plane — async wake eviction (#242), piggybacked-parker wake-trigger fast-fail (#245), crashed-worker Redis key flap (#240), phantom device-memory gauges (#254), protocol-family admission (#246), control-plane dead config + proxy hot-path cleanups (#258, two PRs)                                                                                                                                                         |
| M17       | Runner & Shim Correctness — vLLM labeled-metric scrape (#239), launcher health-probe timeout (#243), device-scope memory attribution (#244), executor offload of blocking reads (#253), worker start fixes (#257); per-issue detail in that milestone's CHANGELOG entry and Notable changes below                                                                                                                                                                         |
| M19       | Deployment, Release & Docs Hygiene — Phase 5 co-location (#276 placement, #278 attribution rule, #277 pressure response, #279 phase doc + Gate 9b recipe) merged via #281 and its Gate 9b run recorded; publish/rollout documented, pull policy fixed (#247/#211); image hardening (#266 via #316), ADR-016/SCC wording reconciled (#267 via #318); release 0.2.1 recorded (#249 via #319), 409 reason enum (#248 via #320), token gate (#268 via #273) closed; #315 open |
| M18       | CI & Test Infrastructure (implemented on `milestone/m18-ci-test-infrastructure`, not merged) — integration suite gated in CI, staged advisory pending #322 (#251), conformance conflict/ERROR/poller coverage (#252), dashboard unit-test renderability (#176), lint ignores mkdocs `site/` (#314)                                                                                                                                                                        |
| M20       | Dashboard Performance & Resilience (open) — SSE re-render scope, route code splitting, one charting stack (#255); BFF timeout/abort propagation + ErrorBoundary route coverage (#256)                                                                                                                                                                                                                                                                                     |

Also merged outside a milestone: the configuration-name vs. served-model-name split
([ADR-020](../architecture/adrs/adr-020-config-name-vs-served-model-name.md), #154) and the
measured-only VRAM telemetry doctrine (#163/#164, ts-nvml).

Milestone PR drafts: [`milestone-M3-pr-draft.md`](milestone-M3-pr-draft.md) through
[`milestone-M9-pr-draft.md`](milestone-M9-pr-draft.md).

## Releases

| Release  | Date       | Record                                                                                                                                                                                         |
| -------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `v0.2.0` | 2026-09-15 | First v2 release, tagged on the `dev` → `main` merge of #209 (`2088868`). Per-change detail in `CHANGELOG.md` `[0.2.0] - 2026-09-15`.                                                          |
| `0.2.1`  | 2026-10-29 | Version bump `3c92d45` (`package.json`, an end-to-end PR → image-publish pipeline exercise). Recorded in `CHANGELOG.md` `[0.2.1] - 2026-10-29`; `proxy/Cargo.toml` aligned. **No tag exists.** |

## M19 — Phase 5 (merged) and the image/supply-chain half

Phase 5 (kvcached oversubscription & co-location policy) merged via PR #281 and its deploy-only
verification ran on 2026-11-17 ([`phase5-gate9b-run.md`](phase5-gate9b-run.md)). The
image/supply-chain half of the theme is closed — #266 (digest pins, non-root worker `USER`, Trivy
scan, cosign sign) merged via #316 and #267 (ADR-016/SCC wording) via #318. The theme also carried
the four defects the Gate 9b run raised (#286–#289); all four are fixed and merged. #287's code
half is merged, but its remedy is operational:
the published vLLM SIFs still predate #275 and must be republished (`rc2`) and re-imported — the
runbook is in [`../usage/runner-catalog.md`](../usage/runner-catalog.md).

#247 documents the platform-image half of the intended manual flow — publish, pin through the
overlay's `images:` block, roll out — and removes the mutable-tag footgun (`imagePullPolicy:
Always` on all four platform Deployments); its registry re-resolution and worker-restart
behaviour are deploy-only and unproven until the first rollout.

In progress:
nothing else in M19 (M18's milestone branch is recorded in its own section below).

| Issue | Delivered                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| #276  | Co-location placement policy: a model opts in with `allowCoLocation` on the deploy request (migration `008-add-allow-co-location.sql`, dashboard deploy-form switch); the placement pipeline may then place past naive byte-sum capacity iff every resident instance on the device — including sleeping ones (sleep never releases the VRAM hold) — belongs to a runner type declaring `kvCacheElasticSharing` and the device reports a kvcached pool. Fail-closed capability guard: an unresolvable co-resident (deleted model record, dropped runner-type report, any unknown-placement resident — including an ERROR instance retaining its hold) blocks co-location, so non-kvcached runners are never silently co-located (the phase-4 OOM guard). Headroom is `min(min(freeBytes + preallocBytes, poolTotal), cap% × poolTotal)` with `SARDEENZ_COLOCATION_MAX_POOL_HEADROOM_PERCENT` (integer 0–100, default 50, 0 disables; boot-validated — the control plane refuses to start on a bad value). `placeFixed` (move) applies the same rules and still never evicts. The wake pre-check is per-device and excludes the waking instance's own hold (the old worker-wide sum produced a phantom shortfall); wake-eviction victims are scoped to the waker's device co-location group (`coLocationGroup` in `placement.ts` — the single derivation #277 imports), sized per device, bounded by `SARDEENZ_EVICTION_MAX_PER_CYCLE`; legacy instances without `deviceIndices` keep the worker-wide fallback.                                                                                                                                                                                                                                                                                                            |
| #278  | Consumer-side attribution rule (closes the #244 residual): the worker-agent contract's `InstanceMemoryMeasurement` gains the optional `attribution: "runner" \| "device"` field — the worker stamps NVML rows `"runner"` and promotes a no-NVML ledger row only while its runner is the device's sole record — and the control plane scope-checks every per-instance summation site through one shared helper (`sumInstanceMeasurementsByInstance`): `runner`-scope rows sum; a `device`- or unknown-scope row is kept only while it is its device's sole >0-byte row, else dropped, so `/api/v1/cluster/memory`, `/api/v1/workers/:workerId`, and the models' `currentMemory` can never double-count a co-located whole-device figure. Two co-located models on a worker without NVML no longer render two whole-device bars; dropped bytes surface in the dashboard's "Other" bucket. Legacy workers not labeling a scope lose per-model display for unlabeled co-located rows until they upgrade (the conservative direction); unlabeled sole-resident rows keep displaying.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| #277  | Shared-pool pressure response: the reconciliation tick gains `evaluatePoolPressure` (directly after `refreshMemoryBudgets`) — when a device's kvcached pool stays at/above `SARDEENZ_POOL_PRESSURE_THRESHOLD_PERCENT` (default 90) of `totalBytes` for `SARDEENZ_POOL_PRESSURE_DEBOUNCE_TICKS` (default 3) consecutive ticks, the control plane reclaims capacity through the existing `EvictionEngine`, the system's first memory-pressure eviction trigger (eviction is otherwise demand-only). Victims come only from the pressure device's co-location group (a pressure event on device D never tears down a co-tenant on device E; solo-device guard) and are **stopped** — `stopModel` deliberately drain-free (the null runner client skips `waitForDrain`: pressure relief cuts in-flight requests instead of waiting on the traffic causing the pressure), then a best-effort `stopRunner` reap whose non-404 failure reclassifies the stranded STOPPED record as observable ERROR; holds release in `stopModel`; sizing by configured `requiredMemory` (the overshoot for a pool-sized problem is accepted). The wave's `requiredBytes` targets `SARDEENZ_POOL_PRESSURE_RELEASE_TARGET_PERCENT` (default 75, must stay below the threshold — boot cross-check); one tick's fired devices share one `SARDEENZ_EVICTION_MAX_PER_CYCLE` budget; each stopped victim logs a wave record, sends a danger notification, and publishes the first `EVICTION_TRIGGERED` cluster event (existing enum, no contract change). Stale budgets, missing `kvCache` blocks, and zero pool totals never trigger (telemetry tolerance is structural). Off until `SARDEENZ_POOL_PRESSURE_ENABLED=true` (shipped `'false'` in `deployment/`); leader failover resets the in-memory debounce counters (the conservative direction). |
| #279  | [`phase5.md`](phase5.md): the phase document (goal, per-issue design notes, deliverables) plus the **Gate 9b recipe** — the deploy-only, control-plane-driven co-location verification complementing worker-driven Gate 9 (which asserts `deviceIndex` only): deploy two `allowCoLocation: true` vLLM models pinned to one device through the CP, assert both ACTIVE with both runners' `/memory-report` `kvCache` blocks satisfying the `KVCachePoolStats` partition invariant (`totalBytes = usedBytes + preallocBytes + freeBytes`), an optional concurrent-inference smoke, and a required NVML reality check (see the deploy-only list below). Also: `overall-plan.md`'s Phase 5 section points at the phase doc, and `phase4.md`'s deferred-OOM-guard sentence is closed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

Review/verification ran per issue (blueprint/implement → 2× review → fix → verify → accept);
cumulative reports in `.omp/reports/` (agent scratchpad, not committed). Cumulative gate:
typecheck (dev-worker + control-plane) clean, full vitest + the scoped new suites green, Python
shims + conformance green, contracts validate + codegen reproducibility; per-issue numbers in
the `.omp/reports/build-27*.md` / `review-*` / `verify-*` / `accept-*` files.

## M18 — CI & Test Infrastructure (implemented on a milestone branch, not merged)

Branch `milestone/m18-ci-test-infrastructure` off `dev@129d5ec`, four issues, each through
review → verify → acceptance:

- **#314** — `site/` (the gitignored mkdocs output) joins the ESLint flat config's global ignores, so
  `make docs-build` no longer poisons `make lint`. One line in `eslint.config.js`; no other build
  output was excluded. The exact ~1454-error repro is CI-only here (no mkdocs in this container); the
  proof was a synthetic `site/` file with and without a matching ignore.
- **#252** — the shared engine-runner conformance suite grows 8 → 13 named cases (16 → 25 tests):
  `409` while `STARTING` on `/sleep` and `/memory-report` (both shims), vLLM's in-flight `/sleep`
  guard behind a per-adapter `CONFORMANCE_FEATURES` capability set (never a shim name), `ERROR`
  surfaced in `/health` after the engine dies, `/wake` from a non-sleeping runner pinned at today's
  `200` (documented divergence from the spec, alignment tracked as #323), and three real
  `_health_poller` cases per shim (startup death, post-`READY` death, death while `SLEEPING`).
  Engine control calls are now asserted over `httpx.MockTransport` instead of a substituted fake. A
  pre-existing seam leak that made the combined `pytest runners/...` invocation order-dependent is
  fixed. Tests, test-only adapters and docs only — no shim runtime or contract change. The
  conformance README documents the capability-gating mechanism and the `/wake` divergence.
- **#176** — dashboard unit tests can render PatternFly, router, i18next and react-query components.
  `dashboard/vitest.config.ts` resolves the graph ESM-first (`resolve.mainFields`), pins the remaining
  CJS entrypoints (`react-router-dom`, `react-router`, `react-router/dom`,
  `react-virtualized-auto-sizer`, `use-sync-external-store`) to their ESM builds, and inlines every
  React-consuming package family so its `react` imports resolve the dashboard's own React 18.3.1.
  A 10-case `src/__tests__/render-probes.test.tsx` (one per family, all failing before the change)
  guards the boundary; `ProtectedRoute` moved out of `App.tsx` so `NotificationProvider`'s tests
  render the real gate instead of a hand-mirrored one. No dependency, lockfile or production-build
  change.
- **#251** — the control-plane integration suite runs in CI: an `integration` job with `postgres:16`
  - `valkey:8` service containers, the same `triage` gate and pinned-action preamble as the other
    gates, and a final `if: always()` step running
    `control-plane/scripts/verify-integration-report.mjs`. That script reads vitest's JSON report and
    fails the job when zero tests were collected or any were skipped — without it the suite's
    `describe.skipIf` + `passWithNoTests: true` exits 0 silently. The job is **staged**:
    `continue-on-error: true` (red job visible, non-blocking) until it has a green run, then that one
    line is deleted. `docs/development/setup.md` documents the job and `make test-integration`.

The job's first CI run executed 32 tests against real services and was **31/32** — the single
failure is the pre-existing cutover-barrier bug **#322** (`routing-map.integration.test.ts`: an
expired proxy presence key is read as `0`, so the barrier never observes the lapse and waits its
full 30 s timeout). The staged flag therefore stays until #322 lands. Draft PR #321 is the CI proof
harness for #251, not the delivery PR.

Review/verification ran per issue (blueprint/implement → 2× review → fix → verify → accept);
cumulative reports in `.omp/reports/` (agent scratchpad, not committed). Cumulative gate: root
`npx vitest run` green (106 files / 1856 passed + 1 skipped), control-plane unit 807/807, Python
shims + conformance `138 passed, 1 skipped` in both file orders, `tsc --build` clean, eslint +
prettier clean on touched files, and the #251 CI run judged gate-by-gate.

## Next

- **M18** (CI & Test Infrastructure) — implemented on `milestone/m18-ci-test-infrastructure`,
  awaiting merge to `dev`: #314, #251, #252 and #176 all delivered and accepted on the branch (see
  the M18 section above). Merge order matters only for the CHANGELOG hunk, which is already
  resolved on the branch. The integration job stays advisory until **#322** (cutover barrier never
  observes an expired presence lease) is fixed and the job has a green run; flipping it to blocking
  is deleting the `continue-on-error` line.
- **M19** (Deployment, Release & Docs Hygiene) — the image/supply-chain half is closed (#266 via
  #316, #267 via #318), Phase 5 is merged and verified on-cluster, the platform-image rollout is
  documented (#247) and still needs one on-cluster rollout proof, and the docs/contracts items are
  closed (#249 via #319, #248 via #320, #268 via #273). Remaining in the milestone: #315 only
  (tighten `supplementalGroups`, cluster-only validation), plus #287's operational half (vLLM SIF
  `rc2` republish + re-import).
- **Gate 9b follow-ups** (#286–#289): the leaked-runner divergence, the duplicate
  `POST /runners`, the stale runner modules, and the worker-catalog deployment gap. All four are
  fixed and merged: #289 (worker catalog default), #286 (teardown boundary + `GET /runners`
  reverse sweep, PR #292), #288 (idempotent worker start + contract-visible retained launches,
  PR #294) and #287 (runner-shim provenance + staleness gate + republish runbook, PR #297).
  #287's operational half remains: republish the three vLLM SIFs (`rc2`), bump the digest-pinned
  `runners.yaml` entries on `main`, re-import, and verify `attribution: "device"` from two
  co-located runners.
- M16 (Orchestration Resilience) is complete: #242 (model wake returns before victim eviction),
  #245 (proxy piggybacked parkers fast-fail on wake-trigger failure), #240 (crashed-worker
  `info`/`memory` Redis keys never expired → join/leave flap), #254 (phantom device-memory gauge
  series for departed workers and stale reports), #246 (protocol-family admission) and #258
  (control-plane dead config + proxy hot-path allocations, two PRs) are all fixed and merged.
  #286 and #288 had already merged early as P1/P2 follow-ups.

Full plan: [`overall-plan.md`](overall-plan.md).

## Limitations and deploy-only verification

Several M17 and Phase 5 behaviors are structurally not provable in the dev container (no GPU, no
vLLM/MLServer runtimes, no Apptainer node, no cluster); they are recorded per issue or per phase
and must be exercised on first post-merge deployment. The M17 list is unchanged from the last
revision except where #278 changed the follow-through:

- **#239**: a live `curl <runner>:<engine-port>/metrics` capture on a GPU runner (the CHANGELOG's
  stated release gate) — confirming the parser's assumptions about real vLLM 0.26 metric text
  (names, label set, float-string values); and the drain-window behaviour on-cluster: 409 →
  instance ERROR with an in-flight generation, and 200-but-unparsed → 504 → instance ERROR.
- **#244**: a real two-runner co-location observation showing both shims reporting the same
  whole-device figure with `attribution: "device"` — with #278's consumer-side rule now shipped,
  the observation doubles as the check that the CP/dashboard render deduped figures (only the
  genuinely per-runner bars plus the residual in "Other"), not two whole-device bars.
- **#253**: `/health` staying responsive while a real `mem_get_info`/kvcached read stalls under
  GPU contention (locally proven only with a 150 ms fake).
- **#243**: a real wedged shim inside a real SIF on an Apptainer node (locally proven with a
  never-settling injected probe and a never-writing `node:http` server).
- ~~**Phase 5 — Gate 9b run (required, [#279](phase5.md) recipe)**~~ — **run 2026-11-17, PASS**:
  two `allowCoLocation: true` vLLM models on one L4 through the control plane, both ACTIVE on
  device 0, both `/memory-report` `kvCache` blocks satisfying the `KVCachePoolStats` partition
  invariant with the same pool, elastic admission of 20 GiB against 18.01 GiB available, the
  same requirement refused with the opt-in off, and NVML peaking at 5,934 of 23,034 MiB under
  concurrent inference. Record: [`phase5-gate9b-run.md`](phase5-gate9b-run.md). The run also
  showed `attribution` absent from the published modules (#287 — now detected as
  `updateReason: "unprovenanced"`; the republish is the remaining step) and could not stress the
  virtual headroom — see that note's "What this run does not prove".
- **#289**: a fresh `deployment/` apply on a GPU node must show
  `vllm: kvCacheElasticSharing: true` in `GET /api/v1/workers` with no manual patch, and the
  worker log must carry no `[dev-worker] … catalog …` warning.
- **#287**: the `rc2` librarian republish of vLLM 0.21/0.24/0.26, the digest-pinned `runners.yaml`
  bump on `main`, the cluster re-import, and the live check that two co-located runners report
  `attribution: "device"` with deduped per-runner bars in the dashboard (not two whole-device
  bars). Until then the imported modules report `updateAvailable: true`,
  `updateReason: "unprovenanced"` — the provenance gate's intended visibility. Runbook:
  [`../usage/runner-catalog.md`](../usage/runner-catalog.md).
- **Phase 5 — live pool-pressure behavior (#277)**: the evaluator ships off
  (`SARDEENZ_POOL_PRESSURE_ENABLED=false`); first on-cluster exercise needs a device whose
  kvcached pool is driven to the threshold (≥90% of `totalBytes`) for 3 consecutive ticks, then
  observes the stop-based relief wave: victims drawn only from that device's co-location group,
  the drain-free stop cutting in-flight requests, the `EVICTION_TRIGGERED` cluster event, and
  the release target measured against `SARDEENZ_POOL_PRESSURE_RELEASE_TARGET_PERCENT`.
- ~~**Phase 5 — migration `008-add-allow-co-location.sql` on a live database**~~ — **exercised
  2026-11-17**: pre-existing `models` rows survived the upgrade with `allow_co_location`
  defaulting to false, and the flag round-tripped through stop → config-edit → start cycles.

M18's own boundaries (implemented, not merged):

- **#251/#322** — the integration job cannot be flipped to blocking until the pre-existing
  cutover-barrier bug #322 is fixed; the one green run its staging rule waits for is therefore not
  obtainable from this milestone.
- **#323** — the conformance suite pins `/wake` from a non-sleeping runner at today's `200`, which
  the engine-runner spec describes as `409`. Aligning spec + both shims + the control plane's wake
  path is a follow-up issue, deliberately not done inside #252.
- **#176** — the React-18 pin is per package: a new React-consuming dependency omitted from
  `test.server.deps.inline` still binds the hoisted root React 19 and only fails at first render.
  The probe file is the guard; the config alone does not make React 19 unreachable.
- **#314** — the exact ~1454-error repro (mkdocs installed, repo-wide `eslint .`) was not runnable
  in this container; the evidence is the synthetic-`site/` lint with and without the ignore.

M15 items still pending first deployment exercise (merged to `dev` via #270/#271): Secret
resolution at pod creation and the Valkey AUTH handshake (#230), CNI admission and enforcement of
the default-deny + allow NetworkPolicies and the Prometheus scrape of proxy 9099 (#230), VAP
admission and enforcement (#232), SCC/`readOnlyRootFilesystem`/`runAsNonRoot` runtime behavior
(#235), and the empty-string-Secret crash-loop (#234). Full list in the M15 entries of the
previous revision of this file and in `.omp/plans/m15-notes.md` (agent scratchpad, not committed).

## Open follow-ups

From the Phase 5 Gate 9b run (2026-11-17, see [`phase5-gate9b-run.md`](phase5-gate9b-run.md)):

- **#286**: instance records can be dropped without stopping the runner — a failed start left a
  live `READY` runner holding 5.0 GB that the control plane no longer knew about.
- ~~**#287**: published vLLM runner modules predate #275 (no `attribution` in `/memory-report`).~~
  — fixed in code: the catalog may declare `shimSource` (the runner-shim commit an image was built
  from), the import sidecar records it (`schemaVersion: 2`, v1 still readable), and
  `GET /api/v1/catalog` flags a module as `unprovenanced`, `shim-source-advanced` or
  `digest-changed`, with a maintainer check script and the `rc2` republish runbook
  (`docs/usage/runner-catalog.md`). The republish + re-import remain the deploy-only step
  (PR #297).
- ~~**#288**: the deploy path issued `POST /runners` twice for one instanceId.~~ — fixed:
  `POST /runners` is idempotent per `instanceId` (identical repeat or in-flight join returns
  `200` + `reused: true`, `201` means this request spawned, a different spec or an undying prior
  launch is `409` naming the runner), retained failed launches are contract-visible as `FAILED`
  and stopped + reaped by the control plane, and `Started runner … pid=` distinguishes a
  duplicated log block from a real double spawn (PR #294).
- ~~**#289**: a stock `deployment/` cannot advertise `kvCacheElasticSharing` (worker catalog URL
  unset; loader accepts local paths only), which makes Phase 5 co-location unreachable.~~ —
  fixed: the worker shares the control plane's catalog default and fetches http(s) catalogs, with
  a startup warning naming any unresolved runner type.

From M15:

- ~~**#266** (M19): image/supply-chain hardening — non-root `USER` in worker images, base-image
  digest pins, cosign sign + scan for platform images (the #235 split).~~ — merged via #316.
- ~~**#267** (M19): reconcile ADR-016's "no `RunAsAny` / exactly one change" wording with the
  shipped SCC's second relaxation (`fsGroup: RunAsAny`).~~ — merged via #318.
- **#268**: fail-closed token gate accepts whitespace-only tokens — fix merged via #273; the issue
  is still open.
- ~~**#269**: BFF request logger writes `?token=` SSE URLs (including JWTs) into access logs.~~ —
  closed (fix merged via #274).

From M17 (reviewer-recorded, non-blocking):

- **#244 residual**: ~~the consumer-side rule for `attribution`~~ — closed by Phase 5 (#278,
  merged via #281): the shared `sumInstanceMeasurementsByInstance` helper and the
  dashboard's "Other" bucket now own the dedup; the `getKvCacheDeviceStats` first-wins precedent
  remains the pool-stats analogue. The on-cluster run showed the rule is only as good as the
  shim inside the published modules — see #287 (the provenance gate now flags it; the republish
  remains).
- **#253 carried low**: the `test_health_responds_while_memory_report_blocks` retry leaves the
  first attempt's `report_task` unawaited (harmless under `asyncio.run` teardown).
- **#243 pre-existing**: TDZ latent bug in `ApptainerLauncher.stopChild` — a child emitting
  `exit` synchronously inside `kill` throws before the timer declarations; invisible today
  (start swallows it, real children exit async). Worth an issue.

## Notable changes

M18 (branch `milestone/m18-ci-test-infrastructure`, pending merge):

- CI gains another gate job, `integration`, against real `postgres:16` + `valkey:8` service
  containers. It runs the existing control-plane integration vitest config with a JSON reporter and
  adds a fail-closed report check (`control-plane/scripts/verify-integration-report.mjs`: zero
  collected tests, any skipped test, a failed test or a missing/malformed report all red). Staged
  advisory via a single `continue-on-error: true` until #322 is fixed and the job is green. The
  `ci.yml` trailer no longer lists `make test-integration` as deliberately ungated.
- Dashboard unit tests get a working React-18 render tree: ESM-first `resolve.mainFields`,
  exact-file ESM aliases for the remaining CJS entrypoints (`react-router-dom`, `react-router`,
  `react-router/dom`, `react-virtualized-auto-sizer`, `use-sync-external-store`), and
  `test.server.deps.inline` per React-consuming package family. New
  `dashboard/src/__tests__/render-probes.test.tsx` (10 cases) guards each family; `ProtectedRoute`
  is now its own module (`dashboard/src/components/ProtectedRoute.tsx`) so its tests render the
  real gate. No dependency, lockfile or production-build change — the hoisted root React 19 stays.
- The conformance test-adapter contract gains `CONFORMANCE_FEATURES`, `APP_MODULE` and
  `PATCHED_SEAMS`, and `build_conformance_app()` gains keyword-only `ready`/`alive` (plus
  `active_requests` for adapters declaring the sleep guard); the zero-argument call is unchanged.
  Fixtures restore patched seams after the app lifespan, so the shared suite no longer leaks its
  doubles into the shims' own unit suites in a combined `pytest` invocation. The suite is 13 named
  cases / 25 tests and documents both the capability-gating rule and the `/wake` divergence (#323).
- The ESLint flat config's global ignores gain `site/`, so the gitignored mkdocs output cannot fail
  `make lint` after `make docs-build`.
- Docs: `docs/development/patternfly.md` gains a "Unit testing (Vitest)" section (the three levers,
  the per-package cover, the jsdom/nivo limits); `docs/development/setup.md` documents the CI
  integration job and adds `make test-integration` to the command table.

Phase 5 (merged via #281; decisions ratified as
[ADR-029](../architecture/adrs/adr-029-colocation-hold-and-pressure-stop.md) in #283):

- Two contract surfaces moved: `control-plane.yaml` gains `allowCoLocation` on the deploy/config
  request and response plumbing plus the elastic-branch `DeviceInfo.kvCache` description;
  `worker-agent.yaml` gains `attribution` on `InstanceMemoryMeasurement` — with the
  description-only reword naming both placement consumers of `kvCache` (elastic co-location
  headroom and the #277 pool-pressure evaluator; everything else stays telemetry). Generated
  types committed.
- Five operator-facing knobs land, all boot-validated: `SARDEENZ_COLOCATION_MAX_POOL_HEADROOM_PERCENT`
  (default 50, 0 disables), `SARDEENZ_POOL_PRESSURE_ENABLED` (`'false'`),
  `_THRESHOLD_PERCENT` (90), `_RELEASE_TARGET_PERCENT` (75, must stay below the threshold),
  `_DEBOUNCE_TICKS` (3) — all wired through `deployment/`.
- New migration `control-plane/migrations/008-add-allow-co-location.sql` — exercised against the
  live database on 2026-11-17 (existing rows default to false; the flag round-trips through
  stop → edit → start).
- Worker catalog behaviour for operators (#289): the co-location capability is worker-declared
  and read from the runner catalog, which the worker now loads from `SARDEENZ_RUNNER_CATALOG_URL`
  — defaulting to the same official `runners.yaml` as the control plane, with the same
  `https`-only gate and a 10 s fetch timeout. A local path or `file://` catalog still works for
  air-gapped clusters; load failures are non-fatal and each unresolved runner type gets a
  `[dev-worker] … catalog …` warning instead of a silent `kvCacheElasticSharing: false`.

M17:

- Engine-runner contract gains the optional `attribution: "runner" | "device"` field on
  `DeviceMemoryUsage` (#244); generated TypeScript types committed (spec stays 0.1.1 — an
  additive optional field). Phase 5 (#278) supplies its first worker-agent-side consumer rule.
- New user-visible behaviour in the vLLM shim (#239): a sleep attempted while generations are
  in flight answers 409 and lands the instance in ERROR (previously it silently offloaded
  weights out from under them); a 200-but-unrecognized `/metrics` body stalls the drain to its
  504 deadline instead of reporting a fake `0`.
- The launcher's health probe is budgeted per attempt (#243) and the worker's memory-report
  publish is coalesced to one push per tick with a logged failure handler (#257) — neither adds
  an operator-facing knob.
- Python shims gained app-level test harnesses (`tests/test_app.py`) built on
  `httpx.ASGITransport` — no new test dependency (`pytest-asyncio` remains absent by design).

M15 (merged to `dev` via #270/#271):

- Five ADRs record M15's decisions: [ADR-022](../architecture/adrs/adr-022-fail-closed-service-tokens.md)
  (tokens fail closed; dev-only opt-out — resolves ADR-013's inter-component-auth deferral),
  [ADR-023](../architecture/adrs/adr-023-sse-only-query-token-fallback.md) (SSE-only query-token
  fallback), [ADR-024](../architecture/adrs/adr-024-worker-entrypoint-allowlist.md) (entrypoint
  allowlist seeding), [ADR-025](../architecture/adrs/adr-025-namespace-default-deny-ingress.md)
  (namespace default-deny posture), [ADR-026](../architecture/adrs/adr-026-vap-activation-labeled-namespace.md)
  (VAP activation by the shipped labeled Namespace — completes ADR-017's deferred mechanism
  choice).
- Worker-agent contract bumped 0.1.2 → 0.1.3 (`entrypoint` description constraint); generated types
  committed.
- Dependency-update pressure now automated (#233) — the M14-style manual alert chasing has a
  weekly bottom-up complement.
- New secret-scaffolding pattern: `sardeenz-redis-credentials` mirrors the
  `sardeenz-postgres-credentials` operator pattern (runbook in `deployment/prereq/README.md`);
  local dev stays passwordless.
- Docs synchronized with the code in the M15 docs commit: deployment-security.md flow
  table, deployment/prereq runbooks, setup.md fail-closed notes, runner-catalog allowlist
  semantics, dashboard.md JWT-flow/SSE claims.

## Environment note (dev container)

The Python-side venv is bespoke — if `make test-python` hits import errors, recreate with
`rm -rf .venv && python3 -m venv .venv && make test-python-deps` (or run the suite as
`.venv/bin/python -m pytest`; system python3 lacks fastapi). The earlier `node_modules` staleness
warning is resolved: a root `npm install --no-audit --no-fund` reconciles `node_modules` to the
lockfiles, after which `tsc --build` for dev-worker/control-plane and the full `npx vitest run`
work locally.
