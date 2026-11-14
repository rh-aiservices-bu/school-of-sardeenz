# Project Status

Living record of what is delivered and what comes next. Update when a phase or milestone closes.
Last update: 2026-11-13 (Phase 5 implemented on the phase branch; M19 Phase-5 line).

## Phases (complete)

| Phase | Scope                                                     | Plan                                                                                                                   |
| ----- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 0     | Engine runner contract (spec only)                        | [`phase0.md`](phase0.md)                                                                                               |
| 1     | Rust proxy with connection parking                        | [`phase1.md`](phase1.md)                                                                                               |
| 2     | Control plane sleep/wake orchestration                    | [`phase2.md`](phase2.md)                                                                                               |
| 3     | Admin dashboard (fresh build)                             | [`phase3.md`](phase3.md)                                                                                               |
| 3.6   | Dev worker agent — local-process worker with runner stubs | [`phase3.6.md`](phase3.6.md)                                                                                           |
| 4     | SIF runner runtime (Apptainer) — spike verdict GO         | [`phase4.md`](phase4.md), [`phase4-apptainer-spike.md`](phase4-apptainer-spike.md), [`phase4-perf.md`](phase4-perf.md) |

Phase 4 delivered the `containers/` runner images, the `RunnerLauncher`/`ApptainerLauncher`
worker-agent abstraction, the vLLM runner shim (`runners/vllm/`), the
`runtimeModule`/`kvCacheElasticSharing` contract additions, the SIF librarian pipeline
(`deployment/librarian/`, `scripts/build-sif.sh`), the worker security + Deployment manifests
(`deployment/sif-runner/`), and the spike-gate integration suite (`tests/gates/`).
Cluster/GPU-gated acceptance (live image builds, SIF conversion, SCC admission, kvcached Gate 9,
CephFS perf) is tracked in [`phase4.md`](phase4.md) and [`phase4-perf.md`](phase4-perf.md).

## Phases (implemented on a branch)

| Phase | Scope                                                                                                          | Plan                     |
| ----- | -------------------------------------------------------------------------------------------------------------- | ------------------------ |
| 5     | kvcached oversubscription & co-location policy — implemented on `milestone/m19-phase5-colocation`, awaiting PR | [`phase5.md`](phase5.md) |

