# Project Status

Living record of what is delivered and what comes next. Update when a phase or milestone closes.
Last update: 2026-11-12 (M17 wrap-up).

## Phases (complete)

| Phase | Scope                                                         | Plan                                                                                                                   |
| ----- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 0     | Engine runner contract (spec only)                            | [`phase0.md`](phase0.md)                                                                                               |
| 1     | Rust proxy with connection parking                            | [`phase1.md`](phase1.md)                                                                                               |
| 2     | Control plane sleep/wake orchestration                        | [`phase2.md`](phase2.md)                                                                                               |
| 3     | Admin dashboard (fresh build)                                 | [`phase3.md`](phase3.md)                                                                                               |
| 3.5   | Admin UI finalization — notifications, theme toggle, masthead | [`phase3.5.md`](phase3.5.md)                                                                                           |
| 3.6   | Dev worker agent — local-process worker with runner stubs     | [`phase3.6.md`](phase3.6.md)                                                                                           |
| 4     | SIF runner runtime (Apptainer) — spike verdict GO             | [`phase4.md`](phase4.md), [`phase4-apptainer-spike.md`](phase4-apptainer-spike.md), [`phase4-perf.md`](phase4-perf.md) |

Phase 4 delivered the `containers/` runner images, the `RunnerLauncher`/`ApptainerLauncher`
worker-agent abstraction, the vLLM runner shim (`runners/vllm/`), the
`runtimeModule`/`kvCacheElasticSharing` contract additions, the SIF librarian pipeline
(`deployment/librarian/`, `scripts/build-sif.sh`), the worker security + Deployment manifests
(`deployment/sif-runner/`), and the spike-gate integration suite (`tests/gates/`).
Cluster/GPU-gated acceptance (live image builds, SIF conversion, SCC admission, kvcached Gate 9,
CephFS perf) is tracked in [`phase4.md`](phase4.md) and [`phase4-perf.md`](phase4-perf.md).

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
| M17       | Runner & Shim Correctness — vLLM labeled-metric scrape (#239), launcher health-probe timeout (#243), device-scope memory attribution (#244), executor offload of blocking reads (#253), worker start fixes (#257) — see below                                                                                                  |

Also merged outside a milestone: the configuration-name vs. served-model-name split
([ADR-020](../architecture/adrs/adr-020-config-name-vs-served-model-name.md), #154) and the
measured-only VRAM telemetry doctrine (#163/#164, ts-nvml).

Milestone PR drafts: [`milestone-M3-pr-draft.md`](milestone-M3-pr-draft.md) through
[`milestone-M9-pr-draft.md`](milestone-M9-pr-draft.md).

## Current milestone — M17 Runner & Shim Correctness (implemented, awaiting PR)

All 5 milestone issues are implemented on `milestone/m17-runner-shim-correctness` (squash commits
per issue over `dev@c0150d4`, plus three docs/changelog follow-ups); opening the PR to `dev` is
the remaining tracker step.
In progress: nothing else.

| Issue | Delivered                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #239  | The vLLM shim's `activeRequests` is real: a pure labeled-metrics parser (`metrics.py`) reads `vllm:num_requests_running` + `vllm:num_requests_waiting` (name followed by `{` or whitespace, never a `_`-suffixed sibling; every label series summed for TP/DP), requires **both** series (a half-parsed scrape is not a drain signal), maps non-finite samples to `None` before the `int()`. The `/sleep` guard now trips mid-generation: a request that starts in the control plane's drain→sleep window gets a 409 → instance ERROR (loud failure instead of destroyed generations; no CP-side drain retry in scope). A 200-but-unrecognized `/metrics` body now behaves like a failed scrape: the drain waits out `sleepTimeoutMs` → 504 → instance ERROR. Fail-open rule untouched: an unreadable scrape is still `None`, which skips the guard. **Release gate:** capture a live vLLM 0.26 `/metrics` body before relying on the drain behaviour in production. |
| #243  | A runner that accepts the `/health` connection but never answers can no longer hang the serialized cold-start chain: `HealthCheckFn` takes an `AbortSignal` (`defaultHealthCheck` forwards it into `fetch`), and `waitUntilHealthy` races every probe against an abortable per-probe timer (`healthProbeTimeoutMs`, default 5 s, optional launcher-config field — no new `SARDEENZ_*` env var), with a `hasExited()` re-check after each null probe. The 15-minute health deadline keeps being re-evaluated (granularity degrades to ≤ probe budget + interval, ~6 s — immaterial at 15 minutes).                                                                                                                                                                                                                                                                                                                                                                    |
| #244  | The shims' `/memory-report` `torch.cuda.memory_reserved()` branch was dead by construction (the shim owns no CUDA pool — the engine is a child), so the figure silently degraded to the whole-device read and double-counted co-located runners. The dead branch is deleted; both shims emit `max(0, total − free)` with the new optional `attribution: "runner" \| "device"` field on `DeviceMemoryUsage` (engine-runner contract 0.1.1, generated types regenerated; consumers deliberately untouched), reporting `attribution: "device"`; the runner-stub emits `"runner"`. The conformance suite asserts every current emitter declares a scope. The consumer-side display rule (not summing device-scope rows) is Phase 5's, named-not-fixed.                                                                                                                                                                                                                   |
| #253  | Blocking torch/kvcached memory reads (`mem_get_info` under device contention, contended kvcached shm `flock`) no longer run on the shim event loop: all four `/memory-report` and `/sleep` call sites hand `memory_report` to the default executor (`run_in_executor`, the ONNX `session.run` pattern). Same 409 paths, shapes, and `deviceMemoryFreedBytes`; no background refresh loop. New app-level harnesses (`tests/test_app.py` in both shims: `httpx.ASGITransport` over the conformance doubles, thread-observable; no new test dependency) pin the off-loop execution, the single `/sleep` read, and `/health` staying responsive behind a 150 ms report read.                                                                                                                                                                                                                                                                                             |
| #257  | `startRunner` reserves the instance slot (and registers the model set) synchronously before its first `await` (`allocatePorts`), inside a `try` extended to cover the allocation phase — a port-allocation failure rolls the slot back instead of stranding the `instanceId` behind a permanent `ConflictError`; the catch's `usedPorts` delete is guarded on nullable pre-declared port bindings. `allocateMemory`/`freeMemory` are ledger-only; the publish moved to `pushMemoryReportOnce()` — a microtask-coalesced (never a timer, preserving the staleness-check freshness) single push per tick with a logged `.catch` instead of a possible unhandled rejection. Ledger arithmetic (`floor(requiredMemory / devices.length)`) unchanged.                                                                                                                                                                                                                     |

Review/verification ran per issue (blueprint → implement → 2× review → fix → verify → accept);
cumulative reports in `.omp/reports/` (agent scratchpad, not committed). Cumulative gate:
tsc (dev-worker + control-plane) clean, full vitest 1569 passed + 1 skipped, dev-worker 310 + 1,
Python shims + conformance 117 passed + 1 skipped, contracts validate + codegen reproducibility.

## Next

- **Phase 5** (kvcached oversubscription / co-location policy) — unblocked: #244 + #253, its
  declared gate, both shipped in M17. Its placement policy consumes #244's `attribution`
  semantics (the rule for not summing device-scope rows, and the dashboard's per-model bars
  under co-location, are still open consumer work).
- **M19** (Runner & Image backlog) — owns the image/supply-chain half split out of M15's #235
  (#266: non-root `USER`, digest pins, cosign sign + scan) and the ADR-016 wording reconciliation
  (#267); a per-PID NVML follow-up to #244 (option A from its decision) would also belong there.
- M16 (Orchestration Resilience) stays parked.

Full plan: [`overall-plan.md`](overall-plan.md).

## Limitations and deploy-only verification

Several M17 behaviors are structurally not provable in the dev container (no GPU, no vLLM/MLServer
runtimes, no Apptainer node, no cluster); they are recorded per issue and must be exercised on
first post-merge deployment:

- **#239**: a live `curl <runner>:<engine-port>/metrics` capture on a GPU runner (the CHANGELOG's
  stated release gate) — confirming the parser's assumptions about real vLLM 0.26 metric text
  (names, label set, float-string values); and the drain-window behaviour on-cluster: 409 →
  instance ERROR with an in-flight generation, and 200-but-unparsed → 504 → instance ERROR.
- **#244**: a real two-runner co-location observation showing both shims reporting the same
  whole-device figure with `attribution: "device"`; the consumer-side double-count it makes
  visible (CP per-instance aggregation, dashboard placement bars) is Phase 5 work.
- **#253**: `/health` staying responsive while a real `mem_get_info`/kvcached read stalls under
  GPU contention (locally proven only with a 150 ms fake).
- **#243**: a real wedged shim inside a real SIF on an Apptainer node (locally proven with a
  never-settling injected probe and a never-writing `node:http` server).

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

- **#244 residual**: the consumer-side rule for `attribution` (per-runner display/dedup, the
  `getKvCacheDeviceStats` first-wins precedent) — deliberately Phase 5's, not an issue yet.
- **#253 carried low**: the `test_health_responds_while_memory_report_blocks` retry leaves the
  first attempt's `report_task` unawaited (harmless under `asyncio.run` teardown).
- **#243 pre-existing**: TDZ latent bug in `ApptainerLauncher.stopChild` — a child emitting
  `exit` synchronously inside `kill` throws before the timer declarations; invisible today
  (start swallows it, real children exit async). Worth an issue.

## Notable changes

M17:

- Engine-runner contract gains the optional `attribution: "runner" | "device"` field on
  `DeviceMemoryUsage` (#244); generated TypeScript types committed (spec stays 0.1.1 — an
  additive optional field). No in-repo consumer reads it yet by design.
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
