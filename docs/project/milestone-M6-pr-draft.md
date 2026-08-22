# PR: Milestone M6 — Contracts & Docs Accuracy

## Summary

Contracts and docs tell the truth: the docs accuracy sweep, the BUSY/weight-0 decision, proxy contract drift, Redis-transported schema enforcement, and the older contract-polish items.

- **#15 — Capability contract hardening.** `kvCacheElasticSharing` promoted to first-class boolean on `RunnerCapabilities` and `WorkerCapability`. `WorkerCapability` gained `engineVersion`, `maxTensorParallelism`, and `features` passthrough; its enum arrays now `$ref` the shared engine-runner.yaml enums. `CatalogEntry` gained optional capability fields; the dev-worker reads them from `SARDEENZ_RUNNER_CATALOG_URL` at startup.
- **#80 — runner-contract.md accuracy.** BUSY→weight-0 routing, weight restoration, and all-replicas-BUSY 503 are now clearly labelled as target design (not implemented). Health polling interval corrected to 10s deploy/wake-scoped. All changes reference ADR-014.
- **#100 — Proxy contract drift and forwarding hardening.** Content-Length stripped from forwarded requests; host/port validated at deserialization; weight made optional with default 1 in spec; metrics carry model/endpoint/status labels with parking-excluded duration; circuit-breaker pruning on routing-map replace; balancer truncation fix; stale comment rewrite; unused engine_runner.rs deleted.
- **#83 — WorkerInfo/WorkerMemoryReport Redis schema enforcement.** Full field-level validation at both Redis boundaries (parseWorkerInfo and parseReport). Generated type aliases replace hand-written interfaces. Empty capabilities rejected; empty devices accepted with warning. 502 added to GET /api/v1/catalog. Redocly lint suppressions for Redis-only schemas.
- **#17 — updatedAt description correction.** Spec and docs no longer claim the proxy uses updatedAt for staleness detection. Clarified as informational (diagnostics/display).
- **#81 — Docs accuracy sweep.** 15+ items: stale contract index, wrong npm commands, wrong import paths, dead links, missing ADR-018, env-var renames, incomplete README indexes, undocumented env vars, PENDING→STARTING spec fix, and more.

## Verification status

| Gate | Status |
| ---- | ------ |
| `make typecheck` | PASS (dashboard SVG errors are pre-existing) |
| `make lint` | PASS |
| `cargo check` / `cargo clippy -D warnings` | PASS |
| `cargo test` | 112/112 passed |
| vitest (control-plane + dev-worker) | 485+ tests passed |
| `npx redocly lint` | 1 pre-existing warning (ClusterEvent unused) |
| Codegen drift | Clean |

## Not locally verifiable

- None — all gates ran locally (Rust toolchain available)

## Test plan

- [x] All cargo gates pass (check, clippy, test)
- [x] All vitest suites pass (control-plane, dev-worker)
- [x] Codegen drift check clean
- [x] Redocly lint passes (1 pre-existing warning)
- [x] TypeScript typecheck passes
- [x] Zero dead relative links in docs
- [x] Zero orphan docs missing from README indexes

Closes #15, closes #80, closes #100, closes #83, closes #17, closes #81