Phase 5 delivered the co-location placement policy (#276: `allowCoLocation` opt-in, fail-closed
capability guard, capped KV-pool headroom, per-device wake pre-check with group-scoped wake
eviction), the consumer-side attribution rule (#278: `attribution` on
`InstanceMemoryMeasurement` with the shared control-plane summation helper — closing the #244
per-model double-count residual), the shared-pool pressure response (#277: reconciliation
pressure step, stop-based relief from the device's co-location group, off by default), and
[`phase5.md`](phase5.md) with the Gate 9b recipe (#279). All four issues are merged onto the
phase branch; the tracker steps (PR to `dev`, then per-issue closes) ride the merge.

## Milestones merged to `dev`

| Milestone | Theme                                                                                                                                                                                                                                                                                                                          |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| M2        | Reliable Wake-on-Request                                                                                                                                                                                                                                                                                                       |
| M3        | Orchestration Correctness                                                                                                                                                                                                                                                                                                      |
| M4        | Worker & Runner Lifecycle                                                                                                                                                                                                                                                                                                      |
| M5        | Security & Trust Boundaries                                                                                                                                                                                                                                                                                                    |
| M6        | Contracts & Docs Accuracy                                                                                                                                                                                                                                                                                                      |
| M7        | Multi-Instance & Move Foundations ([ADR-019](../architecture/adrs/adr-019-logical-model-vs-instance-split.md))                                                                                                                                                                                                                 |
| M8        | Dashboard v1 Parity                                                                                                                                                                                                                                                                                                            |
| M9        | Engine Expansion — MLServer, `/openai` and `/oip` proxy split ([ADR-021](../architecture/adrs/adr-021-protocol-family-path-prefixes.md))                                                                                                                                                                                       |
| M10       | Control-Plane Orchestration Correctness — delete/stop/instance-op claims, 409 `details.reason`                                                                                                                                                                                                                                 |
| M11       | Dashboard Stability & Test Infrastructure — Playwright e2e green and enforced in CI                                                                                                                                                                                                                                            |
| M12       | Runner & Engine Hardening — configurable vLLM bind host, per-runner 4-port blocks, Python suites gated in CI                                                                                                                                                                                                                   |
| M13       | Feature & Resilience Backlog — move-model action (#146), playground stream cap (#149), dashboard notification/e2e follow-ups (#178/#179), proxy→engine NetworkPolicy rule (#181), CI container-image builds (#187)                                                                                                             |
| M14       | Dependency Security Remediation — Dependabot alert sweep across npm/cargo: fast-jwt (#224), undici (#225), react-router-dom (#226, → v7 in #229), @fastify/static → v10 (#231), rustls/quinn-proto (#259), vitest → 4 (#228/#262), transitive sweep (#261)                                                                     |
| M15       | Security Hardening — Cluster & Auth — Dependabot automation (#233), labeled Namespace prereq (#232), Valkey AUTH + default-deny NetworkPolicies (#230), manifest hardening manifest-half (#235), instanceId validation (#236), fail-closed tokens (#234), SSE-only query-token gate (#237), worker entrypoint allowlist (#238) |
| M17       | Runner & Shim Correctness — vLLM labeled-metric scrape (#239), launcher health-probe timeout (#243), device-scope memory attribution (#244), executor offload of blocking reads (#253), worker start fixes (#257); per-issue detail in that milestone's CHANGELOG entry and Notable changes below                              |
| M19       | Runner & Image backlog — Phase 5 kvcached co-location policy (#276 placement, #278 attribution rule, #277 pressure response, #279 phase doc + Gate 9b recipe) implemented on the milestone branch awaiting PR; image/supply-chain half (#266/#267) still open.                                                                 |

Also merged outside a milestone: the configuration-name vs. served-model-name split
([ADR-020](../architecture/adrs/adr-020-config-name-vs-served-model-name.md), #154) and the
measured-only VRAM telemetry doctrine (#163/#164, ts-nvml).

Milestone PR drafts: [`milestone-M3-pr-draft.md`](milestone-M3-pr-draft.md) through
[`milestone-M9-pr-draft.md`](milestone-M9-pr-draft.md).

## Current milestone — Phase 5 on M19 (implemented, awaiting PR)

Phase 5 (kvcached oversubscription & co-location policy) is fully implemented on
`milestone/m19-phase5-colocation` (7 commits over `dev@876ead7`); opening the PR to `dev` is the
remaining tracker step, with the four phase issues (#276/#277/#278/#279) closed on merge.
In progress: nothing else.

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

## Next

- **M19** (Runner & Image backlog) — Phase 5 (#276/#277/#278/#279) is implemented on
  `milestone/m19-phase5-colocation` (see the current-milestone section); the remainder of the
  M19 theme owns the image/supply-chain half split out of M15's #235 (#266: non-root `USER`,
  digest pins, cosign sign + scan) and the ADR-016 wording reconciliation (#267); a per-PID
  NVML follow-up to #244 (option A from its decision) would also belong there.
- M16 (Orchestration Resilience) stays parked.

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
- **Phase 5 — Gate 9b run (required, [#279](phase5.md) recipe)**: on a GPU worker, deploy two
  `allowCoLocation: true` vLLM models through the control plane onto one device, assert both
  instances ACTIVE, both runners' `/memory-report` carrying `kvCache` blocks satisfying the
  `KVCachePoolStats` partition invariant, the optional concurrent-inference smoke, and the
  required NVML reality check (actual device usage under concurrent inference stays within
  physical capacity — `freeBytes` is unbacked virtual capacity, so the headroom formula can
  count it twice; placement success alone is not acceptance evidence). Paste the run into a
  linked note and extend this list with the outcome.
- **Phase 5 — live pool-pressure behavior (#277)**: the evaluator ships off
  (`SARDEENZ_POOL_PRESSURE_ENABLED=false`); first on-cluster exercise needs a device whose
  kvcached pool is driven to the threshold (≥90% of `totalBytes`) for 3 consecutive ticks, then
  observes the stop-based relief wave: victims drawn only from that device's co-location group,
  the drain-free stop cutting in-flight requests, the `EVICTION_TRIGGERED` cluster event, and
  the release target measured against `SARDEENZ_POOL_PRESSURE_RELEASE_TARGET_PERCENT`.
- **Phase 5 — migration `008-add-allow-co-location.sql` on a live database**: the dev suites
  cover the store mapping; a real Postgres upgrade path (existing `models` rows surviving with
  `allow_co_location` defaulting false) must be exercised once against a populated database.

M15 items still pending first deployment exercise (merged to `dev` via #270/#271): Secret
resolution at pod creation and the Valkey AUTH handshake (#230), CNI admission and enforcement of
the default-deny + allow NetworkPolicies and the Prometheus scrape of proxy 9099 (#230), VAP
admission and enforcement (#232), SCC/`readOnlyRootFilesystem`/`runAsNonRoot` runtime behavior
(#235), and the empty-string-Secret crash-loop (#234). Full list in the M15 entries of the
previous revision of this file and in `.omp/plans/m15-notes.md` (agent scratchpad, not committed).

## Open follow-ups

From M15 (first two are M19-owned):

- **#266** (M19): image/supply-chain hardening — non-root `USER` in worker images, base-image
  digest pins, cosign sign + scan for platform images (the #235 split).
- **#267** (M19): reconcile ADR-016's "no `RunAsAny` / exactly one change" wording with the shipped
  SCC's second relaxation (`fsGroup: RunAsAny`).
- **#268**: fail-closed token gate accepts whitespace-only tokens.
- **#269**: BFF request logger writes `?token=` SSE URLs (including JWTs) into access logs.

From M17 (reviewer-recorded, non-blocking):

- **#244 residual**: ~~the consumer-side rule for `attribution`~~ — closed by Phase 5 (#278,
  shipped on the phase branch): the shared `sumInstanceMeasurementsByInstance` helper and the
  dashboard's "Other" bucket now own the dedup; the `getKvCacheDeviceStats` first-wins precedent
  remains the pool-stats analogue.
- **#253 carried low**: the `test_health_responds_while_memory_report_blocks` retry leaves the
  first attempt's `report_task` unawaited (harmless under `asyncio.run` teardown).
- **#243 pre-existing**: TDZ latent bug in `ApptainerLauncher.stopChild` — a child emitting
  `exit` synchronously inside `kill` throws before the timer declarations; invisible today
  (start swallows it, real children exit async). Worth an issue.

## Notable changes

Phase 5 (on `milestone/m19-phase5-colocation`, awaiting PR):

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
- New migration `control-plane/migrations/008-add-allow-co-location.sql` (see the deploy-only
  list: needs one live-DB exercise).

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
