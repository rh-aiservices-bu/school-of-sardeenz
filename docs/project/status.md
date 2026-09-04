# Project Status

Living record of what is delivered and what comes next. Update when a phase or milestone closes.
Last update: 2026-09-04.

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

| Milestone | Theme                                                                                                                                    |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| M2        | Reliable Wake-on-Request                                                                                                                 |
| M3        | Orchestration Correctness                                                                                                                |
| M4        | Worker & Runner Lifecycle                                                                                                                |
| M5        | Security & Trust Boundaries                                                                                                              |
| M6        | Contracts & Docs Accuracy                                                                                                                |
| M7        | Multi-Instance & Move Foundations ([ADR-019](../architecture/adrs/adr-019-logical-model-vs-instance-split.md))                           |
| M8        | Dashboard v1 Parity                                                                                                                      |
| M9        | Engine Expansion — MLServer, `/openai` and `/oip` proxy split ([ADR-021](../architecture/adrs/adr-021-protocol-family-path-prefixes.md)) |
| M10       | Control-Plane Orchestration Correctness — delete/stop/instance-op claims, 409 `details.reason`                                           |
| M11       | Dashboard Stability & Test Infrastructure — Playwright e2e green and enforced in CI                                                      |
| M12       | Runner & Engine Hardening — configurable vLLM bind host, per-runner 4-port blocks, Python suites gated in CI                             |

Also merged outside a milestone: the configuration-name vs. served-model-name split
([ADR-020](../architecture/adrs/adr-020-config-name-vs-served-model-name.md), #154) and the
measured-only VRAM telemetry doctrine (#163/#164, ts-nvml).

Milestone PR drafts: [`milestone-M3-pr-draft.md`](milestone-M3-pr-draft.md) through
[`milestone-M9-pr-draft.md`](milestone-M9-pr-draft.md).

## Next

- **M13 — Feature & Resilience Backlog:** #146 move-model action, #149 playground stream cap,
  #178/#179 dashboard follow-ups, #181 proxy→engine NetworkPolicy ingress rule.
- **Phase 5:** control-plane kvcached oversubscription / co-location policy, keyed on
  `kvCacheElasticSharing`.

Full plan: [`overall-plan.md`](overall-plan.md).
