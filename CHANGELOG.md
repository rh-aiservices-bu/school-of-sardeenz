# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- **Capability contract hardening.** `kvCacheElasticSharing` is now a first-class boolean on
  `RunnerCapabilities` and `WorkerCapability` (was a `features` map key) — the control plane's
  future oversubscription placement policy keys on this field directly. `WorkerCapability` gained
  `engineVersion`, `maxTensorParallelism`, and a passthrough `features` map, and its
  `supportedModelTypes`/`supportedDeviceTypes`/`supportedSleepLevels` now `$ref` the shared
  `engine-runner.yaml` enums instead of plain strings, closing a type gap at the worker/control-plane
  boundary. `CatalogEntry` gained the same optional capability fields so `runners.yaml` can advertise
  them; the dev-worker reads them from `SARDEENZ_RUNNER_CATALOG_URL` at startup and registers with
  catalog-sourced capabilities instead of hardcoded values. (#15)
- **Dev/deploy hardening.** The dev-worker's `ApptainerLauncher` now strips `APPTAINERENV_*` and
  `SINGULARITYENV_*` keys from the spawned process env before `apptainer exec` — Apptainer injects
  these into the guest regardless of `--cleanenv`, so a value set in the worker process's
  environment could otherwise leak into the engine container. `compose.yaml` now binds the dev
  Redis and Postgres ports to `127.0.0.1` instead of all interfaces. `containers/control-plane/` and
  `containers/dashboard/` `.dockerignore` now exclude `.env*` (except `.env.example`), `logs`,
  `weights`, `modules`, and `scratch` from build contexts. (#119)
- **Proxy forwarding concurrency limits.** New `SARDEENZ_PROXY_MAX_CONCURRENT_FORWARDS` (global) and
  `SARDEENZ_PROXY_MAX_CONCURRENT_PER_MODEL` (per-model) env vars cap in-flight *forwarded* requests,
  returning `503 overloaded` once reached (both default to `0`/unlimited). The permit is acquired
  after parking resolves and before endpoint selection — a parked request never holds one, so a
  sleep/wake pile-up cannot exhaust the limit and deadlock the proxy. Documents ingress-level rate
  limiting and per-tenant quotas as mandatory, ingress-owned deployment requirements the proxy
  itself does not and cannot enforce. (#19)
- **Proxy configurable body cap and parking byte budget.** Parked requests hold their fully-buffered
  body in memory for the duration of the park, so an unbounded body size combined with many parked
  connections could exhaust proxy memory. The hardcoded 10 MiB request-body cap is now configurable
  via `SARDEENZ_PROXY_MAX_BODY_BYTES` (default `1048576`, i.e. 1 MiB), enforced both at the `axum`
  body-buffering step and via a `tower_http::limit::RequestBodyLimitLayer` on the inference router.
  `ParkingManager` now also tracks the total bytes currently parked and rejects new parks once a
  configurable budget (`SARDEENZ_PARKING_MAX_BYTES`, default `1073741824`, i.e. 1 GiB) would be
  exceeded, returning `503 parking_limit_reached` alongside the existing per-model/global count
  limits. (#95)
- **Dashboard BFF security headers.** The BFF now registers `@fastify/helmet` with a restrictive
  Content-Security-Policy (`default-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`, no
  inline scripts) plus helmet's other default hardening headers. Removed the dead `corsOrigin`
  config field and `SARDEENZ_CORS_ORIGIN` env var — the BFF only ever served same-origin, so no
  `@fastify/cors` registration ever consumed it. (#104)
- **Worker agent authentication + NetworkPolicy.** Mirrors the control-plane pattern (#88) for the
  worker agent: an optional shared-secret `SARDEENZ_WORKER_TOKEN` gates every dev-worker route
  except `/healthz` (checked with `timingSafeEqual`), logging a startup warning when left unset.
  The control plane's `WorkerClient` reads the same env var and attaches the `Authorization:
  Bearer <token>` header on `startRunner`, `stopRunner`, and both SSE log-stream methods. Adds
  `deployment/sif-runner/networkpolicy.yaml`, restricting ingress to the worker Service to the
  control-plane pod on port 9100. Documented in `docs/usage/deployment-security.md`. (#108)
- **Control plane API authentication + NetworkPolicy.** The control plane now supports an optional
  shared-secret `SARDEENZ_API_TOKEN`: when set, every `/api/v1/*` request must carry a matching
  `Authorization: Bearer <token>` header (checked with `timingSafeEqual`, `/healthz`/`/readyz`
  exempt), and a startup warning is logged when it is left unset. The proxy's wake-trigger client
  and the dashboard BFF's control-plane client both read the same env var and attach the header
  automatically. Documents the `401 UNAUTHORIZED` response on every `/api/v1/*` operation in the
  OpenAPI contract. Adds `deployment/control-plane/networkpolicy.yaml`, restricting ingress to the
  control-plane Service to the proxy and dashboard pods on port 3000 — defense in depth alongside
  the token, per `docs/usage/deployment-security.md`. (#88)
- **SIF supply-chain hardening.** `scripts/build-sif.sh` now refuses to build a SIF unless
  `--image` is pinned to a `@sha256:<digest>` (a mutable tag could be repointed after review,
  silently changing what gets signed and published). The runner catalog (`CatalogService`) applies
  the same digest requirement to `oras://` image refs — entries without a digest are skipped
  (logged) rather than imported — and now refuses to fetch a remote catalog over plaintext
  `http://` unless the operator opts in via the new `SARDEENZ_ALLOW_INSECURE_CATALOG` env var.
  `containers/control-plane/Dockerfile` verifies the Apptainer `.deb`'s sha256
  (`APPTAINER_DEB_SHA256`) before installing it. `runners.yaml` and the librarian
  `deployment/librarian/job.yaml` example are updated to show digest-pinned refs. (#115)
- **CI workflow (GitHub Actions).** A `quality` job (`.github/workflows/ci.yml`) runs on pull
  requests to `dev`/`main` and pushes to both, enforcing every gate that previously ran only
  manually: `make all` (typecheck + ESLint + clippy + Redocly spec validation), `make test`
  (vitest + `cargo test`), and a contract-codegen drift gate (`npm run codegen -w @sardeenz/types`
  then `git diff --exit-code packages/types/src/generated/`). Rust is installed explicitly with an
  "assert Rust steps actually ran" check so the Makefile's `ifdef CARGO` guards cannot silently
  degrade CI to the TypeScript half. Playwright e2e (pending #102), `format-check` (Prettier
  backlog), and integration tests (service containers) are deliberately deferred — documented in
  the workflow. (#82)
- **`/implement-milestone` skill.** Project skill (`.claude/skills/implement-milestone/`) that
  executes a GitHub milestone (M1–M9) issue by issue: an Opus session orchestrates; Opus subagents
  plan, blueprint, review, verify, and accept; Sonnet subagents implement. Each issue runs in an
  isolated worktree off a `milestone-M<N>` branch, treats decision/implementation-guidance comments
  as the authoritative spec, enforces the ADR-005 contract flow, and leaves push/PR/close decisions
  to the user.
- **Real-time model-launch log streaming.** Deploying a model now opens a modal that streams the
  runner's live stdout/stderr over SSE (real vLLM output in production, realistic simulated lines in
  dev-worker stub mode), and flips to success (auto-closing) or failure as the model reaches
  `ACTIVE`/`ERROR`. The same modal is reachable as a "View logs" action on the model detail page.
  Previously a launch showed only a "Starting" label with no visibility into what the runner was
  doing. Data flows over a new HTTP streaming chain: the worker agent captures each runner's output
  into a per-runner ring buffer and exposes `GET /runners/{runnerId}/logs` (SSE); the control plane
  resolves the model's worker/runner and stream-proxies it at `GET /api/v1/models/{modelName}/logs`,
  holding the connection open and emitting keepalives while an async deploy places the runner; the
  dashboard BFF stream-proxies it at `GET /api/models/{name}/logs` (admin-readonly, cookie auth); and
  the frontend consumes it via a transient per-model `useModelLogs` EventSource hook rendered in a
  `LogViewer`. Because a worker's `POST /runners` blocks until the runner is healthy, the control
  plane never learns the `runnerId` in time to watch a cold-start; logs are therefore addressed by
  **model name** (`GET /runners/by-model/{modelName}/logs`), which the worker can resolve the instant
  the start command arrives, so vLLM's weight-loading/startup output (and any failure) streams live
  throughout cold-start. The worker also logs start-command receipt, the resolved `apptainer exec`
  command + SIF path, and launcher failures (previously it logged nothing until success). Contracts
  add the `RunnerLogLine` schema and the streaming endpoints. The dev-worker stub emits vLLM-style log
  lines as it walks its simulated startup phases, so the feature is fully exercisable in containerless
  local dev. Control-endpoint poll spam (the engine's `"GET /health"`/`/progress`/… access-log lines,
  emitted once per control-plane poll) is filtered out at capture so it never clutters the stream.
  Deploy/health timeouts default to **15 min** (`SARDEENZ_DEPLOY_TIMEOUT_SECS`,
  `SARDEENZ_HEALTH_TIMEOUT_MS`) and the control plane's `startRunner` call no longer aborts at 60 s —
  a model that takes minutes to load its weights is no longer marked failed (leaving an orphaned
  runner) while it's still loading. Conversely, a runner that reports a terminal `ERROR` state (e.g.
  vLLM fails to load the model / CUDA OOM) now fails the launch **immediately** — with the runner's
  error message — instead of polling until the 15-min timeout.
- **Model-path folder picker on the Deploy Model form.** A new "Browse" button opens a modal that
  navigates the shared model-weights directory (`SARDEENZ_WEIGHTS_DIR`) one level at a time, with a
  breadcrumb and folders that look like a model (they contain `config.json`, `*.safetensors`,
  `*.gguf`, etc.) flagged and directly selectable. Backed by a new read-only control-plane endpoint
  `GET /api/v1/weights?path=<relative>` (`WeightsBrowserService`, path-traversal-guarded) proxied by
  the BFF at `GET /api/weights` (`admin-readonly`). The control plane now reads `SARDEENZ_WEIGHTS_DIR`
  (default `/weights`) and must have that directory mounted to browse it. Contracts add the
  `WeightsListing` / `WeightsEntry` schemas.

### Changed

- **CI workflow hardening.** The GitHub Actions workflow now declares explicit least-privilege
  `permissions: { contents: read }`, all four third-party actions are SHA-pinned (not tag-pinned)
  to prevent supply-chain tag-mutation attacks, and the Rust-assert step's rationale comment no
  longer hard-codes Makefile line numbers that drift on every edit. (#127)

### Removed

- **Consumer-less `GET /api/v1/events` SSE route.** The control plane's cluster-events SSE endpoint
  had no consumer anywhere in the repo (the dashboard BFF has its own separate `/api/events` SSE
  route) and leaked a Redis subscriber connection per request that outlived client disconnects on
  some code paths. Rather than fix the leak in dead code, the route, its handler
  (`control-plane/src/routes/events.ts`), and the `/api/v1/events` path and `Events` tag in the
  OpenAPI contract are deleted. `ClusterEvent`/`ClusterEventType`/`RunnerLogLine` schemas are
  unaffected — they're still used by model-logs, the BFF's events route, and the catalog event
  emitter. (#90)

### Fixed

- **Dashboard low-severity hardening bundle: SSE write-after-end race, credential-length leak,
  auto-logout timer races, and untranslated strings.** The BFF's `/api/events` route now guards
  every `reply.raw.write()` call (message handler and ping timer) with `writableEnded` before
  writing, matching the existing `model-logs.ts` pattern, so a client disconnect racing an in-flight
  Redis pub/sub message or ping tick can no longer throw. `safeCompare` in `auth.ts` now hashes both
  inputs with SHA-256 before `timingSafeEqual` instead of branching on buffer length, removing the
  side channel that leaked the configured username/password length. `AuthContext`'s
  `scheduleAutoLogout` now clears any existing timer before scheduling a new one and unmounts
  cleanly, preventing two auto-logout timers from racing after a token refresh. `formatRelativeTime`
  now uses `Intl.RelativeTimeFormat` instead of hardcoded English strings, and the `App.tsx` 404
  page, error boundary, and loading spinners now pull their copy from the `common` i18n namespace
  instead of inline English literals. (#107)
- **Dashboard BFF was not proxy-aware: rate limiter collapsed behind a shared proxy IP, OAuth
  `redirect_uri` trusted spoofable request headers, and OAuth env vars weren't validated at
  startup.** Fastify now runs with `trustProxy: true` so `request.ip`/`protocol`/`hostname` reflect
  `X-Forwarded-*` headers from a trusted reverse proxy/ingress instead of always resolving to the
  proxy's own address. The login rate limiter keys on `${ip}:${username}` instead of `ip` alone (so
  one bad actor behind a shared NAT/proxy IP can no longer lock out every other user sharing it) and
  clears its bucket on a successful login. The OAuth `redirect_uri` (authorize + token exchange) and
  the SSE cookie's `Secure` flag are now derived from a new `SARDEENZ_PUBLIC_URL` config value
  instead of the request's `protocol`/`hostname`, which are otherwise attacker-controllable unless
  the fronting proxy is trusted to strip client-supplied forwarded headers. `validateAuthConfig` now
  fails startup when `AUTH_MODE=oauth` and any of `OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET`,
  `OAUTH_ISSUER_URL`, or `SARDEENZ_PUBLIC_URL` is empty. Documented in
  `docs/usage/deployment-security.md`. (#105)
- **Dashboard BFF: read-only role could delete notification state.** Both `DELETE /api/notifications/:id`
  and `DELETE /api/notifications` were gated at `admin-readonly` instead of `admin`, so any
  authenticated user (the default OAuth role) could wipe notification history. Fixed to require
  `admin`. Mark-as-read routes stay `admin-readonly` (non-destructive). (#103)
- **Proxy: wake-trigger transport errors leaked the control-plane URL to clients.** The non-2xx
  response path was already masked (#93), but a transport-level failure (connection refused, DNS
  failure, timeout) reaching the control plane still propagated reqwest's raw error — which embeds
  the request URL, e.g. `error sending request for url (http://127.0.0.1:.../api/v1/wake)` — into
  the client-facing `model_unavailable` error message. `WakeTriggerClient::trigger_wake` now maps
  the transport error to a generic `"wake trigger transport error"` message and logs the original
  error server-side via `tracing::warn!`. (#97)
- **Module-store write-protection VAP matched the wrong identity.** The `matchConditions` in the
  ValidatingAdmissionPolicy compared `request.userInfo.username`, which is the controller manager
  for Pods created by Jobs/Deployments — not the workload SA. Both exemptions were dead: the policy
  blocked the librarian and control-plane writers it was meant to allow. Fixed to check
  `object.spec.serviceAccountName` instead. Also added `pods/ephemeralcontainers` to the resource
  rules so `kubectl debug` ephemeral containers are validated too. (#110)
- **Dashboard: launch-log SSE stream 401'd whenever auth was enabled.** The `sardeenz_sse` cookie
  set on login/OAuth-callback was scoped to `Path=/api/events`, so `EventSource` connections to
  `GET /api/models/:name/logs` (the model launch-log stream) never sent it, forcing a hard 401 in
  any deployment with `AUTH_MODE=simple`/`oauth`. The cookie path is now `/api` — still narrower
  than the whole origin, but wide enough to cover every cookie-authenticated SSE endpoint.
  `useModelLogs` also now surfaces a `failed` state (instead of retrying forever) once reconnects
  hit the same failure threshold as the app-wide event stream, and `LogViewer` renders a red
  "unavailable" label in that case. (#101)
- **Dev worker: runner ports were allocated monotonically and never reclaimed.** `RunnerManager`
  tracked ports with an ever-incrementing counter, so a long-lived worker cycling models through
  start/stop (or crash/restart) would eventually walk past `runnerPortStart + <range>` and hand out
  an out-of-range port. Port allocation now scans a bounded range
  (`[runnerPortStart, runnerPortStart + maxRunners * 2)`, new `SARDEENZ_MAX_RUNNERS` config,
  default 32) for the lowest free `(management, engine)` pair, tracked in a `usedPorts` set that's
  released on `stopRunner()`, on unexpected-exit cleanup, and when a launch fails — so a stopped or
  crashed runner's ports are reused by the next start instead of leaking. The scan also skips
  `config.workerPort` so a runner can never collide with the worker's own listener, and an injectable
  `probePortAvailable` (real TCP bind check in production, `undefined` in tests) double-checks a
  candidate pair is actually free before handing it out. Range exhaustion now throws a clear error
  naming the configured range instead of silently returning an out-of-range port. (#114)
- **Worker Deployment: signing-key import silently no-oped, no liveness/readiness probes, and the
  heartbeat kept advertising a wedged worker.** (#118)
- **`modelPath` was never validated against the weights root.** A deploy request could point
  `modelPath` anywhere on the control plane's filesystem (`../../etc`, a relative path, or a
  string that merely shared a prefix with the weights dir, e.g. `/weights-evil`), and the worker
  agent's `ApptainerLauncher` would `--bind`/exec it as-is. `POST /api/v1/models` now rejects any
  `modelPath` that doesn't resolve to a path strictly inside `config.weightsDir`, via a shared
  `isContainedIn` helper (`control-plane/src/utils/path-containment.ts`, also now used by
  `WeightsBrowserService`). The worker agent adds its own independent check — `ApptainerLauncher`
  rejects non-absolute paths, syntactic escapes, and (via `fs.realpath`) a symlink planted inside
  the weights dir that resolves back outside it — since it cannot assume every request reaching it
  passed through the control-plane check. (#113)
  - `deployment/sif-runner/worker-deployment.yaml`'s entrypoint imported the SIF signing public key
    with `|| true`, so a missing/invalid ConfigMap left the keyring empty and the worker started
    anyway with `apptainer verify` silently unable to trust anything. The script now checks
    `apptainer key list` after import when `SARDEENZ_VERIFY_SIF` is true (the default) and exits 1
    with a clear error if the keyring is empty, instead of serving unverifiable SIFs.
  - The Deployment had no liveness/readiness/startup probes, so Kubernetes had no way to detect a
    wedged worker or hold traffic until it was ready. Added a `management` container port (9100)
    plus `startupProbe`/`livenessProbe`/`readinessProbe` against `GET /healthz`.
  - `WorkerRegistration.startHeartbeat()` refreshed the Redis heartbeat key unconditionally on a
    timer, so a hung worker (event loop blocked, health endpoint unresponsive) kept looking alive to
    the control plane indefinitely. The heartbeat write is now gated on a successful `GET /healthz`
    (skipped on non-200 or a fetch failure) and sets the key with a TTL
    (`redis.set(key, value, 'PX', heartbeatIntervalMs * 4)`) so a worker that stops refreshing
    expires instead of lingering forever.
- **Dev worker: signal-killed runners were never reaped, and a runner exiting on its own after
  startup left a phantom VRAM reservation.** (#109)
  - `ApptainerLauncher.stopChild()` treated `exitCode !== null` as the only "already exited"
    signal, so a child killed by a signal (`exitCode` stays `null`, `signalCode` set instead — e.g.
    an OOM-kill) was never recognized as dead: `stop()` would still send `SIGTERM`/`SIGKILL` to an
    already-gone process and, if the fake/real child never emitted a further `exit` event, hang
    forever. `stopChild()` now takes a `hasExited()` predicate (backed by the launcher's own
    `exit`/`error` listener flag, which fires for a signal-killed child too) instead of reading
    `child.exitCode` directly, and a non-`unref()`'d backstop timer (`stopGraceMs + 5s`) guarantees
    `stop()` resolves even if `exit` never fires at all.
  - Runners had no supervision after startup completed: if the underlying process died on its own
    (crash, OOM-kill) rather than via a deliberate `stopRunner()`, its `RunnerRecord` and device
    memory reservation lived on forever. `RunnerLauncher.start()` now accepts an optional `onExit`
    callback, invoked once if the process exits after `start()` has already resolved; both
    `ApptainerLauncher` and `StubLauncher` wire it in. `RunnerManager.startRunner()` passes a
    `handleUnexpectedExit` closure that frees the runner's device memory and removes its record
    (guarded on the record still existing, so it's a no-op during a deliberate `stopRunner()`,
    which now clears the record before calling `handle.stop()`).
- **Dev worker: failed launch leaked log buffers, hung SSE log clients, and discarded failure
  logs.** `startRunner`'s catch block rolled back the reserved model slot but never sealed or
  retained the runner's log stream, so a client attached mid-launch (`GET
  /runners/by-model/{modelName}/logs`) hung forever waiting for an `end` frame, the log buffer and
  its listeners stayed in memory indefinitely since there's no `stopRunner()` call to `drop()`
  them, and the failure logs became unreachable once the model slot was rolled back. `RunnerManager`
  now calls `logBuffer.markEnded(runnerId)` and the new `logBuffer.retain(runnerId)` in the catch
  block; `retain()` schedules an automatic `drop()` after a 5-minute TTL (capped at 20 retained
  buffers, evicting oldest-first) so failure logs stay retrievable via `GET
  /runners/{runnerId}/logs` for a window without leaking forever. The SSE route's `stream()` was
  also hardened: `cleanup()` is now idempotent and closes the response (`reply.raw.end()`) once the
  stream ends, instead of only clearing listeners and leaving the socket open. (#112)
- **Worker `managementUrl` no longer advertises `http://localhost:<port>` in-cluster, and the
  contract now matches the control plane's hard requirement for it.** (#111)
  - The dev-worker agent (both `stub` and `apptainer` launch modes) advertises a configurable
    `advertiseHost` (`SARDEENZ_WORKER_ADVERTISE_HOST`, default `localhost`) instead of a hard-coded
    `localhost`/`127.0.0.1` — a worker deployed via `deployment/sif-runner/` now sets this from
    `status.podIP` so the control plane, running in a different pod, can actually reach it. The
    Apptainer launcher's own `/health` probe is unaffected — it still targets `127.0.0.1` since
    that check runs in-pod.
  - `WorkerInfo.managementUrl` is now `required` in `packages/contracts/specs/worker-agent.yaml`
    (types regenerated), matching the control plane's existing hard requirement. Worker registration
    payloads missing (or with an empty) `managementUrl` are now rejected at discovery
    (`WorkerPoolService.parseWorkerInfo`) instead of silently producing a `null` that later
    surfaced as a 500 at deploy time.
- **`sleepModel` now honors `SARDEENZ_SLEEP_TIMEOUT_SECS` on the runner's `/sleep` call.**
  `RunnerClient.sleep()` previously always used the client's instance-level default (30 s),
  ignoring `SleepWakeService.sleepTimeoutMs` — a model whose offload takes longer than 30 s (e.g.
  large weights being written to host RAM) would have its `/sleep` request aborted mid-offload
  even though the configured sleep timeout was higher. `RunnerClient.post()`/`sleep()` now accept
  an optional per-call `timeoutMs` (falling back to the instance default), and `sleepModel` passes
  `sleepTimeoutMs` through explicitly. `wake()` is unaffected — it returns as soon as the runner
  begins reloading, and `waitForReady` (not the `/wake` call itself) enforces `wakeTimeoutMs`.
  (#89)
- **Low-severity fixes bundle: graceful shutdown, unreachable timeouts, zero-size eviction, metric
  overwrites, unbounded notification storage, modelName validation.** (#96)
  - Hijacked SSE responses (model-launch log streaming) were invisible to Fastify's own connection
    tracking, so `app.close()` during `SIGTERM`/`SIGINT` shutdown would hang waiting for a
    connection that would never end on its own. `buildServer` now decorates the Fastify instance
    with a `hijackedResponses: Set<ServerResponse>` registry; `registerModelLogRoutes` adds/removes
    its raw response on hijack/cleanup, and `shutdown()` ends every registered response before
    `app.close()`, plus an `unref()`'d 10s watchdog `process.exit(1)` as a last resort.
  - `SleepWakeService.waitForDrain`/`waitForReady` and `DeployOrchestrationService.waitForReady`
    polled with `delay()`, which rejects as soon as its `AbortSignal` fires — so the `RUNNER_TIMEOUT`
    `ControlPlaneError` thrown after each polling loop was unreachable; an `AbortError`/
    `DOMException` propagated instead. Added `delaySafe()` (resolves instead of rejecting on abort)
    in `utils.ts` and switched all three polling loops to it, letting `while (!signal.aborted)` end
    the loop normally so the `RUNNER_TIMEOUT` error is actually thrown.
  - `EvictionEngine.selectVictims` could select a candidate with `memoryBytes <= 0` (missing/stale
    `memoryByModel` entry) as a victim — evicting a model that frees zero capacity and can never
    satisfy `requiredBytes`. Zero/negative-size candidates are now filtered out (with a warning
    naming them) before victim selection.
  - `sardeenz_control_plane_device_memory_bytes` had no per-device label, so
    `ReconciliationService.refreshMetrics` overwrote one worker's multi-GPU gauge values with
    whichever device was set last. Added a `device_index` label, populated from each device's index.
  - `NotificationService` tracked read state in a separate, unbounded `notifications:read` Redis set
    that was never trimmed alongside the capped notification list, and diverged from `LREM`-removed
    entries. Reworked to store `isRead` directly on each notification's JSON in the existing capped
    list: `markAsRead`/`markAllAsRead` now `LSET` the notification in place instead of `SADD`-ing to
    the read set, and `removeNotification`/`clearAll` no longer touch it.
  - `POST /api/v1/models` accepted any non-empty string as `modelName`, including values unsafe as
    routing keys or SIF/log-path segments. Added `pattern: '^[A-Za-z0-9._/-]{1,200}$'` and
    `maxLength: 200` to `ModelDeploymentRequest.modelName` in the OpenAPI spec (request only, not
    response schemas) and a matching runtime check in the deploy route.
- **`DELETE /api/v1/models/:modelName` no longer 404s or 409s on evicted/stopped models.** Eviction
  clears a model's Redis lifecycle state but intentionally keeps its DB record (a tombstone, so the
  model reappears in `GET /api/v1/models` as `STOPPED` and can be redeployed). The delete route,
  however, only ever looked at Redis state: a missing state meant `MODEL_NOT_FOUND` (404), and an
  explicit `STOPPED` state (e.g. after a background delete completed but the DB row lingered) was
  rejected as `INVALID_STATE` (409) — leaving evicted tombstones undeletable through the API. The
  handler now fetches Redis state and the DB record in parallel: no state and no record is a real
  404; no state but a DB record is a tombstone, deleted synchronously with a `202`/`STOPPED`
  response; and only `STOPPING` still 409s, so `STOPPED` models fall through to the normal
  stop/remove/delete background flow. (#85)
- **VRAM reservations are no longer cleared prematurely or leaked on stop/evict/worker loss.**
  `MemoryBudgetService` used to track one reservation per device (`workerId:deviceIndex`) and
  auto-clear it whenever a worker's next memory report showed `usedBytes >= reservedBytes` — an
  unrelated model reporting usage on the same device, or a report arriving in an unlucky order,
  could satisfy and wipe another model's in-flight reservation, letting a second deploy be placed
  on capacity that was still spoken for. Conversely, a model's reservation was never released when
  it stopped, was evicted, or its worker died, permanently shrinking `availableBytes` for that
  device until the control plane restarted. Reservations are now tracked per `(workerId,
  deviceIndex, modelName)`, `availableBytes` is `total - used - reserved` (co-located models'
  reservations sum rather than being collapsed via `max(used, reserved)`), and reservations are
  only ever cleared explicitly: `DeployOrchestrationService` releases a model's reservation once it
  reaches `ACTIVE` (actual usage takes over) or fails, `SleepWakeService.stopModel` releases it on
  full stop (but not on sleep, which must keep holding its budget), and
  `ReconciliationService.handleDeadWorkers` clears every reservation for a worker the moment it's
  declared dead. `MemoryBudgetService.reserveCapacity` gained a `modelName` parameter (idempotent —
  repeated calls set rather than accumulate), `releaseCapacity` was replaced by
  `releaseModelReservations(modelName)`, and the periodic `clearSatisfiedReservations` inference
  was removed entirely. (#87)
- **Deploy-path eviction no longer selects victims cluster-wide, and eviction/re-placement no longer
  block the deploy request.** `POST /api/v1/models` used to call `eviction.selectVictims` with no
  worker scope on a placement miss, so a model could be evicted from a worker that could never have
  hosted the new model anyway (wrong runner type or hardware); the stop/remove/refresh/re-place
  sequence also ran synchronously in the request handler, holding the HTTP response open for the
  full eviction cycle. `PlacementPipeline` gained a public `eligibleWorkerIds()` method (runner-type
  and hardware filtering, independent of capacity) and `EvictionEngine.selectVictims`'s 4th parameter
  changed from a single optional `targetWorkerId` to a `ReadonlySet<string>` of target workers, used
  by both the deploy path (all eligible workers) and the wake path (the model's own worker, wrapped in
  a set). The deploy handler now computes the eligible set and selects victims synchronously (still
  failing fast with `PLACEMENT_FAILED` if no worker is eligible or no victims are found), then moves
  the actual stop/remove/budget-refresh/re-place/deploy sequence into a background task and replies
  `202` immediately with `state: 'PENDING'` and a "Capacity reclamation in progress" message; a
  background failure transitions the model to `ERROR`, updates the routing map, and sends a danger
  notification, mirroring `DeployOrchestrationService`'s existing error-transition pattern. (#86)
- **Background model deletion no longer risks crashing the control plane on an unhandled promise
  rejection.** `DELETE /api/v1/models/:modelName` kicks off `sleepWake.stopModel` →
  `lifecycle.removeModel` → `modelRepository.delete` in the background after replying `202`; the
  `.then(onFulfilled, onRejected)` form used an async `onFulfilled` callback whose own rejections
  (from `removeModel`/`delete`) were never passed to `onRejected`, so a failure partway through
  produced an unhandled rejection. Replaced with a `try`/`catch` async IIFE so every step's failure
  is caught and logged, and added a `process.on('unhandledRejection', ...)` safety net in
  `index.ts` that logs fatally and exits rather than leaving the process in an undefined state.
  (#84)
- **Leader election no longer self-elects silently outside Kubernetes or swallows lease
  failures.** Off-cluster (no `KUBERNETES_SERVICE_HOST`), the control plane used to become "leader"
  unconditionally with no warning, which is only safe for a genuine single-instance deployment and
  silently masked a misconfigured multi-replica setup. Startup now requires
  `SARDEENZ_SINGLE_INSTANCE=true` (or `1`) to run without a Kubernetes Lease, throwing a clear error
  otherwise, and logs a `warn` plus the new `leadershipMode` (`'kubernetes-lease' | 'single-instance'`)
  field on the startup line. Lease acquire/renew failures — previously caught and discarded with no
  trace — are now logged (throttled to the first failure and every 10th thereafter, via the new
  `sardeenz_control_plane_leader_lease_failures_total` counter), with routine 409 lease contention
  logged at `debug` instead of `warn` to avoid alert noise. `/readyz` now also reports
  `consecutiveLeaseFailures` in the `lease_failures` check, so an operator can distinguish an
  ordinary (elected) follower from a follower actively failing to renew. (#91)
- **vLLM shim now reports cluster-global GPU indices in its memory report, and `activeRequests` is
  scraped from vLLM instead of hardcoded to 0.** `/memory-report` always reported container-local
  device indices (`0..n-1`), which don't match the control plane's cluster-global device
  assignments once a runner is scoped to a non-zero-indexed GPU. The worker agent now sets
  `SARDEENZ_DEVICE_INDICES` (parallel to `CUDA_VISIBLE_DEVICES`) when launching a CUDA runner, and
  the shim remaps its local device slots through it, falling back to the local index when unset.
  Separately, `activeRequests` in `/health` was hardcoded to `0`, which made the sleep-wake drain
  loop treat every model as already drained; the shim now scrapes vLLM's `/metrics` for
  `vllm:num_requests_running`/`vllm:num_requests_waiting` and reports their sum, and `/sleep` now
  refuses (409) while requests are active. When the metric can't be scraped, the shim omits
  `activeRequests` entirely (contract-optional) rather than reporting a misleading `0`, and the
  control plane's drain/health polling treats a missing count as **unknown** — distinct from a
  confirmed `0` — so a scrape failure can no longer be mistaken for "drained". (#116)
- **Parked requests now fail fast on mid-wake rollback and inspect the wake response instead of
  hanging or leaking.** A request parked waiting for a sleeping model to wake had three gaps: (1) if
  the model rolled **back** to `SLEEPING` after starting to wake, or (2) transitioned to `DRAINING`
  while parked, the request kept waiting until the full parking timeout (up to 120 s) before
  returning 503, and (3) the proxy ignored `WakeTriggerResponse.accepted`, treating any 2xx wake
  trigger as success even when the control plane reported it had not accepted the wake. The parking
  loop now treats a return to `SLEEPING` — but only once the model has been observed leaving it, so
  the ordinary still-waking path is unaffected — and any `DRAINING` transition as terminal, failing
  fast with a 503 so the client can retry cleanly; and `trigger_wake` now inspects the 2xx body,
  treating `accepted: false` as a failed wake while remaining lenient to an unparseable body (a
  control-plane serialization slip does not break waking). This also folds in **#97**'s fix early: a
  non-success wake-trigger response (and the soft-reject detail) is logged server-side only and the
  client receives a generic error, so the control plane's response body no longer leaks into
  client-facing errors. (#98)
- **A cancelled parked herd no longer suppresses the next request's wake trigger.** To prevent a
  thundering herd, only the first parked request for a sleeping model fires a wake trigger; the rest
  dedup against a `pending_wakes` entry. That entry was cleared only on the parking-timeout path, so
  if the entire parked herd was cancelled (all clients disconnected) while still parked — not timed
  out — the entry was orphaned, and a subsequent request for the same model deduped against the stale
  entry and never re-fired the wake, leaving the model asleep. Cleanup of `pending_wakes` is now
  folded into `ParkingSlotGuard::Drop` (which already runs on cancellation, #92), gated by a
  "was this the last parked request for the model" check, so the last departing request — whether it
  timed out or was cancelled — always clears the entry and the next request re-fires the wake. (#94)
- **Circuit-breaker half-open probes no longer leak, permanently stranding a recovering endpoint.**
  The half-open probe was tracked by a boolean set when a probe was admitted and cleared only when
  that probe recorded an outcome — so a probe request cancelled by a client disconnect before it
  returned left the flag stuck, and the endpoint sat in HalfOpen forever with no further probe ever
  admitted, never recovering. The probe reservation is now claimed **after** load balancing (on the
  endpoint actually chosen, not every candidate) and is RAII-guarded (`ProbeGuard`): a probe dropped
  before recording an outcome releases immediately, while a probe that recorded an outcome disarms
  its guard so it cannot clear a claim a different task has since taken. A leak-backstop expiry
  (`probe_timeout`, derived as `max(recovery_timeout, upstream_timeout)` so a legitimate long probe
  is never mistaken for a leaked one) re-admits a probe even if a release is somehow missed.
  Candidate selection uses a new non-mutating `is_available`, so building the candidate set no longer
  claims probes on endpoints the balancer won't pick. The circuits map was switched from an async to
  a blocking (`std::sync::Mutex`) lock so the guard's `Drop` can release without awaiting (same
  pattern as #92), and upstream forwarding failures now return a generic error to the client with the
  underlying cause logged server-side (internal endpoint URLs no longer leak in error bodies). (#93)
- **Redis sync no longer silently drops routing entries it can't parse, and reconnects with backoff.**
  When the proxy's Redis sync encountered an unparseable routing-map entry, it silently dropped that
  model from the routing map — a single malformed write could deregister a live model with no signal.
  Sync now counts every unparseable entry (`sardeenz_proxy_routing_parse_errors_total`, labeled by
  model) and logs it, and carries forward the previous entry for a present-but-unparseable key
  (instead of dropping it) so one bad write can't take a model offline; a genuinely removed key
  (absent from Redis) is still dropped correctly. Separately, when the Redis sync stream ended
  cleanly the proxy reconnected in a tight loop; reconnect now uses capped exponential backoff with
  full jitter (500 ms base, 5 s cap), and `/readyz` reports not-ready on every sync exit path (both
  clean-end and error) rather than only some. (#99)
- **Parking slots and connection gauges no longer leak when a client disconnects mid-park.** When a
  client dropped its connection while its request was parked waiting for a model to wake, the parking
  slot counters (global and per-model) and the `sardeenz_proxy_parked_connections` gauge were never
  released — because release happened on an explicit code path that request cancellation skipped —
  slowly exhausting the parking capacity. Release is now cancel-safe via an RAII guard
  (`ParkingSlotGuard`) whose `Drop` reclaims the global/per-model counters, decrements the parked
  gauge, and records the park-duration histogram, so a dropped (cancelled) request future always
  releases its slot; the per-model counter's mutex was switched from an async to a blocking
  (`std::sync::Mutex`) lock so the guard's `Drop` can release without awaiting. The active-connection
  gauge is likewise now released via an RAII guard. (#92)
- **Sleeping a model no longer corrupts its routing entry.** The control plane's routing-map Lua
  scripts encoded the `endpoints` array with `cjson.encode`, which serializes an empty Lua table as
  `{}` (a JSON object) rather than `[]` (a JSON array) — so removing the last endpoint (e.g. when a
  model is put to sleep) wrote a routing entry the stateless proxy could not parse, silently dropping
  the model from the routing map. The three routing-map scripts (`addEndpoint`, `removeEndpoint`,
  `updateEndpointHealth`) now encode `endpoints` as a JSON array unconditionally, and the
  model-lifecycle `transition` script applies the same `[]`-forcing fix to an empty `deviceIndices`
  array. Regression coverage lands as a gated integration suite that asserts the raw persisted Redis
  payloads (not the parsed round-trip, which would mask the bug). (#79)
- **Dashboard Playwright e2e suite is now runnable, enforced, and lint/typechecked.** The suite was
  entirely non-functional — every test that used the `bffPort` fixture failed before its body ran,
  because (a) the BFF only served the SPA under `NODE_ENV=production` while the fixture set
  `NODE_ENV=test`, and (b) the readiness probe polled `/api/health`, a route that was allowlisted but
  never registered. Static serving is now decoupled from `NODE_ENV` via `SARDEENZ_SERVE_STATIC=1`
  (set by the fixture), a real liveness `GET /api/health` is registered (making the auth allowlist
  entry truthful), and `SARDEENZ_CLIENT_DIR` lets the fixture point the tsx-spawned server at the
  built `dist/client` bundle (unset in production, where the default resolves the same path). The
  suite is now covered by ESLint (`dashboard/e2e/` un-ignored, with a type-aware override) and by a
  new `typecheck:e2e` wired into `make typecheck`, and `test:e2e` builds the client before running.
  Two vacuous `auth.spec.ts` assertions (a `x || !x` tautology and a not-401/not-403 check) were
  replaced with a concrete redirect-URL assertion and an explicit `200`. The nine specs now run to
  real pass/fail; pre-existing PatternFly-6 selector drift surfaced by the newly-runnable suite is
  tracked as a follow-up. (#102)
- **Phase-4 spike-gate suite (`tests/gates/run-gates.sh`) no longer reports false results.**
  Gate 5 (SIGTERM shutdown) used `kill -0` to check survival, which counts a zombie/defunct process
  as "alive" — it now records the runner PIDs before signalling and asserts no matching process
  remains after the grace period (treating `Z*` state as exited). Gate 4 (weights `--bind`) writes a
  unique `mktemp` probe under the weights volume instead of a fixed filename and cleans it up inline.
  Gate 9 (kvcached co-location) now captures each runner's `runnerId`, polls `/memory-report` until
  the runner is READY (a `STARTING` runner returns 409 with no `.devices` — previously a false
  failure), asserts co-location on GPU 0 for both, and always cleans up the runners it created via an
  EXIT trap. Gates 3/7/8 guard on the tiny-SIF actually existing, Gate 8 also compares PID
  namespaces, and `main()` distinguishes "no SIF built" from "no GPU present" when skipping GPU-gated
  checks. The script keeps `set -uo pipefail` (no `-e`) so one gate's failure never aborts the run.
  (#117)
- **The model-launch log modal no longer closes itself mid-startup, and startup logs stay
  viewable.** The deploy modal auto-closed ~2s after the model first reported `ACTIVE`, which — for
  engines whose startup is still in progress — yanked it away while weights were barely loading. The
  modal now stays open until the operator closes it; the "model available" notification and state
  change still fire on the real `ACTIVE` transition (so someone who closed the modal is still told
  when it's actually up). Once the engine finishes starting, the worker **ends** the launch-log
  stream and seals the buffered startup logs: post-startup request logs are no longer captured or
  streamed to the control plane, and reopening the (renamed) **"View starting logs"** action replays
  just the startup logs and closes cleanly. Implemented via a new `onStartupComplete` launcher
  signal (`ApptainerLauncher` fires it once vLLM's `/health` is green — after "Application startup
  complete" — and stops forwarding stdio while still draining it; the dev-worker stub fires it when
  its simulated startup ends) wired to `RunnerLogBuffer.markEnded`, which now also seals late so a
  reopened stream still gets an `end` frame.

- **Inference through the routing proxy now reaches the vLLM engine.** `POST /v1/chat/completions`
  (and `/v1/completions`) to the proxy returned the runner's `{"detail":"Not Found"}` because the
  proxy forwarded to the runner's **management** port — the vLLM shim, which serves only the
  runner-contract control API — while vLLM's OpenAI server runs on a separate **engine** port
  (`--port + 1`, e.g. `9102`). Nothing propagated that engine port past the worker. `StartRunnerResponse`
  now carries an optional `enginePort`; the worker allocates management/engine ports in **pairs** (so a
  second runner's management port can't collide with the first's engine port) and the `ApptainerLauncher`
  pins vLLM's OpenAI server to it via `--engine-port`. The control plane registers the engine port as the
  model's routing endpoint (the proxy forwards `/v1/*` there) while keeping health/sleep/wake/log-stream
  on the management port; it persists `runnerEnginePort` so wake re-registers — and sleep/stop remove —
  the correct endpoint. Runners that serve inference on the management port omit `enginePort` and fall
  back to it, so the dev-worker stub (single Fastify server) is unaffected. `GET /v1/models` was already
  fine — the proxy synthesizes it from the routing map. The worker also now forwards
  `--served-model-name <routing-name>` to `vllm serve` (via the shim's existing `--` passthrough, so it
  works with already-built SIFs) so vLLM registers the model under the routing name instead of its
  weights path — without it, requests that reached the engine were rejected with
  `"The model ... does not exist"` (a 404 from vLLM) because the client's `model` field never matched the
  path vLLM served under. The management-vs-engine (`enginePort`) port model is now documented in
  `docs/architecture/components/runner-contract.md` and `proxy.md`, and `docs/project/phase4.md`
  carries a GPU-gated end-to-end re-verification checklist for it. (#77)

- **Deploying a model no longer crashes with "models is not iterable" when a model-detail page is
  cached.** The optimistic cache update in `useDeployModel` ran over every query matching the
  `['models']` prefix, which includes the `['models', name]` detail queries whose data is a single
  `ModelDetail` with no `.models` array — spreading that `undefined` threw. The update now only
  touches list-shaped entries (extracted as `updateModelListData`, with a regression test).

- **Deleting a model (and other bodyless control-plane actions) no longer 500s.** The dashboard
  BFF's `ControlPlaneClient` set `Content-Type: application/json` on **every** proxied request,
  including bodyless ones (`DELETE /models/:name`, sleep/wake, catalog import/refresh/uninstall,
  notification read/clear). An empty body with that header trips Fastify's default JSON parser on
  the control plane (`FST_ERR_CTP_EMPTY_JSON_BODY`), which surfaced as "Internal server error" in
  the UI. The client now sets the JSON content-type only when a body is actually sent.

- **Integration tests no longer flake in the default `npm test` run.** The root `vitest run` picked
  up the control-plane `*.integration.test.ts` files under default (parallel) settings, so the three
  files raced on the shared Postgres test database each `TRUNCATE`s — intermittently clobbering each
  other — and also ran a second time (serially) under `make test-integration`. A default
  `control-plane/vitest.config.ts` now excludes the integration glob from the parallel run; the
  integration suite runs only via `npm run test:integration` / `make test-integration` (which sets
  `fileParallelism: false`).

- **Integration tests no longer run against (and wipe) the dev database.** The control-plane
  integration harness loaded the repo `.env` and truncated `models`, `memory_profiles`,
  `benchmarks`, and `settings` in whatever `SARDEENZ_DATABASE_URL` pointed at — i.e. the dev DB —
  cleaning up Redis on teardown but never Postgres, so the last test run left `herd-model` /
  `stuck-model` behind (surfacing as phantom entries on the dashboard Models page). The harness now
  targets a **dedicated test database** (dev DB name suffixed with `_test`, e.g. `sardeenz_test`,
  plus Redis logical DB `1`), **auto-creates** it (advisory-locked so parallel vitest workers don't
  race), **refuses** to run against any database whose name doesn't end in `_test` (override with
  `SARDEENZ_ALLOW_NON_TEST_DB=1`), and truncates on teardown too. Overridable via
  `SARDEENZ_TEST_DATABASE_URL` / `SARDEENZ_TEST_REDIS_URL`. See `docs/development/setup.md`.

- **Unified `dotenv` to v17 tree-wide.** `@redocly/cli` pinned `dotenv@16.4.7` at the workspace
  root while each service nested `17.4.2`, so an editor/root TypeScript server resolving the root
  copy flagged phantom `'quiet' does not exist in type 'DotenvConfigOptions'` errors on the
  `loadRootEnv()` helpers (`quiet` was added in dotenv v17). Added a root `overrides` entry forcing
  `dotenv` to `^17.0.0`, deduping the whole tree (redocly included) to `17.4.2`.

### Changed

- **Reordered the Deploy Model form fields** to lead with runtime selection: Runner Type, Runtime
  Module, Model Path, Model Name, then the remaining fields (required memory, device type, tensor
  parallel, pinned, engine config).

- **Runtime Module on the Deploy Model form is now a required dropdown** instead of a free-text
  field. It lists the runner catalog entries that are installed (`IMPORTED`) and built for the
  selected runner type (`entry.runnerType === runnerType`), offering each module's `sifName` as the
  value. Deploys must pick a module explicitly rather than relying on the worker's
  `<runnerType>-<engineConfig.version>` fallback (which fails when no version is set). Changing the
  runner type clears the selection, and an empty-state hint points operators to the Runner Catalog
  when no compatible module is installed.

- **Dev worker now detects real GPUs in `apptainer` mode.** Previously the worker advertised a
  device fleet fabricated from `SARDEENZ_DEVICE_COUNT` / `SARDEENZ_DEVICE_MEMORY_GB` (defaults
  `2` × `24 GiB`) in **every** mode — so an apptainer-mode worker on a single 8 GiB card still told
  the control plane it had `2 × 24 GiB`, corrupting placement/budget decisions. The worker now
  queries `nvidia-smi` at registration in apptainer mode and advertises the real devices, falling
  back to the configured fleet only when `nvidia-smi` is absent (CPU dev box) or in `stub` mode
  (always simulated). The startup log states the origin explicitly — `detected 1x CUDA @ 8 GiB`,
  `simulating 2x CUDA @ 24 GiB`, or `configured … (no nvidia-smi)` — and the advertised
  `engineName` is `<runner> (apptainer)` instead of `Dev Stub (<runner>)` when not stubbing. Set
  `SARDEENZ_DEVICE_COUNT` / `SARDEENZ_DEVICE_MEMORY_GB` to shape the simulated fleet in stub mode.

### Added

- **Explicit runtime-module (SIF) selection when deploying a model.** The Apptainer worker needs to
  know which SIF to exec; previously the only way to influence that from the UI was stuffing a
  `version` into `engineConfig` (the worker derived `<runnerType>-<version>`), which was undiscoverable
  and error-prone. `runtimeModule` is now a first-class, optional field plumbed end to end: a
  **Runtime Module** field on the dashboard deploy form (and a row on the model detail page), a new
  optional `runtimeModule` property on `ModelDeploymentRequest`/model-detail in the control-plane
  contract (pattern `^[A-Za-z0-9_.-]+$`), a `runtime_module` column on the `models` table
  (migration `002`), and forwarding through the deploy path into the worker's `StartRunnerRequest`
  (the worker resolves it to `/modules/<runtimeModule>.sif`). When omitted, the worker still falls
  back to `<runnerType>-<engineConfig.version>`, so existing deployments are unaffected. All configurable ports and connection URLs
  now come from one git-ignored `.env` file at the repo root (documented in a committed
  `.env.example`), so port clashes with other local projects are resolved in one place. The
  compose stack reads it automatically for the container **host-port mappings**
  (`SARDEENZ_REDIS_HOST_PORT`, `SARDEENZ_POSTGRES_HOST_PORT`) and Postgres credentials; every
  application service loads the same file at startup — the Rust proxy via `dotenvy`, the Node
  services (control plane, dashboard BFF, dev worker) via a small per-service `loadRootEnv()`
  helper (`dotenv`), and the Vite dev server via `loadEnv()` (its port and `/api` proxy target,
  previously hard-coded, are now `SARDEENZ_DASHBOARD_PORT` / `SARDEENZ_BFF_PROXY_TARGET`). Loading
  never overrides real environment variables and is a no-op in production, so per-process
  overrides and container/k8s config are unaffected. Integration and E2E suites load the same
  `.env` and honor the configured host ports. See `docs/development/setup.md`. The `.env.example`
  also documents `SARDEENZ_RUNNER_CATALOG_URL` (local vs. remote catalog source) and the
  `SARDEENZ_VERIFY_SIF` toggle, with an **unsigned-SIF experimentation workflow** (build+push with
  plain `apptainer`, verification off) in `docs/usage/runner-catalog.md` — with a reminder to
  re-enable signature verification with a shared key before exposing the deployment — plus the
  worker apptainer-mode overrides (`SARDEENZ_WORKER_MODE`, `SARDEENZ_MODULES_DIR` /
  `SARDEENZ_WEIGHTS_DIR` / `SARDEENZ_SCRATCH_DIR`) for running real engine SIFs locally. The
  dev-worker apptainer bind mounts and `HOME` now **derive from** the weights/scratch dirs
  (`binds` = `[WEIGHTS_DIR, SCRATCH_DIR]`, `HOME` = `<SCRATCH_DIR>/home`) instead of hard-coded
  `/weights`,`/scratch` — so a local run only needs the dir overrides, not the bind/HOME vars
  (prod `/weights`,`/scratch` defaults unchanged; `SARDEENZ_APPTAINER_BINDS`/`_HOME` still override).

- **Runner catalog (ORAS distribution + in-app import).** Official runner SIFs are published to an
  OCI registry via ORAS and listed in a `runners.yaml` catalog (repo root is the dev source;
  `SARDEENZ_RUNNER_CATALOG_URL` defaults to the official `school-of-sardeenz` raw URL). The control
  plane loads/caches the catalog, merges it against the shared module store (imported state +
  `updateAvailable` + `unmanagedModules`), and imports on demand via a **pluggable `SifImporter`**
  — `OrasImporter` (`apptainer pull oras://…` + verify, atomic publish) for real deployments
  (Kubernetes _or_ Podman/VM — the control plane mounts the module store read-write and pulls
  directly, no K8s Job), and `StubImporter` for local dev/CI (no apptainer). New control-plane
  endpoints `GET /catalog`, `POST /catalog/refresh`, `POST /catalog/{id}/import` (async, progress
  on the SSE stream via `CATALOG_*` events), `DELETE /catalog/{id}` (uninstall, guarded against
  in-use modules). New dashboard **Runner Catalog** page (gallery with imported badges, live import
  progress, re-import, uninstall confirm, manual refresh) behind a new nav item + BFF proxy.
  Adds the `sardeenz-control-plane` SA as a second module-store writer (VAP exemption) and installs
  the unprivileged apptainer CLI in the control-plane image. The librarian build pipeline remains
  for those who build their own SIFs. Decision recorded in
  [ADR-018](docs/architecture/adrs/adr-018-runner-catalog-oras-distribution.md) (amends ADR-017).

- Phase 4 implementation — SIF runner runtime (in progress):
  - **Cross-model review fixes:** the vLLM shim now keeps a liveness monitor running after READY
    (a post-startup engine crash flips state to `ERROR` instead of reporting healthy forever) and
    `/memory-report` fails closed (409) rather than emitting a contract-invalid empty `devices`
    array. The `ApptainerLauncher` validates `runtimeModule` against `^[A-Za-z0-9_.-]+$` (path-
    traversal guard; `pattern` also added to the contract), passes `--cleanenv` so the worker
    agent's environment isn't leaked into the engine SIF, and raises its stop grace above the
    in-SIF shim's drain budget so the graceful stop (which reaps vLLM's separate session)
    completes before the SIGKILL backstop. The module-write-protection VAP guards `spec.volumes`
    with `has()` (a volumeless Pod no longer errors the policy into a hard deny), the SCC uses
    `fsGroup: RunAsAny` so `fsGroup: 0` is actually admitted, the worker Deployment sets
    `terminationGracePeriodSeconds: 60`, and `build-sif.sh` validates `--name` and cleans up its
    node-local build artifact.
  - **Integration gate suite (Task 9):** `tests/gates/run-gates.sh` automates the spike gates as a
    repeatable, cluster-runnable check. CPU gates 0–6 (userns/seccomp/`/dev/fuse` fingerprint,
    build+exec, no-copy squashfuse, weights `--bind`, clean SIGTERM, parallel/hot-add) run on any
    4.15+ Pod; GPU gates 7–9 (`--nv`, namespace sharing, two kvcached runners on one GPU via the
    worker agent) + the Gate 10 spawn measurement are gated behind `--gpu`/GPU detection. Non-zero
    exit on any failed gate.
  - **SIF librarian pipeline (Task 7):** `scripts/build-sif.sh` (build → sign → verify → publish,
    node-local temp then atomic rename to a world-readable `0644` versioned SIF) and
    `deployment/librarian/` (Job mounting the module PVC **read-write** + node-local scratch + ≥8Gi
    RAM, the `sardeenz-librarian` SA — the sole module-store writer — with SCC-use RBAC, and a
    private-signing-key Secret template). Documents SIF signing-key management (private key only in
    the librarian Job; public key distributed to workers) and a rotation procedure.
  - **Worker security + Deployment manifests (Task 8):** the repo's first K8s manifests, as a
    Kustomize base under `deployment/sif-runner/` (format decision recorded in `deployment/README.md`
    — Kustomize + raw YAML, `sardeenz-` naming). Ships the `sardeenz-sif-runner` custom SCC
    (restricted-v2 + seccomp `Unconfined`), worker SA + SCC-use RBAC, RWX module/weights PVCs, and
    the worker `Deployment` (`/dev/fuse` annotation, no `hostUsers:false`, GPU limit, mem
    req/limit, `fsGroup:0`, `HOME=/scratch/home`, module `readOnly`/weights/scratch/`/dev/shm`
    mounts, runs the agent `--mode=apptainer` and imports the SIF signing public key for
    `apptainer verify`). Module-PVC write protection uses a **ValidatingAdmissionPolicy** (chosen
    mechanism; two-PVC and convention fallbacks documented). Opt-in `ContainerRuntimeConfig` forces
    `crun` where needed. `worker-base` now installs Node.js for the TypeScript agent.
  - **vLLM runner shim (Task 5):** new `runners/vllm/` Python package (`sardeenz-vllm-runner`) that
    runs inside the vLLM SIF, serves the engine-runner contract (`/health`, `/capabilities`,
    `/memory-report`, `/sleep`↔`/wake`, `/sleep-status`, `/progress`), and drives `vllm serve`
    (launched with `--enable-sleep-mode`; sleep/wake via vLLM dev endpoints). Declares
    `kvCacheElasticSharing` in capabilities when kvcached is enabled; maps `L1_HOST_RAM` → vLLM
    sleep level 1; propagates SIGTERM to the vLLM process group. The `runner-vllm` Containerfile
    now installs the shim and defaults its entrypoint to it. Pure CLI/state logic is unit-tested
    with pytest (no vLLM/torch needed).
  - **Worker agent — launcher abstraction (Task 4):** extracted a `RunnerLauncher` interface from
    the Phase 3.6 worker agent (`runners/dev-worker`). `StubLauncher` keeps the in-process stub
    behaviour (dev); the new `ApptainerLauncher` `apptainer exec`s an engine SIF (prod) — resolves
    `runtimeModule` → `/modules/<engine>-<version>.sif`, adds `--nv` + `CUDA_VISIBLE_DEVICES` for
    CUDA, redirects caches to node-local `/scratch`, sets a writable `HOME=/scratch/home` as a
    process env (never `--env HOME`, which Apptainer rejects), `apptainer verify`s the signature
    before exec, waits for `/health` READY, and propagates SIGTERM→SIGKILL on stop (spike Gate 5).
    The `RunnerManager` serializes cold-starts when the launcher requires it (concurrent engine
    cold-starts OOM a peer — spike Gate 9c) and rolls back the model slot on launch failure. Mode
    selected via `--mode=apptainer` / `SARDEENZ_WORKER_MODE`; all Phase 3.6 stub tests stay green.
  - **Contracts:** added an optional `runtimeModule` selector (`<engine>-<version>`, e.g.
    `vllm-0.21`) to `StartRunnerRequest` (`worker-agent.yaml`) so the production worker resolves
    which signed SIF to `apptainer exec` (`/modules/<runtimeModule>.sif`); the dev-worker stub
    ignores it (back-compat). Added the `kvCacheElasticSharing` well-known feature key to
    `RunnerCapabilities.features` (`engine-runner.yaml`) — elastic, reclaimable device-memory
    sharing across co-located runners (vLLM + kvcached), distinct from host-RAM `kvCacheOffload`;
    a future oversubscription placement policy keys on it. Regenerated `@sardeenz/types`.

- Phase 4 architecture + plan: adopted **Apptainer SIF on shared RWX** as the engine runtime
  delivery mechanism, replacing the Highlander/EasyBuild-Lmod approach. New ADRs
  [ADR-015](docs/architecture/adrs/adr-015-sif-runtime-packaging.md) (SIF delivery, supersedes
  ADR-004), [ADR-016](docs/architecture/adrs/adr-016-sif-worker-security-posture.md) (mild custom
  seccomp SCC + `/dev/fuse` + in-container userns), and
  [ADR-017](docs/architecture/adrs/adr-017-runner-image-pipeline.md) (build/sign/convert pipeline
  - `containers/` layout). Added the implementation task breakdown
    [`docs/project/phase4.md`](docs/project/phase4.md) and the `containers/` runner-image
    definitions (`containers/README.md`, `containers/worker-base/`, `containers/runner-vllm/` =
    base vLLM + kvcached). Reconciled the architecture overview (Runtime Delivery section, ADR
    index), `overall-plan.md` Phase 4, and `CLAUDE.md` to the SIF model; marked ADR-004 superseded
    and ADR-010 amended; `easyconfigs/` dropped.

- Phase 4 spike — `docs/project/phase4-apptainer-spike.md`: fail-fast OpenShift feasibility runbook
  for running engine runtimes as Apptainer/SIF modules from a shared RWX volume
  (user-namespace, FUSE, no-local-copy, GPU `--nv`, parallel-versions/hot-add gates). Goal
  is RWX-agnostic (run on any RWX volume); this run used **AWS EFS (NFSv4)** as a
  first-class proof point, with CephFS a priority follow-up on another cluster. Deploys onto
  the network-FS-compatible path — a custom mild SCC (seccomp `Unconfined` only) +
  `/dev/fuse` via the `io.kubernetes.cri-o.Devices` annotation (no device plugin), with
  Apptainer creating its own user namespace inside the container. Field findings baked into
  the runbook: pod-level user namespaces (`hostUsers: false` / the shipped
  `nested-container` SCC) are unusable with a network RWX PVC (they need idmapped volume
  mounts NFS/EFS can't provide, nor CephFS on current RHCOS kernels); OCI→SIF conversion
  scratch must be node-local (a network-FS `APPTAINER_TMPDIR` fails the hardlink-heavy
  unpack with `unpriv.link … too many links`), so the Deployments mount a node-local
  `emptyDir` at `/scratch`; and the `worker-base` image needs `tzdata` + an `/etc/localtime`
  symlink (Apptainer bind-mounts `/etc/localtime` by default, absent from stock UBI9).
  Workload is a `Deployment` (scale 0/1 to stop/start). All six CPU gates (0–6) pass on a
  live OKD 4.21 cluster — including the core "no local copy" claim (SIF runs in place via
  squashfuse off the shared RWX volume), reading model weights via `--bind` from a real
  interpreter in the SIF, a long-lived HTTP runner whose inner process dies cleanly on
  SIGTERM to the launcher (no orphan, no zombies), and parallel versions + hot-add of a new
  module without a Pod restart + concurrent readers of the same SIF. GPU Gate 7 also passes:
  the GPU is visible inside the SIF via `apptainer --nv` (NVIDIA L4, no ldconfig /
  nvidia-container-cli tweak needed), and Gate 8 confirms the SIF shares the pod's
  ipc/pid/net namespaces (the kvcached precondition). Gate 9c passes too: two SIF-launched
  vLLM engines serve `opt-125m` on one L4 with a static memory split (staggered start to
  avoid a concurrent-cold-start host-RAM OOM). **Gate 9d passes** — the make-or-break result:
  with a kvcached-built image (base vLLM + a compiled kvcached wheel +
  `ENABLE_KVCACHED`/`KVCACHED_AUTOPATCH`, and cache dirs redirected off the read-only SIF),
  two SIF-launched vLLM engines load kvcached and share GPU memory elastically on one L4. That
  custom-image requirement holds for SIF or plain container alike, so it's SIF-neutral. Gate 10
  (economics): cold spawn from the shared SIF ~19s (fresh Pod), warm import ~10.2s; the SIF is
  materialized once for the whole fleet with no per-node pull / no local copy (the one-time
  conversion is amortized), so it's not a decision driver. **All gates 0–10 pass → VERDICT: GO**
  on the network-FS-compatible path with a mild custom SCC (EFS-proven). Named follow-ups
  (non-blocking): re-characterize perf on CephFS; productionize the SCC as a scoped seccomp
  profile via the Security Profiles Operator; enforce SIF signing/verification + PVC RBAC.
  Method correction: the squashfuse mount is namespaced (root is a RO overlay over the session
  rootfs), invisible in both the parent and container `/proc/mounts`; Gate 3 now checks the
  `squashfuse_ll` process + zero scratch growth. Also documents the decided Phase 4 provisioning
  model: Sardeenz publishes a Containerfile per runner, builds/signs the images in CI, converts
  image→SIF in a librarian job, and workers only `apptainer exec` the signed SIF (closing the
  supply-chain gap). Investigative only — no platform code yet.

- Phase 3.6 — Dev Worker Agent: local-process worker agent enabling full Sardeenz
  stack development without containers, GPUs, or real inference engines
  - **Worker agent OpenAPI spec** (`packages/contracts/specs/worker-agent.yaml`):
    formalized the worker management API (`POST /runners`, `DELETE /runners/{runnerId}`)
    with `StartRunnerRequest`/`StartRunnerResponse`/`WorkerInfo`/`WorkerMemoryReport`
    schemas; generated TypeScript types via `openapi-typescript`
  - **Dev worker agent** (`runners/dev-worker/`): TypeScript Fastify process that
    self-registers in Redis (capabilities, devices, heartbeat, memory report),
    exposes the worker agent management API, and spawns in-process runner stubs
    on sequential ports; configurable via `SARDEENZ_*` environment variables
  - **Runner stubs**: lightweight Fastify servers implementing the full engine runner
    contract (`/health`, `/memory-report`, `/sleep`, `/wake`, `/sleep-status`,
    `/progress`, `/capabilities`) with configurable simulated startup phases,
    sleep/wake delays, and per-device memory tracking; state machine models the
    full runner lifecycle (STARTING → READY ↔ BUSY, READY ↔ SLEEPING, any → ERROR)
  - **Simulated inference**: OpenAI-compatible `/v1/chat/completions` endpoint with
    non-streaming (canned ChatCompletion response) and streaming (SSE token-by-token)
    modes; returns 503 when runner is not READY; includes correct model name in responses
  - **Control plane alignment**: `WorkerClient` now imports `StartRunnerRequest`
    and `StartRunnerResponse` types from `@sardeenz/types` generated spec
  - **Makefile targets**: `dev-worker` (single worker), `dev-worker-2` (two workers),
    `dev-full` (full dev stack with worker), `dev-worker-stop` (cleanup)
  - **Test suite**: 76 tests across 6 test files — registration (10), runner-manager (8),
    state machine (35), contract endpoints (13), inference (7), e2e integration (3)

- Phase 3.5 — Admin UI finalization (header bar feature parity with v1 dashboard):
  - **Notification backend**: `NotificationService` in control plane with Redis list
    storage (capped at 200), read-state tracking via Redis set, and pub/sub push on
    create; REST API for list, mark-read, mark-all-read, remove, and clear-all; BFF
    proxy routes with auth gating (`admin-readonly` role)
  - **Notification frontend**: `NotificationContext` provider with SSE push, history
    fetch on mount, 500ms deduplication window, and unread count; `NotificationDrawer`
    overlay with PatternFly `NotificationDrawer*` components, actions dropdown, and
    empty state; `AlertToastGroup` for ephemeral toast alerts with auto-dismiss
  - **Theme system**: `ThemeContext` with dark/light toggle, `localStorage` persistence,
    `prefers-color-scheme` fallback, and `pf-v6-theme-dark` class management
  - **Masthead overhaul**: SVG logo in `<Brand>`, hamburger sidebar toggle, Sun/Moon
    theme `ToggleGroup`, notification badge button, user dropdown with username/role
    and logout action
  - **Lifecycle event notifications**: model deploy success/failure, sleep/wake/delete
    initiation, worker join/leave, dead worker model failures, and stuck model recovery
    all generate notifications via `NotificationService`
  - **SSE notification channel**: BFF subscribes to `{prefix}:notifications` Redis
    channel alongside `routing-updates` and `cluster-events`, forwarding notification
    payloads as `NOTIFICATION` cluster events to connected SSE clients
  - **Sidebar footer**: GitHub repository link with theme-aware icon (dark/light variants)
  - **i18n keys**: theme toggle, notification drawer, user menu, and sidebar footer strings
  - SVG assets: Sardeenz logo, GitHub/star/fork icons (light and dark variants)

- `victory` peer dependency for `@patternfly/react-charts` chart rendering.
- Dev server logging infrastructure: `dev:logged` scripts pipe component output
  to `logs/` via `tee` (proxy, control-plane, dashboard, BFF server).
  Convenience scripts for tailing (`logs:proxy`, `logs:cp`, `logs:dashboard`,
  `logs:bff`, `logs:all`) and clearing (`logs:clear`). Root `dev` and
  `dev:logged` scripts run all four components concurrently with colored,
  prefixed output. The proxy gracefully skips if Rust is not installed.
- Redis-backed E2E test harness with three core resilience scenarios (#57):
  degraded mode with Redis fallback, SSE-driven model state transitions via
  Redis pub/sub, and multi-GPU VRAM visualization with known proportions.
  Tests require compose Redis (`podman compose up -d redis`).
- Custom date/time range picker for MetricsDashboard (closes #62): operators
  can select arbitrary historical time windows in addition to the existing
  preset ranges (15m, 1h, 6h, 24h, 7d). Auto-refresh is disabled while a
  custom range is active.
- Clickable model-state breakdown in ClusterOverview (closes #62): clicking a
  state row navigates to the model list pre-filtered by that state.
- Optimistic updates for model mutations (closes #62): deploy, sleep, wake,
  and delete actions immediately reflect transitional states (PENDING,
  DRAINING, STARTING, STOPPING) in the UI before server confirmation, with
  automatic rollback on error.
- Sort by state and memory in the model list (closes #62): the State and
  Memory columns are now sortable, using lifecycle-state ordering and numeric
  memory comparison respectively.
- Notification SSE channel support in dashboard BFF: the `/api/events` endpoint
  now subscribes to `notifications` Redis channel and forwards notification
  messages as `NOTIFICATION` cluster events to connected SSE clients.
- Notification proxy routes in dashboard BFF: `GET /api/notifications` (list),
  `POST /api/notifications/:id/read` (mark as read), `POST /api/notifications/read-all`
  (mark all as read), `DELETE /api/notifications/:id` (remove), and
  `DELETE /api/notifications` (clear all) endpoints proxy to control plane API.

### Fixed

- SSE auth now uses HttpOnly cookies instead of query-string tokens, preventing
  JWT leakage in browser history, access logs, and referrer headers (#66).
- Frontend validates cached JWT tokens server-side via `/api/auth/me` on boot,
  instead of trusting client-side decoded claims (#66).
- OAuth callback routing aligned: server redirects to `/oauth/callback#token=…`
  matching the frontend route, and the callback page waits for auth state instead
  of using a blind 100ms timeout (#66).
- Added `POST /api/auth/logout` endpoint to clear the SSE auth cookie (#66).

### Changed

- **Makefile dev-target cleanup.** `make` (no target) now prints a grouped, self-documenting
  `make help`. Added `make dev` (app stack without workers — same as `npm run dev`) and `make dev-bff`
  (dashboard BFF only); `make dev-full` now starts the whole stack with **one** worker (two-worker
  runs remain via `make dev-worker-2`). Target descriptions and `docs/development/setup.md` updated.
- **Proxy and control-plane bind-address env vars renamed to avoid a collision.** Both used to
  read `SARDEENZ_LISTEN_ADDR`; they now read `SARDEENZ_PROXY_LISTEN_ADDR` and
  `SARDEENZ_CONTROL_PLANE_LISTEN_ADDR` respectively, each falling back to the legacy
  `SARDEENZ_LISTEN_ADDR` when unset. Existing deployments keep working; a single shared `.env`
  can now set both ports independently.
- Dev scripts for control-plane and dashboard BFF use `node --watch` for
  automatic reload on file changes.
- Default database URL includes dev credentials (`sardeenz:sardeenz`).
- Dynamic runner options in the deploy form de-scoped to Phase 4 (#67):
  requires adding `runnerCapabilities` to the `WorkerInfo` list endpoint and
  a corresponding backend change. The dropdown remains hardcoded for now.

- Per-device model attribution for multi-GPU workers (closes #60): the
  control plane now persists device placement indices in Redis `ModelState`
  during model deployment. The `WorkerModelInfo` and `ModelDetail` contracts
  include an optional `deviceIndices` array. The dashboard renders per-device
  model breakdowns on each GPU card for multi-GPU workers (previously only
  shown for single-GPU workers) and adds a "Devices" column to the running
  models table. Models deployed before this change gracefully fall back to
  the previous behavior (no per-device attribution).
- VRAM visualization enhancements (closes #59): added GiB/percent display
  toggle to the MemoryVisualization card header, click-through navigation
  from worker IDs to worker detail pages, and worker-level model name
  labels showing running models and their states below each worker header.
  For single-GPU workers, model names also appear in the device bar tooltip.
- Real-time worker and memory SSE events (closes #56): the control plane's
  reconciliation loop now publishes `WORKER_JOINED`, `WORKER_LEFT`, and
  `WORKER_MEMORY_UPDATED` events on a new `{prefix}:cluster-events` Redis
  pub/sub channel. The BFF SSE relay subscribes to both `routing-updates`
  (model/endpoint events) and `cluster-events` (worker/memory events),
  forwarding all as `ClusterEvent` objects to the frontend. The frontend
  `useEventStream` hook now receives and processes these events with
  leading+trailing edge throttle (1 event/second) on memory update
  invalidation to prevent re-render flickering.

### Fixed

- Converted stale planning language in phase 3 docs to explicit decisions (closes #64):
  `docs/project/phase3.md` "Open Questions" section renamed to "Decisions" with all
  "leaning toward" items replaced by their actual implemented choices (TanStack Query,
  BFF in `dashboard/server/`, PF react-charts, light-theme-only as future work, PF6
  porting moot since v1 already used PF6); masthead description updated to reflect
  auth integration as implemented. `docs/project/v1-component-mapping.md` updated to
  reflect that auth is implemented (JWT-based, three modes: `none`/`simple`/`oauth`)
  rather than deferred.

- Updated SSE architecture docs to reflect actual per-client subscriber design (closes #58):
  the Risks table in `docs/project/phase3.md` previously implied a shared fan-out model;
  corrected to describe the real per-client Redis subscriber approach with explicit trade-off
  note (per-client is correct at admin-dashboard scale of tens of connections; shared fan-out
  would be needed for hundreds+). Expanded the SSE relay section in
  `docs/architecture/components/dashboard.md` with the same trade-off explanation. Added a
  brief design comment to `dashboard/server/routes/events.ts`.

- Readiness probe (`/readyz`) no longer reports not-ready when only one data source is
  unavailable (closes #55). The dashboard stays ready in degraded read-only mode as long
  as at least one of the control plane or Redis is healthy. Status is reported as
  `degraded` when one source is down, `ready` when both are up, and `not_ready` only
  when both are down.
- Tone down WCAG 2.1 AA claim in `docs/development/accessibility-audit.md` to match actual
  evidence: automated axe-core scanning covers primary views but a full manual audit is pending;
  checked items in the manual checklist are now annotated with rationale (closes #63)
- Expand accessibility E2E coverage in `dashboard/e2e/accessibility.spec.ts` to include model
  detail, worker detail, empty states (no models / no workers), deploy form, and the delete
  confirmation modal — previously only list pages and metrics were scanned
- Aligned dashboard Redis fallback schema with control-plane's actual Redis layout (closes #54):
  - Model reader now reads single JSON blobs at `{prefix}:models:{name}` instead of the
    incorrect multi-key schema (`models:state:*`, `models:worker:*`, `models:memory:*`, etc.)
  - Worker lister now scans `{prefix}:worker:*:detail` snapshots (preferred) or falls back to
    `{prefix}:workers:*:info` keys with heartbeat-based status derivation, instead of scanning
    `{prefix}:workers:*` and requiring `workerId` in the JSON payload
  - Cluster status memory summation now defaults missing `memoryUsedBytes`/`memoryAvailableBytes`
    to 0 to avoid NaN sums from worker records that only carry `memoryTotalBytes`
  - Added 22 integration-style tests seeding Redis with control-plane-compatible data to verify
    the fallback behavior end to end
- Dashboard BFF now enforces secure auth defaults at startup (closes #53):
  - `AUTH_MODE=none` is rejected in production (`NODE_ENV=production`) — the server
    will not start without explicit authentication configured
  - `AUTH_MODE=simple` requires `ADMIN_PASSWORD` to be explicitly set and non-empty,
    regardless of environment — prevents unauthenticated admin access on misconfigured
    deployments
  - Development mode logs a prominent warning when running with `AUTH_MODE=none`
  - Updated `docs/usage/deployment-security.md` with required environment variables
    per auth mode and example production configuration
- UI-level authorization for read-only users (closes #61): `AuthContext` now exposes an
  `isAdmin` boolean derived from the user's `admin` role. Mutating controls — Deploy button,
  bulk-action toolbar, per-row action menu (sleep/wake/delete), and the `/models/deploy` route
  — are hidden or redirect when `isAdmin` is false (i.e. for `admin-readonly` users). A new
  `AdminRoute` wrapper in `App.tsx` redirects read-only users navigating directly to
  `/models/deploy` back to `/models`. 28 new unit tests cover the `isAdmin` derivation,
  `AdminRoute` guard logic, and every visibility guard condition.

### Changed

- Moved 14 `.v1.tsx` / `.v1.ts` reference files from `dashboard/src/` to `dashboard/reference/v1/`
  (preserving subdirectory structure) to reduce search noise in the active source tree; removed
  now-redundant exclude patterns from `dashboard/tsconfig.app.json` (closes #65)

- Reconciled `docs/project/phase3.md` and `docs/architecture/components/dashboard.md` with the
  actual Phase 3 implementation (closes #52):
  - Checked all Definition of Done items and marked 11/12 complete; flagged redocly lint
    failures as a separate known issue
  - Corrected "Out of scope" auth statement — auth IS implemented (JWT, three modes)
  - Updated `MemoryBar` → `MemoryVisualization` throughout; added `DegradedBanner` to
    shared-components tables
  - Updated SSE relay description: BFF subscribes to `{prefix}:routing-updates` Redis
    channel per client (not the control plane SSE endpoint)
  - Updated SSE connection-status enum: `connected | reconnecting | degraded`
    (was `connected | connecting | disconnected`); documented degraded-mode behavior
  - Updated pagination options: 10/20/50 per page (was 25/50/100)
  - Updated BFF config tables to include all auth env vars
  - Updated Prometheus integration table to reflect all 10 metric routes; added `7d → 3600s`
    time-range mapping
  - Updated accessibility section to reflect `@axe-core/playwright` E2E approach
  - Added new `Authentication`, `i18n`, and `Degraded Mode` sections to dashboard.md
  - Updated E2E testing strategy to document MockControlPlane / MockPrometheus harness

### Added

- UX enhancements to operator views across the admin dashboard (closes #51):
  - **ModelList**: client-side pagination (PatternFly `Pagination`, default 20 items/page,
    shown above and below the table); runner-type filter toolbar chip alongside the existing
    state filter; bulk-action toolbar with "Sleep selected" and "Delete selected" with
    confirmation modals; memory column replaced with an inline `Progress` bar (sm, green/yellow/red
    threshold at 80%/95%) plus text below
  - **ModelDetail**: state-history timeline section showing the deployed timestamp and the
    most recent state-change timestamp (uses `createdAt` and `stateChangedAt`); faster polling
    in `useModel` — interval drops from 5 s to 2 s when the model is in `STARTING` or `PENDING`
    state so loading-progress bars update promptly
  - **WorkerDetail**: per-device model breakdown inside each `DeviceCard` — shows model names
    and memory used for single-GPU workers; falls back to the flat running-models table for
    multi-GPU workers (API does not expose per-device placement for multi-GPU models)
  - **MemoryVisualization**: each device bar now has PatternFly `Tooltip` on the whole bar
    (and on individual segments) showing exact bytes + percentage; clicking a bar expands an
    inline detail panel with used/reserved/available breakdown
  - New i18n keys added to `models.json` (pagination, bulk actions, runner filter, timeline),
    `workers.json` (deviceModels), `cluster.json` (clickToExpand), `common.json` (selectAll)

- Accessibility audit and i18n infrastructure for the dashboard (closes #48):
  - Installed `@axe-core/playwright` devDependency for automated WCAG 2.1 AA scanning
  - Created `dashboard/e2e/accessibility.spec.ts`: axe-core scans on all key pages
    (Cluster Overview, Model List, Model Deploy, Worker List, Metrics Dashboard)
    using the existing E2E mock harness; pages are pre-populated with mock data
  - Created `docs/development/accessibility-audit.md`: manual audit checklist covering
    keyboard navigation, screen reader, colour/contrast, chart accessibility, and forms
  - Installed `react-i18next`, `i18next`, and `i18next-browser-languagedetector`
  - Created `dashboard/src/i18n.ts`: i18next configuration with browser language
    detection, namespace-per-page pattern, English as default locale
  - Created English locale files (`dashboard/src/locales/en/`):
    `common.json`, `cluster.json`, `models.json`, `workers.json`, `metrics.json`, `auth.json`
  - Wired `./i18n` side-effect import into `dashboard/src/main.tsx`
  - Migrated all user-facing strings across 13 component/page files to `t()` calls:
    `AppLayout`, `DegradedBanner`, `MemoryVisualization`, `Login`, `OAuthCallback`,
    `ClusterOverview`, `ModelList`, `ModelDeploy`, `ModelDetail`,
    `WorkerList`, `WorkerDetail`, `MetricsDashboard`
  - Created `docs/development/i18n.md`: developer guide covering namespace conventions,
    usage patterns, interpolation, adding new strings, and adding new languages

- E2E test framework with mock service harness for the dashboard (closes #47):
  - `MockControlPlane` (`dashboard/e2e/mocks/control-plane.ts`): lightweight Fastify server
    on a random port serving all BFF-facing CP endpoints (`/api/v1/models`, `/api/v1/workers`,
    `/api/v1/cluster/status`, `/api/v1/cluster/memory`, `/healthz`) with configurable canned
    responses and an SSE endpoint that can push events on demand via `pushEvent()`; also
    supports stateful scenarios (model deploy, delete, sleep, wake)
  - `MockPrometheus` (`dashboard/e2e/mocks/prometheus.ts`): lightweight Fastify server
    serving `/api/v1/query_range` and `/api/v1/query` with pluggable response factories;
    includes helpers `latencyRangeFactory()` and `memoryInstantFactory()` for common scenarios
  - `Playwright fixtures` (`dashboard/e2e/fixtures.ts`): per-test fixture that starts
    MockControlPlane + MockPrometheus on random ports, spawns the BFF (via `tsx`) pointed at
    those mocks with `AUTH_MODE=none`, waits for readiness, and tears down cleanly; exports
    typed helpers `bffUrl()`, `MockControlPlane`, `MockPrometheus`
  - Updated `playwright.config.ts`: removed dev-server dependency, configured
    trace-on-retry and screenshot-on-failure, set sequential test execution to prevent
    port exhaustion
  - Fixed `navigation.spec.ts`: corrected h1→h2 element mismatch (the component renders
    `h2` not `h1`); added sidebar visibility, active nav-item highlighting for all pages,
    and 404 catch-all coverage
  - New `cluster-overview.spec.ts`: summary card presence and count verification from
    mock data, VRAM Usage / Model State Breakdown / Recent Events sections, All online /
    All clear label logic
  - New `models.spec.ts`: model table renders, empty state, deploy form field presence and
    validation, full deploy flow (form fill → submit → redirect), delete confirmation modal,
    cancel keeps model, model detail page
  - New `workers.spec.ts`: worker table, status labels (Online/Offline), empty state, worker
    detail page with device memory cards and running models, not-found handling
  - New `metrics.spec.ts`: page structure (heading, all 5 time-range buttons), default
    selection (1h), range switching, auto-refresh toggle, empty state with no data, chart
    section rendering with mock Prometheus data, error state when Prometheus is unreachable
  - New `sse.spec.ts`: Recent Events connection status label, waiting message, degraded
    mode resilience
  - New `auth.spec.ts`: none-mode (no login redirect), auth config endpoint, API
    accessibility without token, public health endpoints
  - Fixed pre-existing TypeScript compilation error: `import.meta.env` not recognised
    in worktrees without their own `node_modules` — `vite-env.d.ts` now includes an
    explicit `ImportMeta` / `ImportMetaEnv` augmentation as a fallback; also removed four
    now-redundant `as string | undefined` type assertions flagged by the linter

### Fixed

- SSE connection state machine with degraded polling fallback (closes #50):
  - `ConnectionStatus` type extended from `'connected' | 'connecting' | 'disconnected'` to
    `'connected' | 'reconnecting' | 'degraded'`
  - `useEventStreamConnection` now tracks consecutive failure count via `failureCountRef`; after 5
    failures (~25 s) the hook transitions to `'degraded'` state and slows reconnect attempts from
    5 s to 30 s to reduce noise
  - Successful reconnect from any state resets the failure count and restores `'connected'`
  - `EVICTION_TRIGGERED` event now also invalidates the `['metrics']` query key (was missing)
  - `PLACEMENT_COMPLETED` event invalidates `['models']`, `['workers']`, and `['cluster']`
    (previously also invalidated workers — now explicit)
  - `useModels`, `useModel`, `useWorkers`, `useWorker`, `useClusterStatus`, `useClusterMemory`
    all switch to a 2 s `refetchInterval` when SSE is `'degraded'` (vs. 5–10 s normally)
  - `MetricsDashboard` switches to 5 s `refetchInterval` when SSE is `'degraded'` and
    auto-refresh is on (vs. 30 s normally)
  - `DegradedBanner` now also shows "Real-time updates unavailable — polling for changes" when
    SSE is degraded; the Redis-fallback message ("Control plane unreachable — showing cached
    data") takes precedence as the more severe condition
  - `ClusterOverview` event feed label updated: `'Connecting…'` → `'Reconnecting…'`,
    `'Disconnected'` → `'Degraded'` to match new status values
  - 13 new unit tests covering the state machine transitions and threshold constants

- BFF resilience extended to cover all read routes with Redis fallback (closes #45):
  - `GET /api/cluster/memory` now falls back to Redis when the control plane is
    unreachable; returns 502 only when no cached snapshot is available
  - `GET /api/workers/:id` now falls back to Redis; returns 404 when no cached
    worker detail is available (matching the control plane's own 404 behaviour)
  - Control plane `MemoryBudgetService.refreshAll()` writes a per-device memory
    snapshot to `{prefix}:cluster:memory` (TTL 300s) after each budget refresh
  - Control plane `WorkerPoolService.checkHeartbeats()` writes each worker's full
    record to `{prefix}:worker:{workerId}:detail` (TTL 120s) after each heartbeat
    check, so dead workers expire quickly
  - BFF `RedisReader` gains `getClusterMemory()` and `getWorkerDetail(id)` methods
    to read the new control-plane-written snapshots
  - New `DegradedBanner` component (PatternFly 6 `Alert`, `variant="warning"`,
    `isInline`) shows "Control plane unreachable — showing cached data" when any
    active query returns `source: "redis-fallback"`; auto-dismisses on resume
  - New `DegradedContext` / `DegradedProvider` tracks which query keys are serving
    stale data; mounted in `App.tsx` wrapping the authenticated route subtree
  - All data hooks (`useModels`, `useModel`, `useWorkers`, `useWorker`,
    `useClusterStatus`, `useClusterMemory`) report fallback status to
    `DegradedContext` via `useEffect`
  - Dashboard architecture doc updated with full fallback coverage table

### Added

- Expanded metrics dashboard to a four-row layout with full metric coverage (closes #49):
  - **Row 1 — Request Traffic:** latency chart now shows p50/p95/p99 quantile lines (was p95
    only); throughput chart unchanged
  - **Row 2 — Connections & Parking:** active connections line chart, parked connections line
    chart (broken down by model label when available), and parking duration p50/p95 chart
  - **Row 3 — Model Lifecycle:** wake triggers rate chart, state transitions rate chart (broken
    down by `from→to` label pairs), and evictions rate chart (broken down by reason)
  - **Row 4 — Memory & Operations:** memory over time area chart, operation duration p95 chart
    (deploy/sleep/wake/eviction/placement), and existing device memory table (current instant values)
  - Time range selector extended with `7d` option (step: `3600s`)
  - Auto-refresh toggle (PatternFly `Switch`) — when off disables all `refetchInterval` timers;
    when on uses 30 s default
  - Seven new BFF routes in `dashboard/server/routes/metrics.ts`:
    `GET /api/metrics/connections`, `GET /api/metrics/parking-duration`,
    `GET /api/metrics/wake-triggers`, `GET /api/metrics/state-transitions`,
    `GET /api/metrics/evictions`, `GET /api/metrics/memory-history`,
    `GET /api/metrics/operations` — all accept `start`/`end`/`step` query params with
    same auth preHandlers as existing routes
  - Updated `GET /api/metrics/latency` to query p50/p95/p99 in parallel and return
    `{ p50, p95, p99 }` combined object (backward-incompatible response shape change)
  - Seven new API client methods in `api.metrics`, seven new hooks in `useMetrics.ts`,
    all accepting `refetchInterval` param for auto-refresh control
  - 24 new BFF route tests covering correct metric names, param forwarding, and 502 handling
    for each new endpoint

- Dashboard BFF auth system with three modes: `none`, `simple`, and `oauth`
  (`AUTH_MODE` env var, defaults to `none` for backward compatibility) (#43):
  - **Simple mode**: username/password login with timing-safe credential
    comparison, in-memory rate limiting, and JWT issuance
  - **OAuth mode**: OpenShift OAuth2 flow with CSRF state tokens, code exchange,
    user info fetching, and Kubernetes RBAC role resolution
  - JWT-based route protection with `authenticate` and `requireRole` decorators;
    admin role implies admin-readonly access
  - SSE query-parameter token fallback (`?token=...`) for EventSource clients
    that cannot send custom headers
  - Frontend `AuthContext` with auto-logout timer, sessionStorage token
    management, and `auth:unauthorized` event handling
  - Login page with conditional rendering: username/password form (simple) or
    SSO redirect button (oauth), built with PatternFly 6 `LoginPage` component
  - OAuth callback page for extracting token from URL fragment
  - Protected routing: unauthenticated users redirected to `/login`;
    `authMode=none` bypasses all auth checks
  - API client attaches `Authorization: Bearer` header automatically and
    dispatches logout event on 401 responses
  - Auth test suite covering login, credential rejection, JWT verification,
    role-based access control, query-parameter token fallback, and `none` mode

### Fixed

- SSE integration aligned with control plane event channel and payload shape (#44):
  - BFF now subscribes to `routing-updates` Redis channel (matching the control plane)
    instead of the non-existent `events` channel
  - BFF transforms `RoutingMapUpdate` payloads into `ClusterEvent` shape before relaying
    to the frontend, mapping `RoutingMapUpdateType` values to `ClusterEventType`
  - `useEventStream()` moved from `ClusterOverview` to app scope via React context so all
    pages benefit from real-time SSE updates and query invalidation
- BFF memory metrics endpoint now queries `sardeenz_control_plane_device_memory_bytes`
  (was `sardeenz_device_memory_bytes`, which the control plane does not export); verified
  proxy metric names `sardeenz_proxy_request_duration_seconds_bucket` and
  `sardeenz_proxy_requests_total` match Rust proxy exports; added BFF metrics route
  tests to prevent metric name regressions (closes #46)
- Cross-model review fixes for Phase 3 dashboard:
  - SSE event stream now handles `EVICTION_TRIGGERED` and `PLACEMENT_COMPLETED` events
    (previously caused stale UI until next poll cycle)
  - Metrics time range no longer goes stale — `buildFreshParams` computes timestamps at
    fetch time instead of memoizing them once
  - SSE route writes 200 headers only after Redis subscribe succeeds, returns 502 on failure;
    cleanup guard prevents double invocation; `reply.hijack()` called before raw writes
  - `formatBytes` guards against negative values and clamps unit index to prevent overflow
  - `JSON.parse` result in deploy form validated as object (rejects primitives/arrays)
  - Added 404 catch-all route and React `ErrorBoundary` to prevent blank/white screens
  - SPA fallback no longer serves `index.html` for mistyped `/api/*` paths (returns JSON 404)
  - Zero-worker cluster shows grey "No workers" instead of red "0 offline"
  - `Content-Type: application/json` only set on requests with a body (not GET/DELETE)
  - `res.json()` in BFF control plane client wrapped in try/catch for non-JSON responses
  - Redis fallback catch blocks only catch `BffError` (upstream errors), not programming errors
  - Health probe checks run in parallel via `Promise.all` instead of sequentially
  - Deduplicated `BASE_URL` — `useEventStream` imports from `api/client` instead of
    re-deriving from `import.meta.env`

### Added

- Accessibility audit (Task 3.12) — WCAG 2.1 AA compliance fixes: event feed uses semantic
  `<ul>/<li>` list with `aria-live="polite"` for screen reader announcements; SSE connection
  status wrapped in `aria-live="polite"` region; form error messages linked to inputs via
  `aria-describedby` with unique IDs on HelperTextItem components; table headers in metrics
  dashboard use `scope="col"` for assistive technology; event timestamps include full ISO
  date-time in `title` attribute; redundant `aria-label` removed from Switch component;
  Vitest config excludes `e2e/` directory to avoid Playwright/Vitest test runner conflicts
- Playwright E2E test infrastructure for the admin dashboard — `playwright.config.ts` with Vite
  dev server integration (reuse existing server, 30s test timeout, HTML reporter, trace/screenshot
  on failure); 5 spec files under `dashboard/e2e/` covering navigation, cluster overview, model
  management, workers, and metrics; `tsconfig.e2e.json` for the e2e include path;
  `test:e2e` script in `dashboard/package.json`; `dashboard/e2e/` and
  `dashboard/playwright.config.ts` added to ESLint ignores so they run cleanly from the host
- `MemoryVisualization` component — reusable card at `dashboard/src/components/MemoryVisualization.tsx`
  showing per-worker, per-device GPU memory as proportionally accurate stacked horizontal bars
  (Used in blue, Reserved in orange, Available in light gray), with inline Used/Total byte labels,
  native `title` hover tooltips per segment, color-coded legend, loading spinner, and empty state;
  integrated into Cluster Overview below the aggregate VRAM donut chart as a per-worker breakdown
- Model Detail view (Task 3.8) — full detail page at `/models/:modelName` with breadcrumb
  navigation, DescriptionList of all model fields, conditional action buttons (sleep/wake/delete),
  PF6 Progress bar for STARTING state with phase/message display, danger Alert for ERROR state
  with retry action, expandable engine config CodeBlock, and confirmation modals
- Worker pages (Task 3.9) — worker list at `/workers` with PF6 Table (ID, status, devices,
  memory, models, heartbeat); worker detail at `/workers/:workerId` with breadcrumb, status
  header, device memory cards (Gallery with Progress bars per GPU), running models table,
  and expandable runner capabilities section
- Model Management pages (Task 3.7) — model list at `/models` with PF6 Table, sortable columns,
  multi-select state filter, kebab dropdown actions (sleep/wake/delete with confirmation modals),
  empty state with deploy button; deploy form at `/models/deploy` with all fields (model name,
  runner type, model path, required memory in GiB, device type, tensor parallelism, pinned switch,
  engine config JSON), inline validation, GiB→bytes conversion, and navigation on success/cancel
- Cluster Overview page (Task 3.6) — full implementation of `/` landing page with four summary
  cards (Workers online/total with green/red status label, Models with active/sleeping counts,
  GPU Memory with PF6 `Progress` bar and available bytes, Alerts with error model + offline worker
  counts); `ChartDonut` from `@patternfly/react-charts/victory` for VRAM used/available donut
  with inline legend; model state breakdown card listing all `ModelLifecycleState` values with
  colored `StateLabel` and counts; live recent-events feed (last 20) from `useEventStream()` with
  formatted relative timestamps, colored event-type `Label`, and SSE connection status indicator;
  loading spinner and error `Alert` states; PF6 semantic design tokens throughout
- Metrics Dashboard page (Task 3.11) — full implementation of `/metrics` with PF6 `ToggleGroup`
  time range selector (15m/1h/6h/24h, default 1h), `@patternfly/react-charts` line charts for
  request latency (p95) and throughput, device memory summary table, and proper loading/empty
  states; Prometheus range/instant response parsing with TypeScript type guards; step size
  auto-selected per time range; `ChartVoronoiContainer` hover tooltips; `formatBytes` for memory
- Dashboard container image (Task 3.14) — multi-stage Dockerfile at `containers/dashboard/`
  building frontend (Vite) and BFF (TypeScript) into a single image; `@fastify/static` serves
  the SPA from `dist/client/` in production with SPA fallback routing; HEALTHCHECK on `/healthz`
- Dashboard design document (Task 3.13) — architecture narrative at
  `docs/architecture/components/dashboard.md` covering BFF pattern, data flow, Redis fallback,
  SSE relay, state management, configuration, and testing strategy
- Dashboard BFF data aggregation layer (Task 3.4) — fleshed out `ControlPlaneClient` with typed
  methods (`listModels`, `getModel`, `deployModel`, `deleteModel`, `sleepModel`, `wakeModel`,
  `listWorkers`, `getWorker`, `getClusterStatus`, `getClusterMemory`) that wrap `proxyRequest`
  and throw `BffError.upstreamError()` on network failures; `RedisReader` with SCAN-based model
  enumeration, worker reconstruction from JSON hash, and `getClusterStatus()` aggregation for
  resilience fallback; `PrometheusClient` with `queryRange` and `queryInstant` methods; route
  handlers for `GET /api/models`, `GET /api/models/:name`, `GET /api/workers`, and
  `GET /api/cluster/status` now fall back to Redis direct reads when the control plane is
  unreachable; `GET /api/events` SSE relay subscribes to `{prefix}:events` Redis pub/sub channel
  and forwards events to frontend clients with 30-second keepalive pings; `GET /api/metrics/*`
  routes issue range and instant Prometheus queries; 17 new unit tests (10 client, 7 route)
- Dashboard frontend data fetching layer (Task 3.5) — typed API client (`src/api/client.ts`)
  with `ApiError`, TanStack Query hooks for cluster, models, workers, and metrics, SSE event
  stream hook with automatic reconnect and query invalidation (`useEventStream`), formatting
  utilities (`formatBytes`, `formatRelativeTime`, `formatDateTime`, `formatPercentage`),
  state-color mapping for PF6 Label, `StateLabel` shared component, and `vite-env.d.ts` for
  `import.meta.env` typing; 59 unit tests across 4 test files all passing
- Dashboard frontend scaffold — Vite + React 18 + PatternFly 6 + React Router + TanStack Query
  with app shell (masthead, sidebar nav, page routing), placeholder pages for all 7 views
  (cluster overview, models, workers, metrics), Vitest config, and TypeScript strict mode
- Dashboard backend-for-frontend (BFF) scaffold — Fastify service with control plane API proxy
  routes, Redis/Prometheus client stubs, health probes (`/healthz`, `/readyz`), structured
  logging, error handling, and graceful shutdown; follows control plane patterns
- v1 component inventory and mapping document (`docs/project/v1-component-mapping.md`) — catalogs
  all reusable components from the v1 dashboard with port verdicts, data model mapping
  (v1 types → v2 `@sardeenz/types`), and state color mapping
- Phase 3 project plan (`docs/project/phase3.md`) — 15-task breakdown for the admin
  dashboard with v1 component reuse-first approach: inventory and port v1 UI components,
  frontend (React + PatternFly 6 + Vite), backend-for-frontend (Fastify BFF), device memory
  visualization, metrics dashboard, Playwright E2E tests, and container images
- Proxy writes per-model inference timestamps to Redis (`SET {prefix}:inference:last:{model}`)
  on each routed request, with a 5-second local debounce to minimize overhead. Gives the
  control plane's LRU eviction engine a real recency signal (ADR-014, #39)
- Document worker agent / runner / engine three-layer process architecture in
  `docs/architecture/overview.md` — process tree, communication channels, and
  Lmod environment isolation rationale (#31)

### Changed

- Phase 2 (control plane sleep/wake orchestration) marked complete — 18/18 tasks done,
  128 unit tests + 7 integration tests passing

### Fixed

- LRU eviction now reads per-model inference timestamps from Redis (`{prefix}:inference:last:{model}`)
  written by the proxy, giving the eviction engine a real recency signal instead of random
  ordering. See ADR-014 for the design decision (#37)
- Control plane Dockerfile COPY instructions no longer use invalid shell redirection
  (`2>/dev/null || true`); optional workspace-local `node_modules` dirs are guaranteed to
  exist via `mkdir -p` in the deps stage so plain COPY always succeeds (#33)
- Placement pipeline now excludes DEGRADED and OFFLINE workers as the first filter stage,
  preventing unhealthy workers from being selected for model placement (#35)
- Readiness probe (`/readyz`) now returns 503 for follower instances when leader election
  is enabled, ensuring Kubernetes endpoints exclude followers from orchestration traffic
  (closes #36)
- `MemoryBudgetService.refreshAll()` and `refreshWorkerBudget()` no longer clear all
  in-flight reservations on every reconciliation tick. Reservations are now cleared
  per-device only when the worker's fresh memory report shows `usedBytes >= reservedBytes`,
  meaning the allocation has been accounted for. Reservations for in-flight deploys (runner
  starting, worker not yet reporting) are preserved, closing the overcommit window that
  allowed double-placement onto the same capacity (closes #34).
- Internal wake route (`POST /api/v1/wake`) now enforces leader gate and atomically
  claims `SLEEPING → STARTING` via CAS before launching background work, preventing
  thundering herd from concurrent proxy wake triggers and follower-instance wake
  processing (#32)
- Deployment security documentation (`docs/usage/deployment-security.md`) documenting the
  network isolation requirement for Phase 2 (no auth until a later phase)
- Readiness probe (`/readyz`) now reports leader-election status in the response
- Prometheus gauge metrics (`modelsTotal`, `workersTotal`, `deviceMemoryBytes`) are now
  populated with real values on every reconciliation tick instead of remaining at zero
- Leader-election lease operations now use Kubernetes `resourceVersion` for optimistic
  concurrency, preventing split-brain from concurrent lease updates; 409 conflicts are
  detected explicitly
- Kubernetes service account token loading uses ESM-compatible `readFileSync` import
  instead of `require('node:fs')`
- `stopModel()` now handles all lifecycle states correctly — PENDING and STARTING
  route through ERROR before reaching STOPPED instead of attempting invalid transitions
- Wake and sleep routes atomically claim their transitional state (STARTING / DRAINING)
  before launching background work, preventing concurrent request races
- Eviction engine now wired into deploy and wake flows: insufficient capacity triggers
  LRU eviction of idle models before failing with placement error
- Eviction candidates now use actual `requiredMemory` from model metadata instead of
  hardcoded zero bytes, fixing freed-capacity accounting
- Memory-budget staleness now uses worker-reported `reportedAt` timestamp instead of
  control-plane read-time, making staleness detection accurate for batched/delayed reports
- In-flight memory reservations are cleared on budget refresh (`refreshAll` and
  `refreshWorkerBudget`), preventing phantom reservations from accumulating after model
  stop/delete/failure

### Added

- Integration test infrastructure for control plane (`control-plane/src/__tests__/integration/`):
  test harness wiring real Redis (DB 1) and PostgreSQL with per-test key prefixes, in-process
  mock runner and worker Fastify servers, `canConnect()` skip guard, and dedicated vitest config
  (`vitest.integration.config.ts`). Three test suites: deploy orchestration (happy path +
  timeout), sleep/wake round-trip with CAS thundering-herd prevention, and worker discovery
  with routing map consistency across deploy/sleep/wake lifecycle (#38)
- PostgreSQL service added to `compose.yaml` for integration test and local dev use
- Control plane reconciliation loop (`control-plane/src/services/reconciliation.ts`):
  `ReconciliationService` runs a leader-only background loop (default 30s interval) that
  re-discovers workers, checks heartbeats, cleans up dead workers (transitions their models
  to ERROR and removes routing), refreshes memory budgets, and recovers models stuck in
  transitional states past their timeout. Detects leader promotion for full state rebuild.
  Includes Prometheus metrics for tick count, duration, dead workers, stuck models, and
  per-step errors.
- Control plane core services (`control-plane/src/services/`):
  - `ModelRepository`: PostgreSQL CRUD for model configuration
  - `ModelLifecycleService`: Redis-backed state machine with atomic CAS transitions via Lua scripts
  - `MemoryBudgetService`: in-memory VRAM budget tracker with per-device reservations and staleness detection
  - `WorkerPoolService`: Redis SCAN-based worker discovery with three-tier heartbeat status (ONLINE/DEGRADED/OFFLINE)
  - `RoutingMapService`: Redis hash-backed routing map with atomic MULTI/EXEC writes and pub/sub notifications
  - `PlacementPipeline`: four-stage workload placement (runner type → hardware → capacity → strategy)
  - `EvictionEngine`: LRU eviction with circuit breaker, max-per-cycle limit, pinned model exclusion, minimum active time
  - `SleepWakeService`: sleep/wake coordination driving ACTIVE→DRAINING→SLEEPING and SLEEPING→STARTING→ACTIVE transitions
  - `LeaderElectionService`: K8s Lease API leader election with local dev mode fallback
- Control plane database migrations (`control-plane/migrations/001-initial-schema.sql`):
  models, memory_profiles, benchmarks, and settings tables with migration runner
- Control plane deploy orchestration (`control-plane/src/services/deploy-orchestration.ts`):
  `DeployOrchestrationService` drives models from STARTING → ACTIVE by calling the worker
  management API to start a runner, polling runner health until READY, registering the
  endpoint in the routing map, and transitioning to ACTIVE (with ERROR fallback and
  capacity reservation release on failure)
- Control plane HTTP clients (`control-plane/src/clients/`):
  runner HTTP client wrapping engine runner contract endpoints, worker management HTTP
  client for starting/stopping runners on workers, SQL migration runner
- Control plane HTTP route handlers (`control-plane/src/routes/`):
  model CRUD (deploy/list/get/delete/sleep/wake), worker list/get, cluster status/memory,
  SSE event stream, internal proxy wake trigger and routing map read endpoints
- Full service wiring in control plane entry point: all services instantiated,
  leader election started, worker discovery and memory budget refresh on startup
- Control plane container image (`containers/control-plane/Dockerfile`):
  multi-stage build (deps → build → runtime), non-root user, Node.js 22 slim base
- Control plane test suite (54 tests): config loading and URL redaction, error hierarchy
  serialization, state machine transition validation (16 valid + 8 invalid transitions),
  placement pipeline (runner type/hardware/capacity/TP filtering, spread strategy, stale budget
  rejection), LRU eviction engine (ordering, pinned exclusion, min-active-time, max-per-cycle,
  circuit breaker)
- Control plane admin API OpenAPI spec (`packages/contracts/specs/control-plane.yaml`):
  model lifecycle CRUD (deploy/sleep/wake/delete), worker management, cluster state/memory,
  SSE events stream, `ModelLifecycleState` enum (8 states), `WorkerStatus` and `ClusterEventType` enums
- Generated TypeScript types from control plane spec (`packages/types/src/generated/control-plane.ts`)
- Control plane Fastify scaffold (`control-plane/src/`): config from env vars, typed error hierarchy
  (`ControlPlaneError` with error codes), Redis/PostgreSQL/runner HTTP clients, Prometheus metrics
  (13 metrics: models, workers, memory, placement, eviction, sleep/wake, state transitions, leader),
  health probes (`/healthz`, `/readyz`), structured JSON logging, graceful shutdown
- Phase 2 project plan (`docs/project/phase2.md`): detailed task breakdown for control plane sleep/wake orchestration — 18 tasks covering OpenAPI specs, Fastify scaffold, PostgreSQL schema, model lifecycle state machine, placement pipeline, LRU eviction, sleep/wake coordination, routing map management, worker pool, leader election, health/metrics, container image, and integration tests
- Backward-compatibility policy in ADR-005: semver rules for pre-1.0 specs, breaking vs. non-breaking change definitions, simultaneous rollout guarantee, version mismatch detection via startup logging (#13)
- Runner BUSY state routing mapping in runner contract docs: BUSY sets endpoint weight to 0 (model stays ACTIVE, endpoint stays healthy), full RunnerState-to-ModelState mapping table (#14)
- ADR-013: Secrets management policy — env-var sourcing, naming convention with greppable suffixes, log sanitization rules, reference to proxy's `redact_url()` pattern (#21)

### Changed

- Adopted `dev`/`main` branching strategy: `dev` is the integration branch, `main` is releases only

### Fixed

- SSE event stream now creates per-connection Redis subscriber via `subscriber.duplicate()` and calls `reply.hijack()` before writing to raw socket — prevents cross-client message leaks and Fastify warnings
- Model deploy endpoint now rolls back DB record and Redis state on placement failure, validates request body types at runtime, and catches PostgreSQL unique constraint violations for race-safe duplicate detection
- Database migrations now execute at startup (were imported but never called)
- State transition metric (`stateTransitionsTotal`) now labels `from` correctly — Lua script returns `currentState|encoded` instead of only the new state
- `ModelLifecycleService.getAllStates()` and `MemoryBudgetService.refreshAll()` now use SCAN instead of `KEYS *` to avoid blocking Redis in production
- `WorkerPoolService.infoScanPattern()` now uses configurable `keyPrefix` instead of hardcoded namespace
- `updateLastInference` now uses atomic Lua script instead of non-atomic GET-then-SET, preventing state clobber on concurrent transitions
- `createModel` now uses `SET NX` for atomic existence check, preventing TOCTOU race on duplicate model creation
- `RoutingMapService.addEndpoint/removeEndpoint/updateEndpointHealth` now use Lua scripts for atomic read-modify-write, preventing concurrent endpoint list corruption
- K8s service account token now re-reads from disk every 60s instead of caching forever, preventing auth failures after projected token rotation
- Internal `/api/v1/wake` response now includes required `accepted` field and uses `currentState` field per proxy-control-plane spec contract
- `delay()` helper in sleep-wake service now cleans up abort listener when timer fires normally, preventing listener accumulation during long polling loops
- OpenAPI validation script now fails on lint errors instead of silently swallowing them (#1)
- Readiness probe now requires both Redis connection AND successful routing map load (#4)
- Response hop-by-hop headers now filtered symmetrically with request-side filtering (#9)

### Added

- Redis integration tests behind `redis-integration` feature flag (#5):
  `test_redis_bootstrap`, `test_redis_pubsub_refresh`, `test_redis_malformed_entry`,
  `test_redis_readiness_lifecycle` — each uses UUID-scoped key prefix for isolation
- Configurable Redis key prefix (`SARDEENZ_REDIS_KEY_PREFIX`, default `sardeenz`) for test isolation (#5)
- Request-level tracing with request ID correlation (#6): generates or propagates
  `X-Request-ID` header, structured JSON log per request (method, path, status, latency)
- Prometheus metric recording at all proxy call sites (#3):
  - `sardeenz_proxy_requests_total` (counter with status label)
  - `sardeenz_proxy_request_duration_seconds` (histogram)
  - `sardeenz_proxy_active_connections` (gauge)
  - `sardeenz_proxy_parked_connections` (gauge with model label)
  - `sardeenz_proxy_wake_triggers_total` (counter with result label)
  - `sardeenz_proxy_parking_duration_seconds` (histogram)
  - `sardeenz_proxy_circuit_breaker_state` (gauge with endpoint label)

### Changed

- Rust types in `proxy/src/generated/` now documented as hand-maintained (not auto-generated) (#2)
- Updated ADR-005, architecture overview, and Phase 1 docs to reflect actual Rust type workflow
- Extracted `ProxyError::status_code()` method for metrics and reuse (#3)
- Added Security and Trust Model section to proxy architecture docs (#7, #18, #20)
- Added configurable upstream request timeout (`SARDEENZ_UPSTREAM_TIMEOUT_SECS`, default 300s) (#8)
- Updated Phase 1 docs with upstream timeout, Redis key prefix, hop-by-hop filtering, and Redis integration test details
- Updated CLAUDE.md to clarify Rust types are hand-maintained (not generated)
- Added `SARDEENZ_REDIS_KEY_PREFIX` to proxy configuration reference table
- Default proxy admin port from 9090 to 9099 to avoid conflict with Cockpit on Fedora/RHEL
- Suppress Redocly `no-unused-components` warning for `RoutingMapUpdate` schema (reserved for Phase 2 pub/sub)

### Added

- `/implement` skill (`.claude/skills/implement.md`): full quality development process
  for phases and features — plan, implement, cross-model review/fix loop, verify
- Project scaffolding: monorepo structure, architecture docs, ADRs
- Development tooling: TypeScript, ESLint, Prettier, Vitest, Redocly
- OpenAPI contract workflow with codegen pipeline
- Build infrastructure: Makefile, npm workspaces, tsconfig project references
- README index in every `docs/` directory for GitHub navigation
- Documentation rule: every Markdown file must be linked from its parent README
- Comprehensive project plan with deliverables, definitions of done, risks, and dependencies for all five phases
- CLAUDE.md: project status, workflow rules (CHANGELOG, npm, commit hygiene)
- Phase 0 planning document with task breakdown, scope, and open questions
- Engine runner contract OpenAPI spec (`packages/contracts/specs/engine-runner.yaml`):
  7 endpoints across 5 interface areas (health, memory, sleep/wake, progress, capabilities),
  5-state runner model (STARTING, READY, BUSY, SLEEPING, ERROR), per-device memory reporting,
  extensible sleep levels, structured loading progress, capability declaration for placement
- Generated TypeScript types from runner contract (`packages/types/src/generated/engine-runner.ts`)
- Runner contract design document (`docs/architecture/components/runner-contract.md`):
  state model with Mermaid diagram, communication patterns, scenario validation (vLLM/Triton/MLServer)
- Architecture components directory (`docs/architecture/components/`)
- Phase 1 planning document with 12-task breakdown for the Rust proxy (`docs/project/phase1.md`)
- Podman Compose dev environment (`compose.yaml`) with Valkey 8 for Redis-compatible state store
- Makefile targets `services` and `services-stop` for dev service lifecycle
- Proxy ↔ control plane OpenAPI spec (`packages/contracts/specs/proxy-control-plane.yaml`):
  wake trigger API (`POST /api/v1/wake`), routing map bootstrap (`GET /api/v1/routing-map`),
  routing map schema (Redis hash at `sardeenz:routing-map` with pub/sub on `sardeenz:routing-updates`),
  5-state model routing model (ACTIVE, SLEEPING, STARTING, DRAINING, ERROR)
- Generated TypeScript types from proxy-control-plane spec
  (`packages/types/src/generated/proxy-control-plane.ts`)
- Hand-written Rust types matching both OpenAPI specs (`proxy/src/generated/`):
  engine runner types and proxy-control-plane types with serde derives
- Rust routing proxy implementation (`proxy/src/`):
  - axum-based HTTP server with separate proxy (8080) and admin (9099) ports
  - Request routing via in-memory routing map cache refreshed by Redis pub/sub
  - OpenAI-compatible endpoints: `/v1/chat/completions`, `/v1/completions`, `/v1/models`
  - Connection parking with configurable timeout (default 120s) and backpressure limits
  - Thundering herd prevention: first request fires wake trigger, subsequent requests park
  - Weighted round-robin load balancing across runner replicas
  - Per-endpoint circuit breaker (configurable failure threshold, window, recovery timeout)
  - Prometheus metrics endpoint on admin port (`/metrics`)
  - Health endpoints (`/healthz`, `/readyz`) on admin port
  - Structured JSON logging via tracing-subscriber
  - Graceful shutdown on SIGTERM/SIGINT
- Structured output compatibility research document
  (`docs/architecture/components/structured-output-compatibility.md`):
  vLLM version compatibility matrix, proxy passthrough recommendation
- Multi-stage Dockerfile for the routing proxy (`proxy/Dockerfile`):
  musl static build, distroless runtime, non-root user, health check
- `.dockerignore` for the proxy (`proxy/.dockerignore`)
- Routing proxy design document (`docs/architecture/components/proxy.md`):
  request flow with Mermaid sequence diagrams (active/sleeping/multi-replica), connection parking
  protocol (thundering herd prevention, timeout/backpressure limits), routing map Redis key
  structure and refresh strategy, circuit breaker state machine, full configuration and metrics
  reference tables, health endpoint semantics, proxy ↔ control plane responsibility split
- Integration test suite for the Rust proxy (`proxy/tests/integration/`):
  26 tests across 13 scenarios exercising request forwarding, SSE streaming, sleep/wake cycle,
  thundering herd deduplication, unknown model 404, missing/invalid model 400, parking timeout 503,
  parking limit enforcement (per-model and global), wake trigger failure, draining/error model
  states, circuit breaker trip/recovery/5xx, weighted round-robin, `/v1/models` aggregation,
  and health/readyz endpoints; runs without Redis using direct RoutingMapCache injection;
  mock axum servers for runner and control plane
- Shared handler module (`proxy/src/handlers.rs`) — handler functions extracted from binary
  crate for reuse by both production `main.rs` and integration tests

### Fixed

- Proxy: missing/invalid `model` field now returns HTTP 400 (`invalid_request_error`)
  instead of 500; invalid JSON body returns 400 instead of 500
- Proxy: `RoutingEntryMetadata` preserves unknown fields via `serde(flatten)` to match
  OpenAPI `additionalProperties` contract
- Proxy: `ForwardingClient` eliminates double-buffering — accepts `Bytes` directly,
  preserves query string via `path_and_query()`, filters hop-by-hop headers
- Proxy: circuit breaker HalfOpen state limits to single probe request (prevents
  stampede); `record_failure()` in HalfOpen immediately re-opens circuit;
  `current_state()` is now read-only (no side effects)
- Proxy: weighted round-robin balancer uses cumulative weight algorithm — O(n),
  zero heap allocation, weight capped at 100
- Proxy: parking manager cleans up `pending_wakes` on timeout exit path (prevents
  permanent stuck state); `reserve_slot()` atomically checks+increments under
  single mutex (TOCTOU fix); uses `SeqCst` ordering throughout
- Proxy: Redis sync subscribes to pub/sub channel before initial `HGETALL` to
  avoid missing updates during the load window
- Proxy: `redis_connected` flag uses `Acquire`/`Release` ordering instead of `Relaxed`
- Proxy: graceful shutdown uses `watch::channel` for coordinated signal to both
  servers and Redis sync task; proper drain sequence (signal → join servers → await Redis)
- Proxy: Redis URL credentials redacted in startup log output

### Changed

- CLAUDE.md project status now links directly to phase0.md for current work
- Aligned runner contract spec filename to `engine-runner.yaml` across all docs
- `packages/types/src/index.ts` re-exports generated engine runner types and enums
- `packages/types/package.json` codegen script now generates from engine-runner.yaml
- `packages/contracts/redocly.yaml` disables rules inappropriate for internal contracts
  (no-empty-servers, security-defined, info-license)
