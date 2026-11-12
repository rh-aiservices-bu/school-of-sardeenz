# Project Status

Living record of what is delivered and what comes next. Update when a phase or milestone closes.
Last update: 2026-11-12.

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
| M13       | Feature & Resilience Backlog — move-model action (#146), playground stream cap (#149), dashboard notification/e2e follow-ups (#178/#179), proxy→engine NetworkPolicy rule (#181), CI container-image builds (#187) |
| M14       | Dependency Security Remediation — Dependabot alert sweep across npm/cargo: fast-jwt (#224), undici (#225), react-router-dom (#226, → v7 in #229), @fastify/static → v10 (#231), rustls/quinn-proto (#259), vitest → 4 (#228/#262), transitive sweep (#261) |

Also merged outside a milestone: the configuration-name vs. served-model-name split
([ADR-020](../architecture/adrs/adr-020-config-name-vs-served-model-name.md), #154) and the
measured-only VRAM telemetry doctrine (#163/#164, ts-nvml).

Milestone PR drafts: [`milestone-M3-pr-draft.md`](milestone-M3-pr-draft.md) through
[`milestone-M9-pr-draft.md`](milestone-M9-pr-draft.md).

## Current milestone — M15 Security Hardening (implemented, awaiting PR)

All 8 milestone issues are implemented on `milestone/m15-security-hardening` (squash commits per
issue over `dev@9a277ea`, plus type-fix and doc-sync follow-ups); opening the PR to `dev` is the
remaining tracker step.
In progress: nothing else.

| Issue  | Delivered                                                                                                                                                                                                                              |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #233   | `.github/dependabot.yml`: 14 weekly update entries (npm root, cargo `/proxy`, pip ×4, GitHub Actions, docker ×7 — current runner versions only), minor+patch grouped per entry, `open-pull-requests-limit: 10`.                         |
| #232   | `deployment/prereq/` renders `Namespace/sardeenz` labelled `sardeenz.io/module-guard: enforce`, so the module-PVC write-protection ValidatingAdmissionPolicyBinding self-activates on a stock apply; the manual `oc label` runbook step is retired (verify-the-label + `--overwrite` conflict remedy documented). |
| #230   | Valkey requires AUTH: `sardeenz-redis-credentials` Secret (`REDIS_PASSWORD` → image `VALKEY_PASSWORD`; `REDISCLI_AUTH` exec probes, `tcpSocket` liveness unchanged), all four `SARDEENZ_REDIS_URL` consumers moved to `secretKeyRef`; namespace ships default-deny ingress plus allow NPs for redis 6379, postgres 5432, proxy 8080 (router + dashboard-BFF chat forwarding) and 9099 (monitoring), dashboard 4000 (router). |
| #235   | Manifest half only: `readOnlyRootFilesystem: true` + `/tmp` emptyDir on control plane and proxy, `automountServiceAccountToken: false` on the proxy, `runAsNonRoot: true` on the worker, librarian `build-oci` init container hardened, SCC `NET_BIND_SERVICE` dropped. Image/supply-chain half split out to #266 (M19). |
| #236   | `assertValidInstanceId` (`^[A-Za-z0-9._-]{1,64}$`, deliberately looser than the `inst-<12hex>` mint format) guards all five `:instanceId` routes (delete, sleep, wake, move, startup-logs) before any Redis key composition.           |
| #234   | Control plane and dev worker fail closed at startup when `SARDEENZ_API_TOKEN`/`SARDEENZ_WORKER_TOKEN` are unset or empty; dev opt-out `SARDEENZ_ALLOW_UNAUTHENTICATED_API=true` (truthy `1/true/yes/on`), documented in `.env.example` and the setup guide, never set in `deployment/**`. |
| #237   | Dashboard BFF `?token=` query auth restricted to the three SSE routes (`/api/events`, `/api/models/:name/logs`, `/api/models/:name/instances/:id/startup-logs`); everywhere else a query token is ignored → 401. The `sardeenz_sse` HttpOnly cookie remains the SSE mechanism. |
| #238   | Worker `POST /runners` validates `entrypoint` against an allowlist seeded from the configured `SARDEENZ_RUNNER_ENTRYPOINT` (verbatim match; `-m` module family only when that vector has the 3-token `<exec> -m <module>` shape); empty configured vector fails worker startup loudly. Worker-agent contract 0.1.2 → 0.1.3, generated types regenerated. |

Review/verification ran per issue (blueprint → implement → 2× review → fix → verify → accept);
cumulative reports in `.omp/reports/` (agent scratchpad, not committed).

## Next

- **M17 — Runner & Shim Correctness** (GitHub milestone #23): P1 anchor #239 (vLLM shim
  active-request scrape never matches — `/sleep` guard never trips mid-generation), plus #243
  (launcher health-probe timeout), #244 (shim `/memory-report` reserved branch dead in the
  two-process topology), #253 (blocking torch/kvcached calls on the event loop), #257 (startRunner
  slot reservation after await / unhandled rejection).
- **Phase 5** (kvcached oversubscription / co-location policy): #244 + #253 are its gate and are
  sequenced inside M17, so Phase 5 is unblocked at M17 close.
- M16 (Orchestration Resilience) stays parked; revisit after M17.

Full plan: [`overall-plan.md`](overall-plan.md).

## Limitations and deploy-only verification

Several M15 behaviors are structurally not provable in the dev container (no cluster); they are
recorded per issue and must be exercised on first post-merge deployment:

- **#230**: Secret resolution at pod creation (absent `sardeenz-redis-credentials` →
  `CreateContainerConfigError` on all five workloads), the AUTH handshake itself, CNI admission and
  enforcement of the default-deny + allows, the router-namespace label form
  (`policy-group.network.openshift.io/ingress: ""` vs the SDN-era `network.openshift.io/policy-group: ingress`
  overlay patch), Route → dashboard/proxy traffic, dashboard-BFF → proxy chat forwarding, and the
  Prometheus scrape of proxy 9099. Operator sequencing: apply component bases together with the
  prereq base so no flow is dropped in the default-deny window; password rotation requires
  restarting all five deployments.
- **#232**: cluster admission of the two VAP documents (OpenShift 4.17+ / k8s 1.30+; older clusters
  reject the binding at apply), actual enforcement semantics, binding-on-stock-apply with
  pre-existing namespaces (`oc label … --overwrite` remedy), and the `oc delete -k deployment/prereq/`
  cascade to the PostgreSQL/Valkey PVC data.
