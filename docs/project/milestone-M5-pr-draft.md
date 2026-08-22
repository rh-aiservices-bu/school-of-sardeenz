# PR: Milestone M5 — Security & Trust Boundaries

## Summary

Enforces the trust boundaries the docs assume: auth + NetworkPolicies for control-plane and worker APIs, dashboard auth/header/authz fixes, resource-exhaustion limits, error-body leaks, modelPath containment, SIF supply-chain integrity, VAP identity fix, dev-default hardening.

**15 issues, 17 commits on `milestone-M5`.**

### Per-issue summary

- **#110** — VAP matchConditions fixed to use `object.spec.serviceAccountName` (not controller-manager identity); added `pods/ephemeralcontainers` coverage
- **#101** — SSE cookie path widened from `/api/events` to `/api` so model-logs stream works with auth; terminal error state after failure threshold
- **#127** — CI workflow: `permissions: {contents: read}`, SHA-pinned actions, removed drifting line numbers from comments
- **#97** — Proxy wake transport-error path no longer leaks control-plane URL to clients
- **#103** — Dashboard DELETE notification routes now require `admin` (were `admin-readonly`)
- **#113** — modelPath validated against weightsDir in both control-plane route (400) and worker launcher (realpath + containment check)
- **#88** — Control-plane API auth via `SARDEENZ_API_TOKEN` shared secret, NetworkPolicy, UNAUTHORIZED error code, proxy + BFF callers updated, 401 responses in OpenAPI spec
- **#115** — SIF supply chain: digest-pinning in build-sif.sh, ORAS catalog entries require `@sha256:`, HTTPS enforcement, Apptainer .deb checksum verification
- **#108** — Worker agent auth via `SARDEENZ_WORKER_TOKEN`, NetworkPolicy, WorkerClient sends token
- **#104** — CSP security headers via @fastify/helmet, dead `corsOrigin` config removed
- **#95** — Configurable body cap (`SARDEENZ_PROXY_MAX_BODY_BYTES`, default 1MiB), parking byte budget (`SARDEENZ_PARKING_MAX_BYTES`, default 1GiB), `body_json` dropped before parking
- **#105** — BFF proxy-aware: `SARDEENZ_PUBLIC_URL`, `trustProxy`, hardened rate limiter (ip+username key), OAuth env validation at startup
- **#19** — Forwarding concurrency limits (`SARDEENZ_PROXY_MAX_CONCURRENT_FORWARDS`, `_PER_MODEL`), ingress rate-limiter documented as mandatory
- **#119** — Dev hardening: APPTAINERENV filter in spawn env, compose ports bound to localhost, .dockerignore additions
- **#107** — Dashboard hardening: SSE write-after-end guard, safeCompare SHA-256 hash, auto-logout timer cleanup, i18n for untranslated strings

### Deferred items

- **#88 Layer 3** — `/metrics` on separate listener (deferred)
- **#107 item 4** — OAuth JWT exchange code (file new issue — roughly the size of items 1-5 combined)
- **#107 item 6** — Dashboard deployment manifest (file new issue — needs SARDEENZ_SERVE_STATIC coordination)
- **#119 item 1** — Shim bind address (blocked on #111, not in M5)
- **#115** — cosign verify of source OCI image before signing (file new issue)

### Not locally verifiable

- **#110** — VAP admission test requires a live K8s cluster
- **#108, #88** — NetworkPolicy effectiveness requires cluster with CNI
- All forwarding/concurrency limits verified via integration tests

### New issues to file

1. `/metrics` on separate control-plane listener (from #88 Layer 3)
2. OAuth JWT exchange code — replace URL fragment with single-use code (from #107 item 4)
3. Dashboard deployment manifest (from #107 item 6)
4. cosign verify in librarian pipeline (from #115)

Closes #110, #101, #127, #97, #103, #113, #88, #115, #108, #104, #95, #105, #19, #119, #107
