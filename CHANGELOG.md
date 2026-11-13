# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- **Automated dependency updates start: `.github/dependabot.yml` (issue #233).**
  GitHub now opens weekly version-update PRs (Mondays) across 14 entries — npm
  (root lockfile, all workspaces), cargo (`proxy/`), pip (docs requirements +
  the three runner shims), GitHub Actions workflows, and Docker base images
  (×7: the six Dockerfile/Containerfile directories under `containers/` plus
  the shipped `proxy/` image; current runner versions only) — with minor+patch
  updates grouped into one PR per entry (`open-pull-requests-limit: 10`);
  major bumps and security updates stay individual. Complements the M14-style
  manual alert chasing (#224–#229).

- **M17's architecture decisions are recorded as ADR-027 and ADR-028.**
  [ADR-027](docs/architecture/adrs/adr-027-shim-memory-device-scope.md): shim
  `/memory-report` figures are device-scope observations, not attributions — consumers must
  branch on `attribution` before aggregating (implements #244's decision; the per-runner
  display rule is Phase 5's). [ADR-028](docs/architecture/adrs/adr-028-drain-signal-semantics.md):
  the drain signal is two-valued (count | unknown), fail-open on unknown at the shim guard and
  the control-plane drain loop, and the 409-in-the-drain-window ERROR landing is deliberate
  (implements #239's recorded semantics). The launcher's per-probe health budget
  (#243, `healthProbeTimeoutMs`) is documented in
  [runner-contract.md](docs/architecture/components/runner-contract.md).

- **Phase 5: co-location placement policy (issue #276).** A model may now opt in to kvcached
  elastic co-location (`allowCoLocation` on the deploy request / model configuration, dashboard
  deploy-form switch): the placement pipeline may place its instances on a device past naive
  byte-sum capacity when every instance already resident on that device (including sleeping
  ones — they keep their holds) belongs to a runner type declaring `kvCacheElasticSharing` on
  the target worker, and the device reports a kvcached pool. Headroom is
  `min(freeBytes + preallocBytes, (SARDEENZ_COLOCATION_MAX_POOL_HEADROOM_PERCENT / 100) × poolTotal)`
  (integer percent, default **50**, `0` disables elastic headroom; new control-plane env wired
  through `deployment/`). The capability guard is fail-closed — an unresolvable co-resident
  (deleted model record, worker no longer reporting the runner type) counts as non-elastic and
  blocks co-location, so non-kvcached runners are never silently co-located (the phase-4 OOM
  guard). `placeFixed` (move) applies the same rules and still never evicts. The wake
  pre-check is now per-device and excludes the waking instance's own hold (sleep never
  released it, so the old worker-wide sum produced a phantom shortfall), and wake eviction
  victims are scoped to the waker's device co-location group (`coLocationGroup` in
  `placement.ts` — the single derivation, also the #277 import surface), sized per device
  (`requiredMemory / tensorParallel`) and bounded by `SARDEENZ_EVICTION_MAX_PER_CYCLE`;
  legacy instances without `deviceIndices` keep the worker-wide fallback. The cap env is
  validated at boot (integer percent 0–100, otherwise the control plane refuses to start —
  `SARDEENZ_SIF_IMPORTER` posture), any unknown-placement (null/empty `deviceIndices`)
  resident on the worker — including an ERROR instance that retains a reservation hold —
  fails the elastic guard closed, and `freeBytes + preallocBytes` is clamped to the pool
  `totalBytes` at consumption (belt-and-braces: unreachable while the boot validation keeps
  the cap at ≤ 100, pinned for direct constructions with a wider cap). New migration
  `control-plane/migrations/008-add-allow-co-location.sql`; `DeviceInfo.kvCache` telemetry now
  documents its two placement consumers (the #276 elastic co-location headroom branch and the
  #277 shared-pool pressure evaluator) — all other consumers, and all non-elastic placement
  math, still treat it as telemetry only.

- **Phase 5 plan document: `docs/project/phase5.md` (issue #279).** The phase doc linked from
  `overall-plan.md`'s Phase 5 section: the phase's objective and
  design notes (#276 co-location placement policy, #277 shared-pool pressure response, #278
  consumer-side attribution rule), and the **Gate 9b recipe** — the deploy-only,
  control-plane-driven co-location verification procedure that complements the worker-driven
  Gate 9 (which asserts `deviceIndex` only): deploy two `allowCoLocation: true` vLLM models
  pinned to one device through the CP, assert both instances ACTIVE and both runners'
  `/memory-report` carrying `kvCache` blocks satisfying the `KVCachePoolStats` partition
  invariant (`totalBytes = usedBytes + preallocBytes + freeBytes`), an optional
  concurrent-inference smoke, and a required NVML reality check (freeBytes is unbacked virtual
  capacity, so the ratified headroom formula can count it twice — acceptance measures actual
  device usage under concurrent inference, not only placement success). Also:
  `overall-plan.md`'s Phase 5 section now points at the phase doc, and `phase4.md`'s
  deferred-OOM-guard sentence is closed (the guard lands as Phase 5: #276, #277 and #278 are
  all merged onto this phase branch); `docs/project/status.md` is synchronized by the phase
  docs commit (Phase 5 flips from Next to implemented-on-branch, the deploy-only list gains the
  Gate 9b run + live pool-pressure + migration-008 entries, and the #244 residual follow-up is
  closed). A description-only contract reword rides along:
  `WorkerModelInfo.memoryUsedBytes`'s absence clause now also covers a co-located device-scope
  row deliberately dropped post-#278.
- **Phase 5: shared-pool pressure response (issue #277).** The reconciliation tick gains an
  `evaluatePoolPressure` step (directly after `refreshMemoryBudgets`): when a device's
  kvcached pool stays at/above `SARDEENZ_POOL_PRESSURE_THRESHOLD_PERCENT` (integer percent,
  default **90**) of `kvCache.totalBytes` for `SARDEENZ_POOL_PRESSURE_DEBOUNCE_TICKS`
  (default **3**) consecutive ticks, the control plane reclaims capacity through the existing
  `EvictionEngine` — the system's first memory-pressure eviction trigger (eviction is
  otherwise demand-only). Victims are drawn ONLY from the pressure device's co-location group
  (`coLocationGroup` in `placement.ts` — the single derivation, imported; a pressure event on
  device D never tears down a co-tenant on device E), with a solo-device guard (a device with
  a single resident cannot be relieved by evicting it).
  Victim action = **stop** (decision 2026-11-13): the existing reconciliation-native teardown
  — `stopModel` (deliberately **drain-free**: the null runner client skips `waitForDrain`, so
  pressure relief cuts in-flight requests instead of waiting on the traffic causing the
  pressure; the shim-side stop still gives the runner its SIGTERM grace), then best-effort
  `stopRunner` process reap (404-tolerant; a non-404 failure reclassifies the stranded STOPPED
  record as observable ERROR), instance record removed, holds released by `stopModel` itself
  — sized by configured `requiredMemory` (the sizing overshoot for a pool-sized problem is
  accepted); the wave's `requiredBytes` targets the excess above
  `SARDEENZ_POOL_PRESSURE_RELEASE_TARGET_PERCENT` (integer percent, default **75**, must stay
  below the threshold — both percents resolve to their defaults before the boot cross-check).
  The fired devices of one tick share one `SARDEENZ_EVICTION_MAX_PER_CYCLE` budget (N fired
  devices can no longer evict N× the cap), the wave instruments `evictionDuration` like the
  other eviction paths, and the engine's circuit breaker is shared with the deploy/wake paths,
  never bypassed; each stopped victim logs a wave record, sends a danger notification, and
  publishes the first `EVICTION_TRIGGERED` cluster event (existing enum, no contract change).
  Telemetry-tolerance is structural: stale budgets, devices without a `kvCache` block, and
  zero pool totals never trigger. The whole evaluator is off until
  `SARDEENZ_POOL_PRESSURE_ENABLED=true` (shipped `'false'` in `deployment/`; leader failover
  resets the in-memory debounce counters — the conservative direction).

### Security

- **Dev tooling: `@redocly/cli` 1.x → 2.78.0 clears the last alert reachable from `dev`.**
  The 1.x CLI pins `@faker-js/faker` exactly at 7.6.0 (via `@redocly/respect-core`), inside
  the `GHSA-qxc2-j82w-r537` / CVE-2026-73231 range `<= 10.4.0` (high; `faker.helpers.fake`
  arbitrary code execution, alert #119). The fix is not forceable by an override: the first
  patched version is 10.5.0, and `respect-core` 1.x calls the `faker.name` / `faker.address` /
  `faker.datatype` namespaces that v8–v10 removed, so an override would break Redocly's
  `respect` command. The v2 CLI instead drops the whole dependency chain — the lockfile loses
  148 entries (faker, `handlebars`, `redocly`, `mobx`/`styled-components`, the OpenTelemetry
  stack, `glob` 7, `undici` 6.29.1, `yaml` 1.10.x, `swagger2openapi`, …) and adds none;
  `redocly lint` output on all four specs is byte-identical to 1.x (valid, 7 problems ignored
  per `.redocly.lint-ignore.yaml`) and the `build-docs` renderer still produces the prerendered
  Redoc page. `preview-docs` is gone in v2, so `docs/usage/api-reference.md` now documents the
  `build-docs` + open-the-file recipe. `dashboard/AGENTS.md`'s dual-React caveat (#148) is
  restated: the root still hoists React 19 (now a peer fill, no longer via Redocly).
  **Alert bookkeeping:** Dependabot scans the default branch (`main`), which is still at
  `34d28a0` — 142/142 open alerts match `main`'s lockfiles, 1/142 matched `dev@c0150d4` (this
  one) and 0/142 match the new lockfile. The remaining 141 clear when `dev` is next released to
  `main`; they are not actionable on `dev`.
- **Dashboard BFF: the request logger redacts `token` query values (issue #269).** With the
  SSE-only `?token=` fallback (#237) the JWT still travelled in a URL, and Fastify's default
  `req` serializer logged that URL at info level on every request — a connect-time credential
  in the access log, the same leak class #237 closed for routing. The BFF now installs its own
  `req` serializer (`dashboard/server/log-redaction.ts`): the `token` parameter is written as
  `token=[REDACTED]`, other query parameters are preserved byte for byte, and a URL without a
  token is logged unchanged. Verified live against the built BFF: before the change
  `"url":"/api/events?token=…"` appeared in the log, after it `"url":"/api/events?token=%5BREDACTED%5D"`.

- **Dashboard BFF: the deprecated `?token=` query fallback is now accepted on the
  three SSE routes only (issue #237).**
  The token extractor's query-parameter fallback fired on every protected route,
  so a JWT pasted into any URL authenticated state-changing POST/DELETE calls
  even though the fallback exists for `EventSource`, which cannot set headers —
  and URL tokens leak into access logs, browser history and `Referer` headers.
  The fallback is now path-gated to `GET /api/events`, `GET /api/models/:name/logs`
  and `GET /api/models/:name/instances/:instanceId/startup-logs`; on every other
  route a query token is ignored and the request 401s through the ordinary
  missing-token path. The `sardeenz_sse` HttpOnly cookie remains the SSE
  mechanism and the deprecation warning now logs only when a query token is
  actually accepted.

- **Deployment: Valkey requires AUTH from an operator-created Secret, and the `sardeenz`
  namespace ships default-deny ingress with explicit allow NetworkPolicies (issue #230).**
  The sclorg Valkey container now receives `VALKEY_PASSWORD` (secret key `REDIS_PASSWORD` of
  `sardeenz-redis-credentials`) and enables `requirepass`; its startup/readiness exec probes
  pass the password to `valkey-cli` via `REDISCLI_AUTH` (shell form — K8s exec probes run
  without a shell; no secret in the probe argv), and the auth-independent `tcpSocket` liveness
  probe is unchanged. All four `SARDEENZ_REDIS_URL` consumers (control plane, proxy, dashboard
  BFF, worker) move from an inline passwordless URL to `secretKeyRef` on that Secret; local
  dev stays passwordless.
  Three new NetworkPolicy manifests: `prereq/networkpolicy.yaml` (namespace default-deny
  ingress + redis 6379 ← CP/proxy/dashboard/worker + postgres 5432 ← CP),
  `proxy/networkpolicy.yaml` (8080 ← router + dashboard BFF chat forwarding, 9099 ←
  `openshift-user-workload-monitoring`) and `dashboard/networkpolicy.yaml` (4000 ← router);
  flow table in `docs/usage/deployment-security.md`, secret runbooks in the deployment and
  prereq READMEs. **Upgrade:** create `sardeenz-redis-credentials` (runbook in
  `deployment/prereq/README.md`) before rolling out these manifests — pods referencing the
  missing Secret fail to create (`CreateContainerConfigError`); rotating the password requires
  restarting all five deployments (every consumer reads `SARDEENZ_REDIS_URL` at process start).

- **Deployment: module-PVC write protection ships armed — `deployment/prereq/` now renders
  a `Namespace` labelled `sardeenz.io/module-guard: enforce`, so a stock
  `oc apply -k deployment/` activates the ValidatingAdmissionPolicyBinding on first apply.**
  The manual `oc label namespace` step is retired from the runbooks in favor of a
  verify-the-label step; removing the label is the explicit opt-out (#232).

- **Deployment: container securityContexts hardened across the production workloads, and the
  `sardeenz-sif-runner` SCC no longer grants `NET_BIND_SERVICE` (issue #235 — the manifest
  half; the image/supply-chain half moved to #266 in M19).**
  The control-plane and proxy containers gain `readOnlyRootFilesystem: true` with an
  `emptyDir` mounted at `/tmp` (the control plane's `HOME=/tmp/sardeenz` and all temporary
  writes land there; persistent data stays on the modules/weights PVCs). The proxy pod sets
  `automountServiceAccountToken: false` — it never calls the Kubernetes API. The control
  plane, dashboard, and librarian keep their ServiceAccount tokens, and the worker keeps
  its ServiceAccount for the SCC binding without calling the Kubernetes API. The worker
  container gains
  `runAsNonRoot: true` (admission-level enforcement on top of the SCC's `MustRunAsRange`, so a
  root-`USER` image fails fast). The librarian's `build-oci` init container matches the
  `publish-sif` sibling (no privilege escalation, all capabilities dropped). The SCC drops its
  unused `NET_BIND_SERVICE` — every runner port (9100–9228) is above 1024 — aligning it with
  ADR-016's "no added capabilities" posture. Operator notes in
  `docs/usage/deployment-security.md`.

- **Control plane: every `:instanceId` path parameter is now validated before it reaches
  Redis key composition (issue #236).**
  A new `assertValidInstanceId` guard (`control-plane/src/utils/instance-id.ts`, mirroring the
  #120 `assertValidModelName` gate) rejects ids outside `^[A-Za-z0-9._-]{1,64}$` — excluding `:`
  (extra `redisKey` join segments), the glob metacharacters `* ? [ ]`, `/` and whitespace — with
  a 400 `INVALID_REQUEST`. Applied beside the existing `assertValidModelName` call on all five
  instance-scoped routes: instance delete, sleep, wake, move and startup-logs. The pattern is
  deliberately looser than the `inst-<12hex>` mint format so legacy and manually created ids
  keep working; valid ids see an unchanged Redis key shape.

- **Dashboard BFF: `@fastify/static` upgraded to v10 (10.1.10), clearing the two
  remaining `@fastify/static` manifest alerts and the dev-tooling `glob` 13.x copy.**
  The direct dependency moves from `^9.1.3` to `^10.1.10` — the v10 major that pins
  `glob ^14`, so the nested `glob` copy under `@fastify/static` moves 13.0.7 → 14.0.5,
  clearing alert #156 (the remaining open `glob` alert fires on the 13.x line; the root
  `glob` 7.2.3 copy is dev-tooling-only and not affected). The two manifest alerts on
  `dashboard/package.json` — #46 (`@fastify/static <= 10.1.0`) and #47 (`<= 10.1.1`,
  authorization bypass via non-canonical URL paths and route-guard bypass via path
  traversal) — clear on version. The only 10.x-behavioral surface this BFF uses is
  unchanged: `dashboard/server/server.ts` registers with `wildcard: false` (v10 keeps
  per-file route registration for that mode, now via a `glob('**/**')` walk instead of
  the v9 recursion) and serves the SPA fallback through `setNotFoundHandler` +
  `reply.sendFile('index.html')` (still decorated in v10, same signature). Collateral
  in-range moves, disclosed: `content-disposition` 2.0.2 → 3.0.0, and inside the nested
  glob chain `minimatch` 10.2.6 → 11.0.8, `path-scurry` 2.0.2 → 3.0.0,
  `brace-expansion` 5.0.12 → 5.0.13, `balanced-match` 1.1.0 → 3.0.0, plus new leaf
  `@isaacs/nonrecursive-glob-match` 1.1.0. Verified in-container with the v10 runtime
  staged from registry tarballs: dashboard client build passes and the full workspace
  `vitest run` is 98/98 files, 1502 passed + 1 skipped (includes the BFF suites that
  exercise the static/SPA-fallback path); the Playwright e2e specs run in CI.
- **Dashboard: `react-router-dom` upgraded to v7 (7.18.5), clearing the two remaining
  medium `react-router` alerts.** The direct dependency moves from `^6.30.6` to `^7.18.5`
  — the first version of the v7 line that patches Dependabot alerts #92 (GHSA-337j-9hxr-rhxg
  / CVE-2026-53666: constructor injection via `deserializeErrors()` in SSR hydration;
  inapplicable to this declarative-mode `BrowserRouter` SPA) and #93 (GHSA-wrjc-x8rr-h8h6 /
  CVE-2026-53669: open redirect via backslash in `<Link>`/`useNavigate`; residual surface
  confirmed unreachable — navigation targets are app paths and the `state.from` round-trip
  carries `location.pathname` only). The v6 line is EOL (6.30.6 was its final release), so
  the major upgrade is the only path to a clean alert state. `react-router-dom` v7 remains
  an official package — a thin ESM re-export shim of `react-router` 7.18.5 plus
  `RouterProvider`/`HydratedRouter` from its `react-router/dom` deep import (unused here;
  the app uses only `<BrowserRouter>`) — so all 12 consumer files keep their
  `react-router-dom` imports unchanged; the dependency closure shrinks by dropping
  `@remix-run/router` and gains `cookie` 1.1.1 (nested under `react-router`, distinct from
  the root `cookie` 2.0.2 copy) and `set-cookie-parser` 2.7.1 (already in the tree, now
  production). v7's behavioral deltas adopted as defaults — `v7_startTransition` (router
  state updates move to `React.useTransition`) and `v7_relativeSplatPath` (relative-link
  resolution inside multi-segment splats) — are both no-ops for this app: it has no
  `React.lazy` inside components, and all `<Link>`/`navigate()` targets plus the
  `state.from` value are absolute app paths (no multi-segment splats, no relative links).
  The stale `react-router-dom`-is-CJS comment in `NotificationProvider.test.tsx` (issue
  #148's root-hoisting render-split rationale) is updated: v7's shim is ESM and resolves
  the same React instance. One v7 signature change required source edits: `useNavigate`
  now returns `Promise<void>` (data-router alignment), so the seven `NavItem` handlers in
  `AppLayout.tsx` and the redirect in `OAuthCallback.tsx` adopt the `void navigate(...)`
  idiom the codebase already uses elsewhere, satisfying `no-misused-promises` /
  `no-floating-promises`. Verified in-container with the v7 runtime staged from registry
  tarballs: dashboard client build (`vite build`) passes, and the full workspace
  `vitest run` is 98/98 files, 1502 passed + 1 skipped; the Playwright auth/navigation e2e
  specs run in CI.
- **Proxy: Rust advisory bump clears the five open Rust Dependabot alerts.** A pure
  `Cargo.lock` refresh (`cargo update -p rustls -p quinn-proto`; no manifest change — both
  crates are transitive under `reqwest` 0.12 with the `rustls-tls` feature and HTTP/3):
  `rustls` 0.23.40 → 0.23.46 clears alerts #159–#162 (2 medium + 2 low; 0.23.45 patches
  two, 0.23.46 the other two) and `quinn-proto` 0.11.14 → 0.11.19 clears #158 (high,
  HTTP/3 DoS, GHSA-c96f family, first fixed in 0.11.15). Collateral in-range moves,
  disclosed: `rustls-webpki` 0.103.13 → 0.103.16, `zeroize` 1.17.0 → 1.19.0 /
  `zeroize_derive` 0.41.0 → 0.47.0, and new leaf dependencies of `quinn-proto` 0.11.19
  (`chacha20` 0.10.2, `cpufeatures` 0.3.1, `pkg-config` 0.3.34 build dep,
  `rand`/`rand_core`/`rand_pcg` 0.10.x). Verified with `cargo check` (clean) and
  `cargo test` (48/48 passed).

- **Dashboard BFF: JWT library bumped to clear the 6 open Dependabot alerts on the
  transitive `fast-jwt` verifier.** `@fastify/jwt` moves from `^10.1.0` to `^10.2.7`
  (same major, explicit security floor), which lifts `fast-jwt` from the pinned 6.2.4
  to 6.3.6 — outside every vulnerable range. The alerts (Dependabot #20–#25): 1 critical
  (incomplete CVE-2026-34950 patch, non-whitespace key-prefix re-enabling HS confusion),
  3 high (raw public JWK JSON treated as HMAC secret, unsigned-JWT acceptance, silent
  claim-validator bypass on array payloads), 2 medium (`clockTolerance: Infinity`
  bypassing exp/nbf, verifier cache accepting expired JWTs without iat). The sole
  importer is `dashboard/server/plugins/auth.ts` (register opts +
  `request.jwtVerify<JwtPayload>()`; `dashboard/server/routes/auth.ts` also signs via
  `app.jwt.sign`). `@fastify/jwt` 10.2.x introduces no breaking change on that surface
  (verified against the 10.1.0/10.2.7 tarballs — the runtime deltas are stricter option
  validation and a double-callback guard, neither reachable from the plugin's usage).

- **Control plane and dashboard BFF: `undici` bumped to clear the 29 open Dependabot alerts
  on the 7.x line.** The direct `undici` dependency in both workspaces moves from `^7.10.0`
  to `^7.30.1` (same major, explicit security floor), lifting the resolved 7.27.2 to
  7.30.1 — the highest published 7.x and the only release outside every vulnerable range on
  this line (10 high, 14 medium, 5 low). 7.29.1 is not sufficient: Dependabot alert #40
  (DoS via an unhandled error on excessive content-encodings, `>= 7.18.0 < 7.30.1`) is
  first patched in 7.30.1, which also restores TLS options dropped by `Agent`'s constructor
  clone (Dependabot alert #8 class) and fixes the TLS 1.2 renegotiation DoS. Consumers are
  the control-plane SIF importer (`control-plane/src/services/sif-importer.ts`, undici
  `fetch`/`Headers`) and the dashboard BFF Prometheus client
  (`dashboard/server/clients/prometheus.ts`, an `Agent` with `connect: { ca }` injected as
  the `dispatcher` fetch option); 7.30.1 changes no runtime dependency, engine constraint
  or type declaration on either surface, so no source edits are needed. The remaining open
  `undici` Dependabot alerts apply to the dev-tooling 6.24.1 copy pinned by
  `@redocly/respect-core` and are tracked in #227.

- **Dashboard: `react-router-dom` bumped to clear the open redirect alert on the 6.x
  line.** The direct dependency moves from `^6.28.0` to `^6.30.6` (same major, explicit
  security floor), lifting the resolved 6.30.4 to 6.30.6 — the final 6.x release and the
  patched version for Dependabot alert #1 (GHSA-jjmj-jmhj-qwj2 / CVE-2026-53668,
  moderate: protocol-relative open redirect — a
  `//evil.com` target given to `<Link>`, `<Navigate>` or `useNavigate` was resolved as an
  external URL, enabling an attacker-controlled redirect; vulnerable `>= 6.30.2 <= 6.30.5`,
  fixed 6.30.6). The sole behavioral change is a `resolvePath()` hardening in
  `@remix-run/router` 1.23.4: every resolved path is now double-slash-normalized, so
  external/protocol-relative navigations are treated as in-app paths — the dashboard's
  own `Link`/`Navigate`/`useNavigate` targets are app paths, but its login redirect
  derives `state.from` from `location.pathname` (reachable with a crafted SPA-fallback
  URL pre-patch), so the hardening closes that path too; no source edits are needed. No
  public API or type changes; 6.30.5 is a broken publish (its router dependency stayed
  1.23.3) and is never resolved under this range. Two Dependabot alerts remain open on
  `react-router` itself (#92 GHSA-337j-9hxr-rhxg — constructor injection via
  `deserializeErrors()` in SSR hydration, not applicable to this BrowserRouter SPA; #93
  GHSA-wrjc-x8rr-h8h6 — open redirect via backslash in `<Link>`/`useNavigate`, residual
  but not reachable here): they are fixed only in 7.18.0, v6 is EOL, and clearing them
  requires the v7 major upgrade tracked as a separate follow-up — this bump does NOT fix
  them.

- **Dev tooling and runtime bundles: transitive dependency sweep clears 87 of the 100
  Dependabot alerts firing against the base lockfile (GitHub shows 141 open rows — 136
  npm + 5 rust — because alerts already fixed by #224/#225/#226 stay open until
  re-scan; the 5 Rust rows are untouched here).** A root
  `npm update --package-lock-only` refresh (npm workspaces, no pnpm) lifts every
  alerted dependency reachable in-range to its Dependabot fix or beyond — 13 alerts
  remain on the refreshed tree: the residuals enumerated below plus the two
  `react-router` 6.x alerts (#92/#93) carried by the #226 entry above and tracked in
  #229. The one `dompurify` copy npm update cannot reach — `monaco-editor`'s nested
  copy — is collapsed via a scoped override, and the existing root `"dotenv": "^17.0.0"`
  override (the dotenv unification override) is preserved; the combined `overrides`
  object in root `package.json` is:

  ```json
  "overrides": {
    "dotenv": "^17.0.0",
    "monaco-editor": {
      "dompurify": "3.4.17"
    }
  }
  ```

  No direct dependency range changes and no source files change.
  Per-package outcomes (locked before → after; Dependabot floor where applicable):
  `@redocly/cli` 1.34.15 → 1.34.24, `handlebars` 4.7.9 → 4.7.10 (critical alert #28),
  `js-yaml` 4.2.0 (+3×4.1.1 nested) → 4.3.2 single copy, `undici` (the
  `@redocly/respect-core` 6.x copy) 6.24.1 → 6.29.1, `undici` (direct, hoisted to root)
  7.30.1 → 7.30.2, `vite` 7.3.5 (×3: dashboard + `vitest`/`vite-node` nested) → 7.3.8
  single copy, `esbuild` 0.27.7 (+ `tsx`-nested 0.28.1) → 0.28.2 single copy,
  `postcss` 8.5.15 → 8.5.32, `browserslist` 4.28.2 → 4.29.5,
  `baseline-browser-mapping` 2.10.37 → 2.11.35, `source-map-js` 1.2.1 → 1.2.2,
  `form-data` 4.0.4 → 4.0.6, `shell-quote` 1.8.4 → 1.12.0, `fast-uri` 3.1.2 → 3.1.9 root
  copy (new 4.2.3 nested under `@fastify/ajv-compiler` / `fast-json-stringify`, outside
  every alert range), `brace-expansion` 1.1.15 → 1.1.21, 2.1.1 → 2.1.7, 5.0.6 → 5.0.12,
  `dompurify` 3.4.15 (+ `monaco-editor`'s nested 3.1.7) → 3.4.17 single copy,
  `monaco-editor` 0.54.0 → 0.56.0. Three land above the issue's stated minimum: `vite`
  7.3.8 > 7.3.7, `baseline-browser-mapping` 2.11.35 > 2.11.0, and `@redocly/cli`
  1.34.24 > 1.34.17 — 1.34.17's `@redocly/respect-core` pins `undici` exactly at
  6.27.0, still inside the 6.x vulnerable ranges; only 1.34.24 pins 6.29.1, so all 11
  undici-6.x alerts clear together with the handlebars fix (1.34.17 still pins 4.7.9).
  This closes the loop on the #225 entry, which left the 6.x `undici` copy
  "tracked in #227": the 6.x copy is now 6.29.1 and all 11 undici-6.x alerts close.
  Two side-effect clearances ride the sweep: `fastify` 5.8.5 → 5.12.8 (first patched
  5.12.5 — 7 alerts: 4 high #135–#138, 3 medium #120/#121/#139) and `find-my-way`
  9.6.0 → 9.10.0 (first patched 9.7.0 — 1 alert, #91 high), shrinking the planned
  fastify-stack follow-up (#231) to `@fastify/static` + `glob`.
  The dompurify collapse clears every open dompurify alert, including #63 (low;
  `<= 3.4.6` — GitHub shows no first-patched version on that advisory, but 3.4.17 sits
  outside its range and the alert closes on re-scan). One residual rides inside that
  outcome: `monaco-editor` 0.56.0 also vendors its own DOMPurify 3.4.8 copy inside its
  published dist (`domSanitize` imports it), so the override fixes the dependency-graph
  alert only — the vendored in-bundle copy remains inside the #36 critical / #39 high
  windows but is not demonstrably exploitable through monaco's sanitizer configuration;
  the true fix is upstream (monaco unbundling DOMPurify), documented as a residual
  below.
  Scope disclosure: `npm update --package-lock-only` refreshes the whole in-range tree
  (~313 changed lock paths), not only the alerted packages. Several majors land only
  because their pullers bumped their own dependency ranges in the same refresh —
  `fastify` 5.12.x now declares `fast-json-stringify` `^7`, `react-i18next` 17.1.13
  now declares `html-parse-stringify` `^4`, and `style-to-object` rides a puller swap
  (`style-to-js` dropped for `hast-util-to-jsx-runtime`'s new `style-to-object ^2.0.0`)
  — and npm resolves the rest in-range under the pullers' declared ranges,
  npm-canonical, exercised by the deferred host gates below: `cookie` 1.1.1 → 2.0.2 (via
  `@fastify/cookie` 11.1.5, which now declares `cookie ^2.0.0`; consumed on the BFF
  `sardeenz_sse` cookie path), `fast-json-stringify` 6.4.0 → 7.3.4 (`fastify` response
  serialization), `style-to-object` 1.0.14 → 2.0.2 (markdown rendering in the chat path
  via `react-markdown`); `html-parse-stringify` 3.0.1 → 4.0.1 (dashboard i18n —
  `react-i18next` 17.0.8 → 17.1.13 now declares `^4.0.1`; `i18next` 26.3.1 → 26.7.2
  rides along), `@patternfly/chatbot` 6.7.1 → 6.9.0
  (this is what carried `monaco-editor` 0.54.0 → 0.56.0 via its `^0.56.0` peer),
  `@patternfly/react-{core,icons,styles,table,tokens,code-editor}` 6.6.1 → 6.7.0,
  `@patternfly/react-charts` 8.5.1 → 8.7.0 (the `@patternfly/react-*` wildcard
  doesn't cover it), `victory` 37.3.6 → 37.4.1, `posthog-js` 1.433.2 → 1.447.4,
  `set-cookie-parser` 2.7.1 → 3.2.2 (via `light-my-request`, now declaring
  `^3.0.1`, under `fastify`; the dev-chain root copy 2.7.1 stays pinned exactly
  by `@redocly/respect-core` 1.34.24), `sonic-boom` 4.2.1 → 5.0.2 (dev-chain
  `pino-pretty`, now declaring `^5.0.0`; the prod `pino` keeps the root 4.2.1),
  `@fastify/static` 9.1.3 → 9.3.0 (dashboard BFF static server; runtime).
  npm's dedupe also relocated or stepped down a few packages
  (`d3-format`, `d3-time-format`, `semver`, `react-dropzone`, `mobx-react`) — each
  resolves inside every puller's declared range and reopens no advisory.
  Residuals, documented not forced: `tinypool` 1.1.1 (2 critical alerts #140/#141) and
  the `vitest` 3.2.7 / `@vitest/mocker` alerts #2/#4/#33 (all medium) ride the same
  `vitest` 4 major in #228 — the fix ≥2.1.2 sits outside `vitest` 3's declared range,
  and `vitest` 4 drops `tinypool` entirely; `glob` 13.0.6 → 13.0.7 / 10.5.0
  unchanged (alert #156, medium) unreachable this sweep — their pullers
  `test-exclude` / `@fastify/static@9` cap below `glob` 14, so the fix is upstream
  plus #231; `@faker-js/faker` 7.6.0 (alert #119, high; fix ≥10.5.0 — deferred: only
  reachable via a 7→10 major-crossing override, confined to the dev chain's
  `redocly contract` fake-telemetry generation);
  `@fastify/static` 9.3.0 (alerts #46/#95, high; #47/#96, medium; fix ≥10.1.10 — the
  first-patched floor for these four is 10.1.2, but ≥10.1.10 also carries `glob` 14 and
  so closes #156, matching the #231 follow-up, a step this sweep has already shrunk: its
  `fastify` and `find-my-way` rows clear here); `monaco-editor` 0.56.0's vendored
  DOMPurify 3.4.8 (see above — the in-bundle copy inside the #36 critical / #39 high
  windows; this is a residual risk, not one of the 13; fix is upstream).
  `@redocly/cli` 1.34.24 is the terminal v1 release (`v1-archive`); the redocly v2 major
  migration is future work. Runtime verification (npm ci → dashboard client build →
  control-plane/dashboard/dev-worker suites → e2e → typecheck → scoped eslint → `npm ls`
  / `npm audit`) runs on the host by the user; nothing was executed in-container beyond
  the lockfile refresh and static assertions.

- **Dev tooling: vitest major bump clears the vitest, @vitest/mocker and tinypool
  alerts.** The root devDependencies `vitest` and `@vitest/coverage-v8` move from `^3.2.1`
  to `^4.1.12` in lockstep (`@vitest/coverage-v8@4.1.12` declares an exact `vitest: 4.1.12`
  peer, so the two cannot be bumped independently). This clears Dependabot alert #2
  (`@vitest/mocker` ≥2.1.0 <4.1.11), #4 (vitest, same range) and #33 (`@vitest/mocker`
  ≥2.1.0-beta.7 <4.1.12) via version, plus the two tinypool criticals #140/#141
  structurally: vitest 4 removed the tinypool-based worker pool, the new lock contains
  zero tinypool entries, and nothing in the tree depends on tinypool anymore.
  `@vitest/mocker` 4.1.12 no longer carries the vulnerable path (its dependencies are only
  `@vitest/spy`, `estree-walker`, `magic-string`). The lockfile change is bump-specific and
  its command must run under npm 11 (`npx -y npm@11 install --package-lock-only`; 11.21.2
  validated): npm 10.9.9 crashes in arborist strict mode on this exact resolution ("Cannot
  read properties of null (reading 'edgesOut')" in `#loadPeerSet`) — the crash is not
  caused by the repo's overrides block and is not expected to affect `npm ci`, but CI's
  npm 10 runs the first real execution of the new lock. A `--legacy-peer-deps` fallback
  was validated broken (silently drops required peers `@testing-library/dom` and
  `monaco-editor`, breaking the `monaco-editor.dompurify` override target, and jumps vite
  to 8.3.7 with a rolldown swap). Collateral, disclosed: `chai` 5.3.3 → 6.3.0 rides the
  bump as vitest's internal expect stack (the repo imports no chai directly); `vite` stays
  7.3.8 as a single copy (vitest 4.1.12's peer range `^6 || ^7 || ^8` keeps the existing
  hoisted 7.3.8); 23 top-level packages (37 lock entries) leave the lock — `tinypool`,
  `tinyspy`, `vite-node`, `test-exclude` and the vitest 3 pool/CLI chain, plus the
  istanbul/remapping coverage chain and the chai 5 support tree — replaced by `obug@2.2.1`
  and `@standard-schema/spec@1.1.0` (a new `@vitest/expect@4.1.12` dependency), with
  further version moves on the vitest chain (`ast-v8-to-istanbul` 0.3.12→1.0.8,
  `es-module-lexer` 1.7.0→2.3.2, `magicast` 0.3.5→0.5.5, `std-env` 3.10.0→4.3.0, `tinyexec`
  0.3.2→1.3.1, `tinyrainbow` 2.0.0→3.2.0). The lockfile shrinks 973 → 938 entries. One
  behavioral hardening rides along: vitest 4's default test excludes shrink to
  `node_modules` and `.git`, no longer skipping `dist/` — and CI runs `tsc --build` (which
  emits compiled `__tests__/*.test.js` into each composite project's `dist/`) before
  `make test`. The control-plane and dev-worker vitest configs gain an explicit
  `**/dist/**` exclusion so compiled copies of their test files are never discovered; a
  project-level exclusion is the effective mechanism because the root config's
  `test.exclude` is not merged into project configs when `test.projects` is set (root
  options only drive global behavior). The dashboard config already excluded `dist/**`
  explicitly and is unchanged; the control-plane integration config's src-scoped `include`
  glob cannot match dist. Residual: vitest 5.1.0 is the latest line (engines
  `^22.12 || ^24 || >=26` and vite ≥6.4.0 — both satisfied here) but is deliberately out
  of scope for this dev-chain-only bump; 4.1.12 is the terminal 4.1.x release and clears
  every open alert on the 3.x line. First real execution under vitest 4 (CI run 42711031269)
  surfaced three classes of runtime fallout, all fixed in test code only — no dependency or
  runtime-source changes: (1) `tsc --build` fails on 6 test files: `ReturnType<typeof vi.fn>`
  now resolves to `Mock<Procedure | Constructable>` (constraint instantiation; the untyped
  `vi.fn()` mock is neither callable as a concrete signature nor assignable to one), so the
  121 mock-type annotations across internal/model-logs/models/deploy-orchestration/
  reconciliation tests now use vitest's exported bare `Mock` type (= `Mock<Procedure>`, the
  exact v3 semantics) with `import type { Mock } from 'vitest'`; (2) `vi.restoreAllMocks()`
  no longer resets plain `vi.fn()` mocks (jest-aligned — it only restores spies), so the
  module-level `mockFetch` in worker.test.ts accumulates call history across tests and
  `mock.calls[0]` assertions read a previous test's request — fixed with an explicit
  `mockFetch.mockReset()` in `beforeEach`; (3) spy implementations are invoked via
  `Reflect.construct` when the spied site calls `new` (jest-aligned), so the
  `vi.spyOn(global, 'Date').mockImplementation(() => mockDate)` arrow replacement in
  notification.test.ts throws "not a constructor" on `new Date()` — replaced with
  `vi.useFakeTimers({ now })` (+ `vi.useRealTimers()` teardown), which also survives
  mid-test failure without leaking the mock into subsequent tests. A second CI wave (run
  43060242462 on the fix commit) surfaced a fourth: the type-aware eslint config flags
  `ReturnType<typeof vi.spyOn>` as `any` under v4 (same constraint-instantiation — v4's
  `spyOn` is generic over the spied property, so the resolved type is not the specific
  `MockInstance`), making `warnSpy.mockRestore()` an unsafe `any` call in memory-budget
  and worker-pool tests; those five declarations are now typed
  `MockInstance<(...args: unknown[]) => void>` with
  `import type { MockInstance } from 'vitest'`. Verified in-container by staging the
  vitest 4.1.12 type/runtime closure from registry tarballs (no npm tree
  operations): `npx tsc --build` clean for all affected suites, scoped eslint clean, and
  the full `npx vitest run` at 98/98 files, 1502 passed + 1 skipped. The host gates remain
  the authority for `npm ci`-materialized trees (`npm ci`, integration suite,
  `npm ls vitest`, `npm audit`).

- **Control plane and dev worker fail closed on missing auth tokens (issue #234).**
  `loadConfig()` now throws at startup when `SARDEENZ_API_TOKEN` or
  `SARDEENZ_WORKER_TOKEN` (control plane, both required) or `SARDEENZ_WORKER_TOKEN`
  (dev worker) is unset or empty, instead of booting with authentication silently
  disabled. The startup error names the missing variable(s) so an operator with a
  half-populated Secret can tell at a glance which key is missing. Local development
  opts out with `SARDEENZ_ALLOW_UNAUTHENTICATED_API=true` (truthy `1/true/yes/on`;
  `=false` still fails) — documented in `.env.example` and the setup guide. No manifest
  change: in-cluster tokens keep coming from `secretKeyRef`.
- **Dev worker: `POST /runners` entrypoint argv is now allowlisted (issue #238).**
  The worker validates the incoming `entrypoint` against its configured
  `SARDEENZ_RUNNER_ENTRYPOINT` (verbatim match) and — only when that vector has the canonical
  3-element `<exec> -m <module>` shape — the `-m` module family: `<exec> -m <m>` is admitted for
  `m` in {`sardeenz_vllm_runner`, `sardeenz_mlserver_runner`, the configured module}, with the
  exec required to match the configured exec0. Anything else is rejected with `400 BAD_REQUEST`
  before any process is spawned. Consequences for operators: a non-`-m` configured override
  disables the `-m` family (only the override vector itself is accepted — running both vLLM and
  MLServer catalog entries requires a `-m` vector such as the shipped default); a brand-new shim
  module beyond the known two needs it added to `KNOWN_SHIM_MODULES` in a worker release, and
  entrypoint-less catalog entries inherit the configured default. Absent/empty `entrypoint`
  still falls back to the configured default, and a `SARDEENZ_RUNNER_ENTRYPOINT` that resolves
  to an empty argv now fails worker startup loudly instead of producing per-request 400s. The
  worker-agent contract's `entrypoint` description gained the constraint sentence (generated
  types regenerated — description-only, no shape change).

### Changed

- **Agent config triaged and adapted from another project.** The `.omp/` agents, skills and
  pre-tool safety hook imported from the agents-jukebox project kept their orchestration method
  (Direct/Light/Full pipelines, role agents, report-scratchpad custody) but every
  repository-specific reference was rewritten for sardeenz: role models resolve through
  `modelRoles` aliases (`plan`/`slow`) instead of nonexistent explicit IDs, npm instead of pnpm,
  Kustomize instead of Helm (helm block rule dropped from the safety hook), JWT auth on
  `dashboard/server/plugins/auth.ts` instead of Keycloak, Playwright e2e specs in
  `dashboard/e2e/` instead of `dev-tools/e2e-scenarios/`, and `.omp/RULES.md` pointing at
  `docs/development/setup.md`. The boundary reviewer and `domain-rules`/`test-ui`/`verify`
  skills were rewritten wholesale (OpenAPI contract drift, proxy↔control-plane↔BFF shapes,
  DB migrations, runner contract); the duplicate `work-item-template.md` under
  `plan-milestone/references/` was deleted in favour of the `implement/` copy. The previously
  missing `docs/development/agent-profile.md` (required by the milestone skills) was created
  from the shipped template. `.gitignore` gains the `.omp/` scratchpad paths
  (`reports/`, `plans/`, `worktrees/`, `profiles`).

### Added

- **vLLM 0.26 runner image (`containers/runners/vllm/0.26.0/`).** A second current vLLM line,
  built from `quay.io/vllm/vllm-cuda:0.26.0_rhaiv.9` pinned to the OCI index digest
  `sha256:a16d7271…` (amd64 runtime plus attestation, as with 0.24), with Python 3.12, CUDA
  toolkit 13.0.2 and torch 2.11.0+cu130. kvcached is pinned to v0.1.6 (`2235a9ec…`), the first
  release that supports vLLM 0.26 and later. This base no longer ships kvcached's `posix_ipc` and
  `wrapt` dependencies (the 0.24 base did), so the builder also emits their wheels
  (`posix_ipc 1.3.2`, `wrapt 2.4.0`) and the runtime stage keeps installing `--no-index` from
  `/wheels`. Build-time assertions cover `cuda-toolkit 13.0.2`, vLLM `0.26.0`, torch's CUDA 13.0
  build, the compiler/Ninja toolchain and `Python.h`; the driver-stub RPM pin is unchanged
  (`cuda-driver-devel-13-0-13.0.96-1`). `VLLM_USE_V2_MODEL_RUNNER=0` is baked into the SIF, and the
  worker now forces Model Runner V1 for every kvcached module in the 0.24+ range (`vllm-0.24`,
  `vllm-0.26`) because kvcached only patches Model Runner V2 from vLLM 0.28. The catalog entry is
  pinned to the published `vllm:0.26-rc1` SIF (`sha256:075b3057…`).

- **MLServer runner: ONNX models.** The MLServer 1.7.1 image now installs
  `onnxruntime-gpu[cuda,cudnn]==1.26.0` (last PyPI build for CUDA 12) and the shim ships its own
  MLServer runtime, `sardeenz_mlserver_runner.onnx_runtime.ONNXRuntimeModel`, since Seldon
  publishes no `mlserver-onnx`. A model directory holding a `*.onnx` export (and no sklearn or
  Hugging Face markers) is auto-detected; explicit `model-settings.json` can pin the artifact,
  execution providers (`parameters.extra.providers`, CUDA preferred with CPU fallback), provider
  options and session options. Tensors map to KServe V2 inputs/outputs by name; structured
  outputs (e.g. ZipMap classifier probabilities) come back as `BYTES` JSON. The `mlserver-1.7.1`
  catalog entry gains the `onnx` tag and is pinned to the rebuilt `mlserver:1.7.1-rc4` SIF
  (`sha256:c9c6f049…`), the first published build with the runtime, the #206 drain fix and the
  CUDA-library fix below.
  The runtime now checks the session's active providers after load: an explicit
  `parameters.extra.providers` list that onnxruntime could not initialise fails the load, and
  the default CUDA-then-CPU preference logs a `falling back to` warning instead of serving
  silently on CPU.

### Fixed

- **vLLM runner shim: the active-request scrape now matches real `/metrics` text (issue #239).**
  It matched `"vllm:num_requests_running "` with a trailing space, but vLLM exports these gauges
  with labels (`vllm:num_requests_running{model_name="…",engine="0"} 8.0`), so the line never
  matched: `GET /health` reported `activeRequests: 0` whenever metrics were reachable, and the
  `POST /sleep` guard (`active > 0` → 409) never tripped — a sleep offloaded weights out from
  under in-flight generations. A new pure parser (`metrics.py`) matches the metric name followed
  by `{` or whitespace (never a `_`-suffixed sibling such as `_total`/`_bucket`), sums every
  label series (TP/DP emit several), requires **both** the running and waiting series to be
  present (a half-parsed scrape is not a drain signal), maps any non-finite sample to `None`
  before the final `int()`, and leaves the existing fail-open rule untouched: an unreadable
  scrape is still `None`, which skips the guard and lets the sleep proceed. Two consequences are
  user-visible and accepted: a request that starts in the control plane's drain→sleep window now
  turns a previously "successful" sleep into a 409 → instance ERROR (a loud failure instead of
  destroyed generations; no CP-side drain retry is in scope), and a scrape that returns 200 with
  an unrecognized body now behaves like a failed scrape — the control plane drains until
  `sleepTimeoutMs` expires and the sleep then fails with a 504, landing the instance in ERROR.
  **Release gate:** capture a live vLLM 0.26 `/metrics` body on a GPU runner and confirm the
  parser's shape assumptions before relying on the drain behaviour in production.

- **Dev worker: a runner that accepts the `/health` connection but never answers can no longer
  hang the serialized cold-start chain (issue #243).**
  `defaultHealthCheck` now forwards an `AbortSignal` into its `fetch`, and `waitUntilHealthy`
  races every probe against an abortable per-probe timer (`healthProbeTimeoutMs`, default 5 s on
  the launcher config — no new `SARDEENZ_*` env var) before treating it as a null (not-yet)
  result, so a wedged probe can never exceed the budget and the 15-minute health deadline keeps
  being re-evaluated (deadline granularity degrades to ≤ `healthProbeTimeoutMs` +
  `healthIntervalMs`, ~6 s — immaterial at 15 minutes). A `hasExited()` re-check after each null
  probe fails fast on an exit observed while a probe was wedged. Previously the first hung probe
  bypassed both the exit check and the deadline forever, and with `serializeColdStarts = true`
  one wedged start blocked every subsequent launch on the worker.
- **Dev worker: `startRunner` reserves the instance slot before its first await, the fire-and-
  forget memory-report push no longer risks an `unhandledRejection`, and multi-device
  start/stop/exit pushes one coalesced memory report per tick (issue #257).**
  The "reserve up-front" comment was not true: the `has()` conflict check was followed by the
  awaited port allocation before the slot was written, so two concurrent `POST /runners` calls
  for one `instanceId` both passed, both launched, and the second overwrote the first — leaking
  its record, ports and ledger memory. The reservation (and the model-set registration) now
  happens synchronously before `allocatePorts()`, inside a `try` extended to cover the
  allocation phase, so a port-allocation failure rolls the just-reserved slot back instead of
  stranding the `instanceId` behind a permanent `ConflictError`; the catch's `usedPorts` delete
  is guarded on nullable pre-declared port bindings so it cannot mask the original error.
  `allocateMemory`/`freeMemory` are ledger-only now; the publish moved to a new
  `WorkerRegistration.pushMemoryReportOnce()` — a microtask-coalesced (never a timer, keeping
  the staleness-check freshness) single push per tick with a logged `.catch` instead of an
  unhandled rejection. A tensor-parallel start across N devices builds and pushes one report
  carrying the final ledger state (per-device `floor(requiredMemory / devices.length)`
  arithmetic unchanged) instead of N near-identical reports.
- **Fail-closed token gate rejects whitespace-only tokens (issue #268).** The #234 startup
  checks used plain truthiness, so `SARDEENZ_API_TOKEN=" "` (a Secret created with a blank
  value) booted a service whose bearer auth was effectively a one-character guess. Both gates —
  the control plane's `SARDEENZ_API_TOKEN`/`SARDEENZ_WORKER_TOKEN` pair and the dev worker's
  `SARDEENZ_WORKER_TOKEN` — now test `token.trim()`. The stored value is deliberately not
  trimmed, so a token configured with surrounding whitespace keeps matching byte-for-byte.

- **Dashboard: models placement — single model list per GPU card.** The card previously
  listed every model twice: once as the legend chips under the stacked bar, again as the
  per-model action rows. The legend chips row is removed; the action-row list is the single
  list and renders for every user (the sleep/wake/move/stop dropdown is admin-only). "Other"
  and "Free" ride at the bottom of that list as legend rows without a kebab, styled like the
  model rows. The now-unused `legend.segments`/`legend.viewModel` i18n keys are dropped.

- **MLServer SIF: ONNX models silently ran on CPU.** The `1.7.1-rc3` image installed the
  `nvidia-*-cu12` wheels for `onnxruntime-gpu`, but RHEL-family Python places those pure wheels
  under `/usr/local/lib/...` while `onnxruntime-gpu` sits under `/usr/local/lib64/...`, so
  `onnxruntime.preload_dlls` never found `libcudnn.so.9` and the CUDA provider degraded to CPU
  (0 B measured VRAM). The Containerfile now puts the cu12 `lib/` directories on
  `LD_LIBRARY_PATH`, `dlopen()`s every CUDA/cuDNN library at build time (the previous
  `preload_dlls` check only printed), and pins `torch==2.10.0` — the last CUDA 12 torch — since an
  unpinned torch pulled `nvidia-cudnn-cu13`, whose files clobber the cu12 cuDNN. Verified
  on-cluster: an ONNX model now loads with `CUDAExecutionProvider` and reports measured VRAM.
- **Dashboard: Models placement panel redesigned (#163 round two).** Worker cards now sit side
  by side in a responsive grid instead of one full-width collapsible section per worker — with
  one GPU per worker, the old layout left most of each row empty. The per-card model legend
  collapses into hover tooltips and model rows become one-line chips, cutting ~80px per card.
  A header toggle switches between the card view (default) and a compact one-row-per-worker
  view (~48px/worker, aggregate sleep-all/wake-all/stop-all kebab); the choice persists in
  localStorage. Models sort by measured size, largest first.
- **Dashboard: Models placement tooltips — model name only, no instance id (#206).** The card
  view's stacked bar now uses a custom tooltip that strips the `#instanceId` suffix from the
  nivo segment key, so hovering a colored segment shows the model name and measured bytes only.
  The compact view's inline bar gains the same hover tooltip as the cards: every model with its
  color, sleeping moon and bytes, plus Other/Free when present. Compact segments carry the
  served display name (`WorkerModelInfo.displayName`) instead of the raw model key.
- **CI: PRs run quality gates only; merges to dev publish impacted images.** PR CI
  (`ci.yml`) now runs typecheck/lint/tests/e2e without building container images. A new
  `publish-images.yml` runs on every merge to `dev`: it maps the merge's changed paths to the
  platform images they impact (`proxy/` → proxy; `control-plane/`, `dashboard/`, and their
  container dirs → their images; `packages/**` and root manifests → both service images;
  `containers/worker-base|worker/` → the digest-paired worker images), builds only those,
  tags them with the merge commit's short sha (`git log --oneline` form), and pushes to
  `quay.io/rh-aiservices-bu`. Worker always builds FROM the worker-base digest built in the
  same run (or the last published one for worker-only changes). Docs/CI-only merges publish
  nothing. The manual multi-image `publish-platform-images.yml` stays for explicit republishes.
  Fix: the first `publish-images.yml` runs failed at validation because `jobs.<job_id>.if`
  cannot reference the `matrix` context (github, needs, vars, inputs only); the build decision
  now gates each step's `if`, where `matrix` IS available.
- **MLServer runner draining stalls (#206):** the MLServer shim omitted `activeRequests` from
  `/health`, so the control plane's drain loop could never observe drain completion and every
  stop/sleep of an MLServer model burned the full sleep timeout (300s default) before timing out.
  The shim now scrapes MLServer's metrics listener for the REST server's
  `rest_server_requests_in_progress` gauge and reports it as `activeRequests` (unknown/omitted
  only when the scrape fails, never a fake 0), matching the vLLM shim's behavior.

### Fixed

- **Models placement legend tooltip (cards view).** Hovering the model legend showed the raw
  i18n key `overview.modelsPlacement.legend.segments` as its title: `cluster.json` carried two
  duplicate `"legend"` blocks and JSON parsing keeps the last duplicate, which lacked the
  `"segments"` entry. The duplicate block is removed (the survivor keeps all keys). The tooltip
  is also anchored per legend chip now — one Tooltip per chip/Other/Free entry — so the full
  VRAM breakdown appears right above the hovered chip, matching the stacked-bar tooltip
  behavior, instead of top-center of the legend row.

- **Runner shims: `/memory-report` reports the whole-device used memory with a machine-readable
  scope (issue #244).**
  The shim process never allocates CUDA memory through torch's caching allocator (the engine is a
  child subprocess), so `torch.cuda.memory_reserved()` was effectively always 0 and the
  "prefer this process's reserved pool" branch was dead by construction in the two-process
  topology — the figure was silently the whole-device read, double-counting co-located runners.
  The dead branch is deleted; both shims report `max(0, total − free)` from `mem_get_info` with
  the new optional `attribution: "runner" | "device"` field on `DeviceMemoryUsage`
  (engine-runner contract), emitting `"device"`. The runner-stub emits `"runner"` for its
  own-ledger figure. No in-repo consumer reads `attribution` yet — an absent value means unknown
  scope (legacy images), and the per-runner display rule it enables belongs to Phase 5; the
  worker's NVML path remains the process-attributed authority and is unchanged.

- **Runner shims: blocking torch/kvcached memory reads move off the event loop (issue #253).**
  Both shims' `GET /memory-report` and `POST /sleep` handlers called the synchronous
  `memory_report()` inline from `async` code, so a slow `torch.cuda.mem_get_info` query under
  device contention, or a contended kvcached shared-memory
  `flock`, froze the event loop — stalling `/health` for the launcher probe and the shim's own
  liveness poller (a stalled shim could read as wedged and trip restart logic). The four call
  sites now hand it to the default executor —
  `await loop.run_in_executor(None, functools.partial(memory_report, args.device_type))` — the
  same pattern as the ONNX `session.run` offload. `memory_report` itself stays synchronous and is still
  called exactly once per request; the 409 paths, response shapes and `deviceMemoryFreedBytes`
  value are unchanged. The shims' app-level test coverage is also tightened (`tests/test_app.py`:
  the real `create_app` over the conformance doubles, `httpx.ASGITransport` on the test's own
  loop, no new dependency). Both shims already had app-level coverage — `runners/conformance/`
  builds each real `create_app` over the same doubles under `TestClient` — so what is new is
  narrower and stated as such: `ASGITransport` runs the loop on the test's own thread, where
  `TestClient`'s anyio portal thread hides it, making the executing thread observable for the
  first time; vLLM's `test_core.py` has driven the guards through `TestClient` since #239. The harness pins the off-loop thread
  identity, the single `/sleep` read, and `/health` staying responsive behind a 150 ms report
  read.

- **Per-model VRAM display no longer double-counts device-scope memory under co-location
  (issue #278 — closes the #244 residual).** `attribution` (M17, ADR-027) gains its first
  executable consumers, and none of them sums a device-scope memory row into a per-instance
  figure. The worker-agent contract's `InstanceMemoryMeasurement` gains the same optional
  `attribution: "runner" | "device"` field the engine-runner contract has had since M17, so a
  per-instance row can state its own scope; the worker's no-NVML ledger path
  (`getLedgerInstanceShares`) promotes a whole-device figure into an instance row only while its
  runner is the device's sole record and drops it once anything co-resident claims the device
  (residency decided from runner records, never bytes — a sleeping co-tenant still blocks
  promotion), and NVML rows are stamped `"runner"` at report assembly. The control plane
  scope-checks every per-instance summation site through one shared helper
  (`sumInstanceMeasurementsByInstance`): `runner`-scope rows sum; a `device`- or unknown-scope
  row is kept only while it is its device's sole >0-byte row, else dropped — so the two route
  loops (`/api/v1/cluster/memory`, `/api/v1/workers/:workerId`) and `getMeasuredByInstance`
  (which feeds the models routes' `currentMemory`) emit figures that can never double-count, and
  a malformed `attribution` drops the field (row kept, treated unknown → device-conservative)
  instead of rejecting the report, and the worker clamps a malformed runner-supplied
  `attribution` to absent so its outbound report stays schema-valid. The dashboard renders the
  already-deduped figures: dropped
  bytes surface in "Other", whose clamp keeps the bar honest. User-visible effect: two
  co-located models on a worker without NVML used to render two ~whole-device bars on one card
  (e.g. 20 GB of "model" on a 16 GB GPU with Other clamped to 0); the shared device now shows
  only the genuinely per-runner figures plus the residual in "Other". Legacy workers that do not
  label a scope lose per-model display for unlabeled co-located rows until they upgrade (the
  conservative direction); unlabeled sole-resident rows keep displaying.

## [0.2.0] - 2026-09-15

First release of Sardeenz v2, the production-grade successor to the
[v1 prototype](https://github.com/rh-aiservices-bu/sardeenz). This section summarizes what the
platform delivers as of this release; the per-change history that accumulated during
development (Phases 0-4 and milestones M1-M14) is preserved in the git history of this file.

### Platform

- **Four decoupled components talking only through OpenAPI contracts** (ADR-002, ADR-005):
  a Rust routing proxy, a TypeScript control plane (Fastify, PostgreSQL, Redis/Valkey), a React +
  PatternFly 6 admin dashboard with a Fastify BFF, and engine runners. TypeScript types are
  generated from the specs in `packages/contracts/`; Rust types are hand-maintained.
- **Application-layer VRAM multiplexing.** Models are logical configurations with one or more
  instances (ADR-019); the control plane places them on workers and GPUs, sleeps idle models,
  wakes them on demand, and evicts to make room. Configuration name, served model name, and
  display name are distinct (ADR-020).
- **Measured-only GPU memory doctrine.** Every memory figure shown to users comes from NVML
  telemetry; `requiredMemory` is a placement input, never a user-facing "reserved" figure.
  kvcached pool statistics (prealloc / used / free) are reported end to end.

### Routing proxy

- OpenAI-compatible and Open Inference Protocol traffic on separate path families (`/openai`,
  `/oip`, ADR-021), weighted round-robin across instances with per-endpoint circuit breakers.
- **Wake-on-request parking.** Requests for a sleeping model are parked, a wake is triggered, and
  the request is forwarded once the model is ready; parked herds fail fast on wake rollback and
  never suppress the next wake trigger.
- Live routing map from Redis pub/sub with reconnect and backoff; request-ID tracing; hop-by-hop
  header filtering; configurable body cap, parking byte budget, forwarding concurrency limits, and
  upstream timeout.
- Prometheus metrics on a separate admin port: request counts and latency histograms, active and
  parked connections, parking duration, wake triggers, circuit-breaker state.

### Control plane

- Model lifecycle API: deploy, sleep, wake, stop, start, delete, and force-delete for stalled
  configurations; in-progress deployments can be cancelled; stopped configurations can be
  modified in place.
- **Resumable move-model operation** across workers and GPUs with weight-zero cutover, resumed
  after leader changes.
- Placement pipeline with capability filtering, VRAM budgeting with in-flight reservations, LRU
  eviction wired into deploy and wake, and a reconciliation loop that repairs ghost instances after
  worker restarts.
- Kubernetes Lease-based leader election; atomic Redis state transitions via Lua scripts;
  PostgreSQL migrations at startup.
- Durable, instance-scoped startup logs replayable from the dashboard.
- Runner catalog: digest-pinned ORAS imports of official runner SIFs with byte-accurate
  verification, digest-drift detection, and optional Apptainer signature checks.
- Server-sent events for model, worker, and memory changes; Prometheus metrics for models,
  workers, device memory, state transitions, evictions, and operation durations.

### Admin dashboard

- Cluster overview with a GPU placement board, per-GPU stacked per-model VRAM bars, and the
  cluster inference URL; model list with sorting, multi-instance worker links, and runner
  identification; model detail with startup-log replay; worker pages.
- Deploy form driven by live worker capabilities, with runtime-module (SIF) selection and a
  weights folder picker; compact per-model action menus (sleep, wake, move, stop) on GPU cards.
- **Chatbot Playground** built on `@patternfly/chatbot`: model sidebar grouped by GPU, session
  tabs, single / split / 2x2 layouts, streaming and non-streaming turns, latency / TTFT / tok/s
  per reply, persisted layout and sessions, and a per-user inference concurrency cap.
- **Metrics page** backed by Prometheus: request latency and throughput, active and parked
  connections, parking duration, wake triggers, state transitions, evictions, memory over time,
  and average operation durations, with preset and custom time ranges and auto-refresh. Works
  against OpenShift user-workload monitoring out of the box (Thanos Querier tenancy port with
  ServiceAccount token, service CA, and namespace tenancy).
- Notification drawer fed by SSE with degraded polling fallback; Redis fallback for all read
  routes when the control plane is unavailable.
- Authentication modes `none`, `simple`, and OpenShift OAuth with namespace-scoped
  `sardeenz-admin` / `sardeenz-admin-readonly` marker Roles; read-only users get a read-only UI.
- Accessibility audit fixes, i18n infrastructure, and a Playwright e2e suite against mock
  services, enforced in CI.

### Engine runners

- **Apptainer SIF runtime** (ADR-015 to ADR-018): engine images are converted to SIF files on a
  shared volume and executed by a slim worker image; official SIFs are distributed via ORAS from
  the `runners.yaml` catalog.
- Worker agent with NVML GPU detection, per-runner port blocks, runner lifecycle management with
  log streaming, multiple runner families per worker, and heartbeat memory reports.
- **vLLM runner shim** (vLLM 0.21 and 0.24 images, kvcached-enabled) and **MLServer runner
  shim** (MLServer 1.7.1) implementing the engine-runner contract: health, memory report, sleep
  and wake, and engine-parameter passthrough. A shared conformance suite runs against both.
- Runner container definitions organized by engine and exact upstream version under
  `containers/runners/<engine>/<version>/`.

### Deployment and operations

- Kustomize bases for the control plane, proxy, dashboard, worker (SCC, RBAC, PVCs, NetworkPolicy,
  PVC write protection), PoC PostgreSQL and Valkey backing services, OpenShift monitoring
  (ServiceMonitors, service-CA ConfigMap, metrics-reader Role), and a parameterized Librarian Job
  that builds, converts, and publishes runner SIFs on OpenShift.
- Canonical Quay repository layout and a manual GitHub workflow that builds and pushes all
  platform images.
- Defense in depth: bearer-token authentication on the control plane and worker agent, allow-list
  NetworkPolicies per flow, restrictive BFF security headers, proxy-aware rate limiting, SIF
  supply-chain checks, and secrets sourced from environment variables (ADR-013). Operator guides
  cover deployment security, OpenShift OAuth RBAC, MLServer model layouts, and the runner catalog.

### Development

- npm workspaces monorepo with a Makefile front door; `make lint typecheck test` gate; Podman
  Compose dev services; logged dev servers; integration tests on a dedicated `_test` database.
- CI: quality (lint, typecheck, unit and integration tests), dashboard e2e, Python runner and
  conformance suites, and service container build and smoke tests on every pull request.
- Architecture overview, 21 ADRs, per-component specs, and per-component `AGENTS.md` guides for
  AI-assisted development.
- Published documentation site (mkdocs-material, GitHub Pages) built from `docs/` by a
  `deploy-docs` workflow. Application docs only: project planning and ADRs stay in the repo, and
  links to them or to source files are rewritten to GitHub URLs at build time so
  `mkdocs build --strict` validates in-site links. Includes an interactive Architecture Flow
  Visualizer (`docs/architecture-visualizer.html`) animating eight flows: cluster bootstrap, model
  deployment, inference hot path, park-and-wake, LRU eviction, instance move, control plane
  failover, and runner catalog import.

### Notable fixes folded into this release

Development surfaced and fixed a long tail of correctness issues before release, including:
runner processes not terminated on delete, stop, or eviction; VRAM reservations cleared
prematurely or leaked; move and delete races; parked-connection and circuit-breaker leaks in the
proxy; routing entries corrupted on sleep; integration tests wiping the dev database; MLServer
failing on read-only images; OAuth identity and RBAC lookups on OpenShift; and proxy histograms
rendered as summaries, which left latency panels empty; sidebar GitHub star and fork counts
blocked by the Content Security Policy in production (now proxied through a cached BFF route);
and a flaky dashboard e2e accessibility test whose readiness check matched both the sidebar nav
link and the Workers summary card.