- **#235**: SCC admission/rebinding on rollout, `readOnlyRootFilesystem` runtime behavior (any
  unmapped write path surfaces as a crash-loop), `runAsNonRoot` fail-fast bite (no-op admission check
  on OpenShift UID ranges; observable on vanilla overlays), leader election unaffected.
- **#234**: in-cluster empty-string Secret key now crash-loops the control plane/worker at startup
  instead of serving unauthenticated.
- **#237**: the Playwright e2e suite runs `AUTH_MODE=none` and never installs the extractor, so the
  plugin unit tests are the meaningful gate; live SSE streaming through a real browser against an
  authed BFF was not exercised.
- **#238**: whole-worker-process run was blocked by the declared `node_modules` drift below; the
  production wiring was exercised via a real-HTTP probe (11/11 checks) instead.

## Follow-ups filed during M15

- **#266** (M19): image/supply-chain hardening — non-root `USER` in worker images, base-image
  digest pins, cosign sign + scan for platform images (the #235 split).
- **#267** (M19): reconcile ADR-016's "no `RunAsAny` / exactly one change" wording with the shipped
  SCC's second relaxation (`fsGroup: RunAsAny`).
- **#268**: fail-closed token gate accepts whitespace-only tokens.
- **#269**: BFF request logger writes `?token=` SSE URLs (including JWTs) into access logs.

## Notable changes

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
- Docs synchronized with the code in this milestone's docs commit: deployment-security.md flow
  table, deployment/prereq runbooks, setup.md fail-closed notes, runner-catalog allowlist
  semantics, dashboard.md JWT-flow/SSE claims.

## Environment note (dev container)

This checkout's `node_modules` is stale relative to the lockfiles (`dotenv` 16 vs `^17`,
`@rh-ai-bu/ts-nvml` absent, `yaml` 1.x vs `^2.9`): dev-worker/control-plane typecheck and a
whole-process worker start fail on exactly those imports, in files no M15 commit touched
(0 files changed under `runners/` by #230/#235). Scoped suites are the reliable local gate
(`npm test -w @sardeenz/dev-worker`, `npm test -w @sardeenz/control-plane`); recreate with
`rm -rf node_modules && npm ci` if full-workspace gates are needed. The Python-side venv has a
bespoke pinned set — if `make test-python` hits import errors, recreate with
`rm -rf .venv && python3 -m venv .venv && make test-python-deps`.
