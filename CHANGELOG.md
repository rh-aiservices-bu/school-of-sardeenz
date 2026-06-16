# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

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
