# Phase 3 — Admin Dashboard

## Goal

Build a web-based administration interface where operators can deploy and manage models, monitor GPU memory utilization, and observe cluster health — all in real time. This is the first user-facing surface of the platform and the primary tool operators use day-to-day.

Phase 3 depends on Phase 2's control plane API for orchestration commands and real-time events, Phase 1's proxy for serving inference traffic to deployed models, and the shared Redis/Valkey state store for resilient direct reads. The dashboard uses React 18 + PatternFly 6, but it is **not** built from scratch — the Sardeenz v1 dashboard is a functional React + PatternFly application covering the same domain (model management, GPU memory visualization, cluster monitoring), and v1 components should be **reused directly** wherever possible. The default approach is to port v1 components to the v2 data model and upgrade PatternFly imports from v5 to v6; only build new when v1 has no equivalent or when the v2 data model diverges so far that porting costs more than rebuilding.

## Scope

### In scope

The dashboard covers two deployable units — a frontend SPA and a backend-for-frontend (BFF) — across seven functional areas:

1. **App shell and navigation** — PatternFly 6 page layout with sidebar navigation, breadcrumbs, client-side routing (React Router), and responsive breakpoints
2. **Cluster overview** — aggregate GPU memory utilization, worker status cards, model counts by lifecycle state, real-time event feed
3. **Model management** — deploy new models via a form, list all models with state and memory usage, sleep/wake/delete actions with confirmation, loading progress during startup
4. **Worker detail** — per-worker view with per-device GPU memory breakdown, running models, hardware capabilities
5. **Device memory visualization** — graphical representation of VRAM allocation across devices and workers (port from v1)
6. **Metrics dashboards** — inference latency, throughput, and device utilization charts backed by Prometheus queries
7. **Real-time updates** — SSE subscription from the control plane's event stream, live state transitions, memory updates without page refresh

### Out of scope

- **User management / RBAC** — future phase; the dashboard does not enforce authentication or authorization in this phase (integration point TBD)
- **Multi-cluster views** — single cluster only
- **Custom alerting rules** — Prometheus/Alertmanager handle this externally
- **Non-OpenAI protocol management** — only models served through the OpenAI-compatible proxy
- **Log aggregation** — no integrated log viewer; operators use external logging infrastructure
- **Mobile-first design** — the dashboard targets desktop browsers; responsive breakpoints are supported but not optimized for phones

## Approach

1. Inventory v1 dashboard components and port those that map to v2 views — reuse is the default, rebuild is the exception
2. Scaffold the frontend project (Vite + React 18 + PatternFly 6 + React Router + TypeScript) with the app shell
3. Scaffold the dashboard backend (Fastify BFF) with configuration, logging, and route structure
4. Implement BFF data aggregation — control plane API proxy, direct Redis reads for resilience, Prometheus client, SSE relay
5. Implement the frontend data fetching layer — API client, React hooks, SSE event stream subscription, error/loading states
6. Implement the cluster overview page — assemble from ported v1 summary cards and memory widgets
7. Implement model management — reuse v1 model table, deploy form, and status components; adapt to v2 API
8. Implement model detail view — port v1 detail panel; add v2-specific fields (progress, runner endpoint)
9. Implement worker detail page — reuse v1 per-device GPU memory cards and worker layout
10. Implement device memory visualization — port v1's VRAM visualization directly; adapt data bindings to v2
11. Implement metrics dashboard — reuse v1 chart components where available; new Prometheus integration
12. Accessibility audit — verify all views against WCAG 2.1 AA using PatternFly 6's built-in ARIA patterns
13. Write the dashboard design document
14. Build container images for frontend and BFF
15. Write Playwright E2E tests for critical admin workflows

## Tasks

| # | Task | Status | Output |
| --- | --- | --- | --- |
| 3.1 | Inventory and port v1 dashboard components | Complete | Ported components + v1 → v2 mapping notes |
| 3.2 | Scaffold dashboard frontend | Complete | Vite + React + PF6 app shell with routing |
| 3.3 | Scaffold dashboard backend (BFF) | Complete | Fastify service with config, logging, routes |
| 3.4 | Implement BFF data aggregation layer | Complete | Control plane proxy, Redis reader, Prometheus client, SSE relay |
| 3.5 | Implement frontend data fetching layer | Complete | API client, React hooks, SSE subscription |
| 3.6 | Implement cluster overview page | Complete | Worker status, aggregate memory, model counts |
| 3.7 | Implement model management page | Complete | Model table, deploy form, sleep/wake/delete actions |
| 3.8 | Implement model detail view | Complete | Full model info, loading progress, state timeline |
| 3.9 | Implement worker detail page | Complete | Per-device GPU memory, running models, capabilities |
| 3.10 | Implement device memory visualization | Complete | Graphical VRAM allocation across devices and workers |
| 3.11 | Implement metrics dashboard | Complete | Prometheus-backed latency, throughput, utilization charts |
| 3.12 | Accessibility audit | Complete | WCAG 2.1 AA compliance verified across all views |
| 3.13 | Write dashboard design document | Complete | `docs/architecture/components/dashboard.md` |
| 3.14 | Build container images | Complete | `containers/dashboard/Dockerfile` (frontend + BFF) |
| 3.15 | E2E test suite | Complete | Playwright tests for critical admin workflows |

## Task Details

### 3.1 — Inventory and Port v1 Dashboard Components

**Depends on:** v1 repo access ([github.com/rh-aiservices-bu/sardeenz](https://github.com/rh-aiservices-bu/sardeenz))

The v1 dashboard is a functional React + PatternFly application covering the same domain — model management, GPU memory visualization, cluster monitoring. Rather than building the v2 dashboard from scratch, this task inventories every v1 UI component and ports those that map to v2 views. **Reuse is the default; rebuilding from scratch is the exception** and requires a documented reason (e.g., v2 data model is fundamentally different, or the component relies on a v1-only backend feature).

**Step 1 — Component inventory:**

Walk the v1 source tree and catalog every reusable component, hook, utility, and layout pattern. For each, record:

- Component name and file path in v1
- What it does (one line)
- PatternFly version and components used (PF4? PF5?)
- Data dependencies (what v1 API endpoints / data shapes it consumes)
- **Port verdict:** `reuse` (copy and adapt), `reuse-with-changes` (port with v2 data model changes), or `rebuild` (too coupled to v1 internals)

**Step 2 — Data model mapping:**

Map v1 data types to v2 equivalents from `@sardeenz/types`:

| v1 concept | v2 equivalent | Mapping notes |
| --- | --- | --- |
| Model states | `ModelLifecycleState` enum | v2 adds `DRAINING`, `PENDING`; map v1 states |
| GPU memory per device | `DeviceInfo` schema | v2 adds `memoryReservedBytes` |
| Worker status | `WorkerStatus` enum | v2 adds `DEGRADED` |
| Deploy request fields | `ModelDeploymentRequest` | v2 adds `pinned`, `engineConfig` |

**Step 3 — Port components:**

For each component marked `reuse` or `reuse-with-changes`:

1. Copy the component source into `dashboard/src/components/` (or the appropriate page directory)
2. Upgrade PatternFly imports from v5 to v6 (`pf-v5-` → `pf-v6-`, deprecated component replacements)
3. Replace v1 data types with v2 types from `@sardeenz/types`
4. Replace v1 API calls with v2 hook signatures (actual hook implementation comes in Task 3.5)
5. Verify the component compiles and renders with mock data

**Expected reusable components** (verify during inventory):

- GPU memory bar / donut visualization (per-device)
- Model status badge / label with color mapping
- Model table with columns, sorting, filtering
- Deploy form fields and validation logic
- Worker card layout
- Cluster summary cards
- Status color mapping constants
- Memory formatting utilities (bytes → GiB display)
- Relative time formatting utilities

**Rebuild criteria** — only rebuild when:

- The v1 component is tightly coupled to v1's monolithic backend (single API surface vs. v2's multi-source BFF)
- The v1 component uses deprecated PatternFly APIs that have no v6 equivalent (not just renamed — actually removed)
- The v2 data model is structurally different enough that the component's core logic (not just types) needs rewriting

**Time-box:** 2 days per component for porting. If a port exceeds this, document why and rebuild.

**Output:** Ported components in `dashboard/src/`, plus a `docs/project/v1-component-mapping.md` file recording the inventory, port verdicts, and any rebuild rationale. This mapping document is a living reference for Tasks 3.6–3.11 — each page task should start by checking which ported components are available before building anything new.

### 3.2 — Scaffold Dashboard Frontend

**Depends on:** Task 3.1

Set up the frontend project at `dashboard/` with the build tooling, app shell, and navigation structure that all page implementations build on.

**Project setup:**

- Vite with React plugin and TypeScript
- React 18
- PatternFly 6 (`@patternfly/react-core`, `@patternfly/react-icons`, `@patternfly/react-table`, `@patternfly/react-charts`)
- React Router v6 for client-side routing
- Vitest for unit tests
- ESLint 9 (flat config) + Prettier
- TypeScript 5.x with `strict: true`
- npm workspace integration (`@sardeenz/dashboard`)

**App shell:**

PatternFly 6 `Page` layout with:

- `Masthead` — application title, user menu placeholder (auth integration TBD)
- `PageSidebar` with `Nav` — navigation items for each view:
  - Cluster Overview (`/`)
  - Models (`/models`)
  - Workers (`/workers`)
  - Metrics (`/metrics`)
- `PageSection` — main content area with breadcrumbs
- Active navigation item highlighting based on current route

**Client-side routing:**

| Path | Component | View |
| --- | --- | --- |
| `/` | `ClusterOverview` | Cluster overview (default landing) |
| `/models` | `ModelList` | Model management table |
| `/models/deploy` | `ModelDeploy` | Deploy form |
| `/models/:modelName` | `ModelDetail` | Model detail view |
| `/workers` | `WorkerList` | Worker list (redirects to overview if few workers) |
| `/workers/:workerId` | `WorkerDetail` | Worker detail view |
| `/metrics` | `MetricsDashboard` | Metrics charts |

**Module layout:**

```text
dashboard/
├── index.html
├── package.json
├── tsconfig.json
├── vite.config.ts
├── vitest.config.ts
├── eslint.config.js
├── src/
│   ├── main.tsx              # Entry point, React root
│   ├── App.tsx               # App shell, routing
│   ├── routes.tsx            # Route definitions
│   ├── api/                  # API client and hooks (Task 3.5)
│   ├── components/           # Shared components
│   │   ├── AppLayout.tsx     # Page + Sidebar + Masthead
│   │   ├── StateLabel.tsx    # Model state badge
│   │   ├── MemoryBar.tsx     # Memory usage bar
│   │   └── ...
│   ├── pages/                # Route-level page components
│   │   ├── ClusterOverview/
│   │   ├── Models/
│   │   ├── Workers/
│   │   └── Metrics/
│   ├── hooks/                # Custom React hooks
│   ├── types/                # Frontend-specific types
│   └── utils/                # Utility functions
└── public/
    └── favicon.svg
```

**Verification:** `npm run dev -w @sardeenz/dashboard` starts the Vite dev server. `npm run build -w @sardeenz/dashboard` produces a production build. `npm run lint` and `npm run typecheck` pass. The app shell renders with sidebar navigation and route transitions.

### 3.3 — Scaffold Dashboard Backend (BFF)

**Depends on:** Phase 2 control plane spec (`packages/contracts/specs/control-plane.yaml`)

Set up the backend-for-frontend service that aggregates data from the control plane API, Redis/Valkey, and Prometheus. The BFF exists for three reasons: (1) the dashboard needs data from multiple sources that should not be combined client-side, (2) the dashboard must remain functional during brief control plane restarts by reading Redis directly, and (3) the BFF is the future integration point for authentication.

**Configuration** (via environment variables):

- `SARDEENZ_BFF_LISTEN_ADDR` — listen address (default `0.0.0.0:4000`)
- `SARDEENZ_CONTROL_PLANE_URL` — control plane base URL (default `http://localhost:3000`)
- `SARDEENZ_REDIS_URL` — Redis/Valkey connection string
- `SARDEENZ_REDIS_KEY_PREFIX` — prefix for Redis keys (default `sardeenz`)
- `SARDEENZ_PROMETHEUS_URL` — Prometheus query API base URL
- `SARDEENZ_LOG_LEVEL` — log level (default `info`)
- `SARDEENZ_CORS_ORIGIN` — allowed CORS origin for the frontend (default `http://localhost:5173`)

**Module layout:**

```text
dashboard/server/
├── index.ts              # Entry point, config, server startup
├── config.ts             # Configuration from env vars
├── server.ts             # Fastify app setup, plugins, routes
├── routes/
│   ├── models.ts         # Model CRUD proxy → control plane
│   ├── workers.ts        # Worker queries → control plane + Redis
│   ├── cluster.ts        # Cluster status → control plane + Redis
│   ├── metrics.ts        # Metrics queries → Prometheus
│   └── events.ts         # SSE relay → control plane events
├── clients/
│   ├── control-plane.ts  # HTTP client for control plane API
│   ├── redis.ts          # Redis/Valkey client for direct reads
│   └── prometheus.ts     # Prometheus query API client
├── health/
│   └── probes.ts         # /healthz, /readyz
└── types/                # BFF-specific types
```

**Structured logging** — JSON via `pino` with request ID propagation.

**Error handling** — translate upstream errors (control plane 4xx/5xx, Redis timeouts, Prometheus unavailable) into consistent error responses. Surface partial results when some sources are unavailable (e.g., return cached model list with a `degraded: true` flag if the control plane is down but Redis is up).

**Graceful shutdown** — close SSE connections, drain in-flight requests, close Redis and HTTP connections.

**Verification:** `npm run build`, `npm run lint`, `npm run typecheck` pass. `npm run dev -w @sardeenz/dashboard` starts the BFF (or a combined dev script starts both frontend and BFF). Health endpoints respond.

### 3.4 — Implement BFF Data Aggregation Layer

**Depends on:** Task 3.3

Implement the three upstream clients and the route handlers that compose them.

**Control plane client** — typed HTTP client for the control plane API:

| BFF route | Upstream call | Behavior |
| --- | --- | --- |
| `POST /api/models` | `POST /api/v1/models` | Pass-through with validation |
| `GET /api/models` | `GET /api/v1/models` | Pass-through, fall back to Redis on CP failure |
| `GET /api/models/:name` | `GET /api/v1/models/{modelName}` | Pass-through, fall back to Redis on CP failure |
| `DELETE /api/models/:name` | `DELETE /api/v1/models/{modelName}` | Pass-through |
| `POST /api/models/:name/sleep` | `POST /api/v1/models/{modelName}/sleep` | Pass-through |
| `POST /api/models/:name/wake` | `POST /api/v1/models/{modelName}/wake` | Pass-through |
| `GET /api/workers` | `GET /api/v1/workers` | Pass-through, fall back to Redis on CP failure |
| `GET /api/workers/:id` | `GET /api/v1/workers/{workerId}` | Pass-through, fall back to Redis on CP failure |
| `GET /api/cluster/status` | `GET /api/v1/cluster/status` | Pass-through, fall back to Redis on CP failure |
| `GET /api/cluster/memory` | `GET /api/v1/cluster/memory` | Pass-through, fall back to Redis on CP failure |

**Redis direct reader** — for resilience during control plane restarts:

- Read model states from `sardeenz:models:*` Redis keys
- Read worker info from `sardeenz:workers:*` Redis keys
- Read routing map from `sardeenz:routing-map` hash
- Construct partial responses matching the control plane schema shapes
- Clearly mark responses as `source: "redis-fallback"` so the frontend can display a degraded-state indicator

**Prometheus client** — for metrics dashboard:

- `GET /api/metrics/latency` — query `sardeenz_proxy_request_duration_seconds` histogram
- `GET /api/metrics/throughput` — query `sardeenz_proxy_requests_total` rate
- `GET /api/metrics/memory` — query `sardeenz_control_plane_device_memory_bytes` gauge
- Accept `start`, `end`, `step` query parameters for time range
- Transform Prometheus query results into chart-friendly JSON

**SSE relay** — subscribe to the control plane's `GET /api/v1/events` SSE stream and relay events to connected frontend clients:

- Maintain a single upstream SSE connection to the control plane
- Fan out events to all connected frontend clients
- Reconnect on upstream disconnect with exponential backoff
- Send `ping` events to frontend clients every 30 seconds

**Verification:** Unit tests for each client (mocked HTTP responses). Integration test confirming the Redis fallback works when the control plane is unreachable.

### 3.5 — Implement Frontend Data Fetching Layer

**Depends on:** Tasks 3.2, 3.3

Build the React hooks and API client that all page components use to fetch and subscribe to data.

**API client:**

- Typed fetch wrapper using generated types from `@sardeenz/types`
- Base URL configurable via Vite environment variable (`VITE_API_URL`, default `/api`)
- Consistent error handling — parse `ErrorResponse` bodies, surface error messages
- Request cancellation via `AbortController` on component unmount

**React hooks:**

| Hook | Source | Returns |
| --- | --- | --- |
| `useClusterStatus()` | `GET /api/cluster/status` | `ClusterStatus` + loading/error state |
| `useClusterMemory()` | `GET /api/cluster/memory` | `ClusterMemory` + loading/error state |
| `useModels(filter?)` | `GET /api/models` | `ModelInfo[]` + loading/error state |
| `useModel(name)` | `GET /api/models/:name` | `ModelDetail` + loading/error state |
| `useWorkers()` | `GET /api/workers` | `WorkerInfo[]` + loading/error state |
| `useWorker(id)` | `GET /api/workers/:id` | `WorkerDetail` + loading/error state |
| `useMetrics(query, range)` | `GET /api/metrics/*` | Chart data + loading/error state |

**Mutation hooks:**

| Hook | Action | Optimistic update |
| --- | --- | --- |
| `useDeployModel()` | `POST /api/models` | Add model in `PENDING` state to local list |
| `useSleepModel()` | `POST /api/models/:name/sleep` | Update model state to `DRAINING` locally |
| `useWakeModel()` | `POST /api/models/:name/wake` | Update model state to `STARTING` locally |
| `useDeleteModel()` | `DELETE /api/models/:name` | Mark model as `STOPPING` locally |

**SSE event stream:**

- `useEventStream()` hook that connects to `GET /api/events`
- Parse typed `ClusterEvent` objects
- Dispatch events to update relevant query caches (e.g., `MODEL_STATE_CHANGED` updates the model list)
- Reconnect on disconnect with exponential backoff
- Connection status indicator (connected/reconnecting/disconnected) exposed for the UI

**Polling fallback:**

- If SSE connection fails for >30 seconds, fall back to polling every 5 seconds
- Switch back to SSE when the connection recovers
- Configurable refresh interval per hook (some views need faster updates than others)

**Verification:** Unit tests for API client error handling, SSE event parsing, and hook behavior (loading → success, loading → error). Vitest with React Testing Library.

### 3.6 — Implement Cluster Overview Page

**Depends on:** Tasks 3.5, 3.1

**v1 reuse:** Start from the v1 cluster overview components identified in Task 3.1 — summary cards, memory widgets, and status indicators. Adapt to v2's `ClusterStatus` and `ClusterMemory` schemas. Build new only for elements that have no v1 equivalent (e.g., the SSE-driven event feed).

The landing page — a dashboard view showing aggregate cluster health at a glance. An operator opening the dashboard should immediately understand: how much GPU memory is in use, how many models are running, and whether anything needs attention.

**Layout** (PatternFly 6 `PageSection` with `Grid`):

**Row 1 — Summary cards** (`Card` components in a 4-column grid):

| Card | Data source | Content |
| --- | --- | --- |
| Workers | `useClusterStatus()` | `workersOnline` / `workerCount`, status badge |
| Models | `useClusterStatus()` | `modelCounts.active` active, `modelCounts.sleeping` sleeping, `modelCounts.total` total |
| GPU Memory | `useClusterStatus()` | Used / Total with percentage bar, available highlighted |
| Alerts | `useClusterStatus()` | Count of models in `ERROR` state, workers `OFFLINE` |

**Row 2 — Aggregate memory visualization:**

- Cluster-wide stacked bar or donut chart showing used / reserved / available memory
- Uses `useClusterMemory()` for the breakdown
- PatternFly `Chart` (react-charts/Victory) for rendering
- Drill-down link to per-worker view

**Row 3 — Model state breakdown:**

- Horizontal bar chart or table showing model counts by state (`ACTIVE`, `SLEEPING`, `STARTING`, `ERROR`, etc.)
- Each state uses a consistent color derived from PatternFly semantic tokens
- Click a state to navigate to the model list filtered by that state

**Row 4 — Recent events:**

- Live feed of the last ~20 cluster events from `useEventStream()`
- Each event shows: timestamp, type icon, description (e.g., "Model meta-llama/Llama-3.1-8B transitioned to ACTIVE")
- New events animate in at the top
- Link to full event history (future)

**State color mapping** (consistent across all views):

| State | Color | PF6 token |
| --- | --- | --- |
| `ACTIVE` | Green | `--pf-t--global--color--status--success--default` |
| `SLEEPING` | Blue | `--pf-t--global--color--status--info--default` |
| `STARTING` | Cyan | `--pf-t--global--color--status--custom--default` |
| `DRAINING` | Orange | `--pf-t--global--color--status--warning--default` |
| `ERROR` | Red | `--pf-t--global--color--status--danger--default` |
| `STOPPING` | Gray | `--pf-t--global--color--status--disabled--default` |
| `STOPPED` | Gray (dimmed) | `--pf-t--global--color--status--disabled--default` |
| `PENDING` | Yellow | `--pf-t--global--color--status--warning--default` |

**Real-time behavior:**

- Summary cards update on every `MODEL_STATE_CHANGED`, `WORKER_JOINED`, `WORKER_LEFT`, and `WORKER_MEMORY_UPDATED` event
- Memory visualization re-renders on `WORKER_MEMORY_UPDATED` events (throttled to at most once per second to avoid flickering)
- Event feed streams in real time via SSE

**Verification:** Component renders with mock data. Vitest + React Testing Library for card rendering and event display. Visual verification in the browser with the dev server.

### 3.7 — Implement Model Management Page

**Depends on:** Tasks 3.5, 3.1

**v1 reuse:** The v1 model table, deploy form, and status labels are expected to port directly. Reuse the v1 table column definitions, sorting/filtering logic, and row action patterns. Adapt the deploy form fields to `ModelDeploymentRequest` (v2 adds `pinned` and `engineConfig`). Reuse the v1 status color mapping and badge components.

The primary operational view — where admins deploy models, monitor their state, and manage their lifecycle.

**Model list** (PatternFly `Table`):

| Column | Source field | Features |
| --- | --- | --- |
| Model Name | `modelName` | Link to detail view |
| State | `state` | Color-coded `Label` component (see 3.6 color mapping) |
| Runner Type | `runnerType` | Text |
| Worker | `workerId` | Link to worker detail, or "—" if unplaced |
| Memory | `currentMemory` / `requiredMemory` | Bar showing used vs. configured |
| Last Inference | `lastInferenceAt` | Relative time ("2m ago"), or "Never" |
| Pinned | `pinned` | Lock icon if pinned |
| Actions | — | Kebab menu (see below) |

**Table features:**

- **Filtering** — by state (multi-select chips), by runner type
- **Sorting** — by name, state, memory, last inference time
- **Pagination** — PatternFly pagination component (25 / 50 / 100 per page)
- **Empty state** — PatternFly `EmptyState` with "No models deployed" message and deploy action button
- **Bulk actions** — select multiple models for bulk sleep or bulk wake (toolbar action)

**Row actions** (kebab menu per row):

| Action | Condition | Behavior |
| --- | --- | --- |
| Sleep | State is `ACTIVE` | Confirmation modal → `POST /api/models/:name/sleep` |
| Wake | State is `SLEEPING` | `POST /api/models/:name/wake` (no confirmation needed) |
| Delete | Any non-terminal state | Danger confirmation modal → `DELETE /api/models/:name` |

**Deploy form** (`/models/deploy` route):

PatternFly `Form` in a full page (not a modal, since the form has enough fields to warrant its own view):

| Field | Type | Validation |
| --- | --- | --- |
| Model Name | `TextInput` | Required, unique (show 409 error inline) |
| Runner Type | `FormSelect` | Required, populated from worker capabilities |
| Model Path | `TextInput` | Required, must start with `/` |
| Required Memory | `TextInput` + unit selector (GiB/MiB) | Required, positive integer |
| Device Type | `FormSelect` | Optional (`CUDA`, `ROCM`, `CPU`), default "Any" |
| Tensor Parallelism | `NumberInput` | Min 1, default 1 |
| Pinned | `Switch` | Default off |
| Engine Config | `TextArea` (JSON) | Optional, validated as valid JSON |

Submit button triggers `useDeployModel()`. On success, navigate to the model detail view. On error, display inline error alert.

**Real-time behavior:**

- Model state labels update live via SSE events
- New models appear in the table when `MODEL_DEPLOYED` events arrive
- Models disappear from the table when `MODEL_REMOVED` events arrive (or move to `STOPPED` state)

**Verification:** Table renders with mock data, sorting and filtering work, deploy form validates and submits. Vitest + React Testing Library for component logic. Visual verification in the browser.

### 3.8 — Implement Model Detail View

**Depends on:** Tasks 3.5, 3.7

**v1 reuse:** Port the v1 model detail panel, loading progress display, and error state rendering. The v1 description list layout and field formatting (memory units, relative timestamps) should transfer directly. Adapt to v2's `ModelDetail` schema which adds `progress`, `stateChangedAt`, and `runnerEndpoint` fields.

Full detail view for a single model (`/models/:modelName`). This is where operators monitor a model's current state, observe startup progress, and diagnose errors.

**Layout:**

**Header section:**

- Model name as page title (in breadcrumbs: Cluster > Models > model-name)
- State label with color-coded badge
- Action buttons: Sleep / Wake / Delete (conditionally shown based on current state)

**Detail section** (PatternFly `DescriptionList`):

| Field | Source | Display |
| --- | --- | --- |
| State | `state` | Color-coded label |
| Runner Type | `runnerType` | Text |
| Model Path | `modelPath` | Monospace text |
| Worker | `workerId` | Link to worker detail |
| Runner Endpoint | `runnerEndpoint` | `host:port` or "—" |
| Required Memory | `requiredMemory` | Formatted with unit (e.g., "16.0 GiB") |
| Current Memory | `currentMemory` | Formatted with unit, or "—" if not running |
| Device Type | `deviceType` | Text |
| Tensor Parallelism | `tensorParallel` | Number |
| Pinned | `pinned` | Yes/No with icon |
| Last Inference | `lastInferenceAt` | Absolute + relative time |
| State Changed | `stateChangedAt` | Absolute + relative time |
| Created | `createdAt` | Absolute time |

**Loading progress** (shown when state is `STARTING`):

- PatternFly `Progress` component showing `percentComplete`
- Current phase label (e.g., "Loading weights", "Initializing KV cache")
- Estimated remaining time
- Progress message from the runner

**Error display** (shown when state is `ERROR`):

- PatternFly `Alert` with `danger` variant
- `errorMessage` displayed in full
- "Retry" button to attempt `POST /api/models/:name/wake` (transitions ERROR → STARTING)
- "Delete" button to remove the errored model

**Engine configuration** (expandable section):

- Rendered as formatted JSON in a `CodeBlock` component
- Read-only in this phase (editing requires delete + re-deploy)

**Real-time behavior:**

- State label, progress bar, and all fields update live via SSE events
- Loading progress polls more frequently during `STARTING` state (every 2 seconds) to show smooth progress bar updates

**Verification:** Detail view renders with mock data for each model state (ACTIVE, STARTING with progress, ERROR with message, SLEEPING). Visual verification in the browser.

### 3.9 — Implement Worker Detail Page

**Depends on:** Tasks 3.5, 3.6

**v1 reuse:** Port the v1 per-device GPU memory cards, worker capability display, and running-models list. The card-per-GPU layout and stacked memory bar components are core v1 patterns that should transfer with minimal changes — adapt from v1 memory fields to v2's `DeviceInfo` schema (which adds `memoryReservedBytes`).

Detailed view of a single worker (`/workers/:workerId`), focused on GPU memory breakdown and running models.

**Header section:**

- Worker ID as page title
- Status badge (`ONLINE` / `DEGRADED` / `OFFLINE` with appropriate color)
- Last heartbeat timestamp

**Device memory cards** (PatternFly `Card` grid, one card per device):

Each card shows:

- Device index and type (e.g., "GPU 0 — CUDA")
- Stacked memory bar: used (by running models) / reserved (for starting models) / available
- Memory values in GiB: "12.4 / 0.5 / 3.1 GiB (used / reserved / available)"
- List of models consuming memory on this device, with per-model usage

**Running models table** (PatternFly `Table`):

| Column | Source | Features |
| --- | --- | --- |
| Model Name | `modelName` | Link to model detail |
| State | `state` | Color-coded label |
| Memory Used | `memoryUsedBytes` | Formatted with unit |

**Capabilities section** (expandable, PatternFly `ExpandableSection`):

- Runner types available (`runnerCapabilities` array)
- For each: runner type, engine name, supported model types, supported device types, supported sleep levels

**Worker list** (`/workers` route):

If the cluster has more than a few workers, a table view is also needed:

| Column | Source | Features |
| --- | --- | --- |
| Worker ID | `workerId` | Link to detail |
| Status | `status` | Color-coded label |
| Devices | `devices.length` | Count |
| Memory Used | Sum of `memoryUsedBytes` | Formatted |
| Memory Total | Sum of `memoryTotalBytes` | Formatted |
| Models | `modelCount` | Count |
| Last Heartbeat | `lastHeartbeatAt` | Relative time |

**Real-time behavior:**

- Device memory bars update on `WORKER_MEMORY_UPDATED` events
- Model states update on `MODEL_STATE_CHANGED` events
- Worker status updates on heartbeat timeout detection

**Verification:** Worker detail renders with mock data for workers with 1, 2, 4, and 8 GPUs. Memory bars show correct proportions. Visual verification in the browser.

### 3.10 — Implement Device Memory Visualization

**Depends on:** Tasks 3.5, 3.6, 3.9, 3.1

**v1 reuse:** The VRAM visualization is v1's signature UI component. **Port the v1 implementation directly** — it already handles the visual representation of GPU memory allocation that operators are familiar with. Adapt the data bindings from v1's memory schema to v2's `ClusterMemory` / `DeviceInfo` types, and upgrade PatternFly chart imports to v6. If the v1 visualization uses custom SVG, keep it — don't rewrite it in PatternFly charts just for consistency. Operators already understand the v1 visual language; changing it unnecessarily creates confusion.

Graphical representation of VRAM allocation across the entire cluster. This is the signature visualization — the view that lets operators see at a glance where GPU memory is going and which devices have headroom.

**Design approach — v1-first:**

Start by porting the v1 visualization. Only consider alternatives if the v1 approach proves incompatible with v2's data model:

1. **Port v1 visualization** (default) — reuse v1's rendering approach (stacked bars, donut charts, custom SVG, or whatever v1 uses). Adapt data bindings to v2 schemas. Upgrade PF imports.
2. **Stacked bar chart per worker** (fallback if v1 can't be ported) — PatternFly `Chart` with `ChartBar` components. Simple, clear, scales to ~20 workers.
3. **Heatmap grid** (future enhancement) — for larger clusters. Rows are workers, columns are devices, cell color intensity shows utilization.

**Data source:** `useClusterMemory()` provides per-worker, per-device breakdown including which models are on each device.

**Interactive features:**

- Hover tooltip showing exact memory values and model names
- Click a device bar to navigate to the worker detail page
- Legend showing memory categories (used by models, reserved, available)
- Toggle between absolute values (GiB) and percentages

**Placement in the UI:**

- Embedded in the cluster overview page (Task 3.6, Row 2)
- Also accessible as a dedicated section within each worker's detail page (Task 3.9)

**Real-time behavior:**

- Re-renders on `WORKER_MEMORY_UPDATED` events (throttled to 1 update/second)
- Smooth transitions when memory values change (CSS or Victory animation)

**Verification:** Visualization renders correctly for 1, 2, 4, and 8 GPU configurations (definition of done requirement). Memory proportions are visually accurate. Tooltips display correct values.

### 3.11 — Implement Metrics Dashboard

**Depends on:** Tasks 3.4, 3.5, 3.2

**v1 reuse:** If v1 has metrics or benchmark visualization components (charts, time range selectors, data formatting), port them. The Prometheus query layer is new (v1 may use a different metrics backend), but chart rendering components and time range selector UX can likely be reused.

Charts showing inference performance and resource utilization over time, backed by Prometheus queries.

**Layout** (PatternFly `PageSection` with `Grid`):

**Row 1 — Inference performance:**

- **Request latency** — line chart showing p50, p95, p99 latency over time from `sardeenz_proxy_request_duration_seconds` histogram
- **Request throughput** — line chart showing requests/second from `rate(sardeenz_proxy_requests_total[5m])`

**Row 2 — Connection state:**

- **Active connections** — gauge showing current active forwarded connections from `sardeenz_proxy_active_connections`
- **Parked connections** — gauge showing currently parked connections from `sardeenz_proxy_parked_connections`, labeled by model

**Row 3 — Device utilization:**

- **Device memory over time** — stacked area chart showing used/reserved/available from `sardeenz_control_plane_device_memory_bytes`
- **Wake triggers** — bar chart showing wake trigger frequency from `rate(sardeenz_control_plane_wake_triggers_total[5m])`

**Row 4 — Orchestration:**

- **State transitions** — bar chart showing transitions by type from `rate(sardeenz_control_plane_state_transitions_total[5m])`
- **Evictions** — counter showing evictions over time from `rate(sardeenz_control_plane_evictions_total[5m])`

**Time range selector:**

- Preset options: Last 15m, 1h, 6h, 24h, 7d
- Custom range picker (date/time inputs)
- Auto-refresh toggle (every 30 seconds when enabled)

**Chart library:** PatternFly react-charts (Victory-based). Use `Chart`, `ChartLine`, `ChartArea`, `ChartBar`, and `ChartDonut` components.

**Empty state:** When Prometheus is unavailable or no metrics data exists yet, show an informational `EmptyState` explaining that metrics require a running Prometheus instance and active traffic.

**Verification:** Charts render with mock Prometheus response data. Time range selector changes the query window. Visual verification in the browser.

### 3.12 — Accessibility Audit

**Depends on:** Tasks 3.6, 3.7, 3.8, 3.9, 3.10, 3.11

Verify all views meet WCAG 2.1 AA standards. PatternFly 6 components have built-in ARIA patterns, but page composition, custom components, and dynamic content require explicit verification.

**Audit areas:**

1. **Keyboard navigation** — all interactive elements reachable via Tab, actions triggerable via Enter/Space, modals trapable, Escape closes modals/popovers
2. **Screen reader compatibility** — semantic HTML structure, ARIA labels on icon-only buttons, live regions for dynamic content (model state changes, event feed), chart descriptions
3. **Color contrast** — all text meets 4.5:1 contrast ratio (AA). State colors verified against both light and dark backgrounds
4. **Focus management** — focus moves to appropriate element after navigation, modal open/close, and form submission
5. **Form accessibility** — all form fields have visible labels, error messages associated via `aria-describedby`, required fields indicated
6. **Chart accessibility** — all charts have text alternatives (either `aria-label` or an accessible data table behind the chart)
7. **Real-time content** — SSE-driven updates announced via ARIA live regions without being disruptive; event feed updates are polite, not assertive

**Tooling:**

- Browser DevTools accessibility audit (Chrome/Firefox)
- `axe-core` integration in Vitest for automated checks
- Manual keyboard-only navigation walkthrough of every view

**Verification:** No critical or serious `axe-core` violations. All views navigable via keyboard alone. Screen reader walkthrough of the deploy flow confirms all form fields, states, and confirmations are announced.

### 3.13 — Write Dashboard Design Document

**Depends on:** Tasks 3.2, 3.3, 3.4, 3.5

Narrative companion to the code at `docs/architecture/components/dashboard.md`. Explains the architecture, data flow, and design decisions for operators and future contributors.

Covers:

- **Architecture** — BFF pattern rationale, three data sources, resilience during control plane failover
- **Data flow** — request path from user action → BFF → upstream → response; SSE event flow from control plane → BFF relay → frontend
- **Real-time update strategy** — SSE subscription, event dispatch to query cache, polling fallback, throttling
- **Redis fallback behavior** — how the BFF detects control plane unavailability, constructs partial responses from Redis, and signals degraded state to the frontend
- **State management** — React hooks for data fetching, optimistic updates for mutations, SSE-driven cache invalidation
- **View architecture** — page decomposition, shared components, route structure
- **PatternFly 6 usage** — component choices, token usage, accessibility approach
- **Configuration reference** — all environment variables for both frontend and BFF
- **Prometheus integration** — which metrics are queried, how time ranges map to PromQL, chart rendering approach
- **Testing strategy** — unit tests (Vitest), E2E tests (Playwright), what is tested at each level

### 3.14 — Build Container Images

**Depends on:** Tasks 3.2, 3.3

Container images for production deployment. Two options — evaluate during implementation:

**Option A — Single image** (BFF serves the static frontend):

- Multi-stage build: Node.js base → install dependencies → build frontend (Vite) → build BFF (TypeScript) → runtime stage with Node.js slim
- BFF serves the frontend's static assets from a `public/` directory
- Simpler deployment (one container, one port)

**Option B — Two images** (separate frontend and BFF):

- Frontend image: nginx serving the Vite build output
- BFF image: Node.js slim with compiled TypeScript
- More flexible scaling (frontend can be CDN-backed, BFF scales independently)
- More complex deployment

**Recommendation:** Start with Option A (single image). The dashboard is an internal admin tool, not a high-traffic public site. The operational simplicity of one container outweighs the scaling flexibility of two. Can split later if needed.

**Dockerfile** at `containers/dashboard/Dockerfile`:

**Build stage:**

1. Node.js 22 base
2. Copy workspace root `package.json`, `package-lock.json`, and workspace package manifests
3. `npm ci --workspace=@sardeenz/dashboard --workspace=@sardeenz/types --workspace=@sardeenz/utils`
4. Build `@sardeenz/types` and `@sardeenz/utils` first (dependencies)
5. Build frontend: `npm run build -w @sardeenz/dashboard` (Vite production build)
6. Build BFF: compile TypeScript
7. Prune to production dependencies

**Runtime stage:**

1. Node.js 22 slim
2. Copy compiled BFF + frontend static assets + production `node_modules`
3. Non-root user
4. Expose BFF port
5. Health check using `/healthz`
6. `NODE_ENV=production`

**Verification:** `docker build` succeeds. Container starts, serves the frontend on `/`, and responds to `/healthz`. Frontend assets load and the app shell renders.

### 3.15 — E2E Test Suite

**Depends on:** Tasks 3.6, 3.7, 3.8, 3.9

Playwright tests validating critical admin workflows end-to-end. Tests run against the real frontend + BFF, with mock upstream services (control plane API mock, Redis, Prometheus mock).

**Test infrastructure:**

- Playwright test runner with TypeScript
- Mock control plane HTTP server implementing the admin API spec (returns deterministic responses for each endpoint)
- Real Redis/Valkey instance (test containers or local)
- Mock Prometheus query endpoint (returns canned metric data)
- Frontend + BFF running against the mocks

**Test scenarios:**

| # | Scenario | What it validates |
| --- | --- | --- |
| 1 | Cluster overview loads | Page renders with worker cards, memory summary, model counts |
| 2 | Model deploy flow | Navigate to deploy form → fill fields → submit → redirect to detail → see PENDING state |
| 3 | Model state transitions | Deploy model → observe PENDING → STARTING (with progress) → ACTIVE via mock SSE events |
| 4 | Model sleep/wake | Sleep an ACTIVE model → confirm modal → see DRAINING → SLEEPING. Wake → see STARTING → ACTIVE |
| 5 | Model delete | Delete a model → confirm danger modal → model removed from list |
| 6 | Worker detail loads | Navigate to worker detail → see GPU memory cards, running models |
| 7 | Memory visualization | Cluster overview shows stacked bars with correct proportions for multi-GPU worker |
| 8 | Degraded mode | Control plane mock returns errors → BFF falls back to Redis → dashboard shows degraded indicator |
| 9 | Navigation and breadcrumbs | Navigate through all routes, verify breadcrumbs update, sidebar highlights correct item |
| 10 | Deploy form validation | Submit with missing required fields → inline validation errors shown, form does not submit |

**Playwright configuration:**

- Run in headless mode for CI
- Screenshot on failure for debugging
- Separate test fixtures for mock server setup/teardown

**Verification:** `npx playwright test` passes. Tests run in CI.

## Definition of Done

From the [overall project plan](overall-plan.md#phase-3-admin-dashboard):

- [ ] Admin can deploy a model through the dashboard and see it transition through `STARTING` → `ACTIVE`
- [ ] Admin can sleep and wake a model through the dashboard
- [ ] Cluster overview shows real-time GPU memory utilization (updates within 5 seconds of state change)
- [ ] Device memory visualization renders correctly for workers with 1, 2, 4, and 8 GPUs
- [ ] Dashboard remains responsive and displays cached state during a brief control plane restart (BFF reads from Redis/Prometheus independently)
- [ ] All views pass PatternFly 6 accessibility standards (WCAG 2.1 AA)
- [ ] Playwright E2E tests cover: model deploy, model sleep/wake, cluster overview loads, worker detail loads
- [ ] Frontend builds with zero TypeScript errors and zero ESLint warnings
- [ ] OpenAPI specs pass `redocly lint` with zero errors
- [ ] Generated TypeScript types compile cleanly (`make typecheck`)
- [ ] `npm run lint` passes with zero warnings across all dashboard packages
- [ ] Container image builds and runs successfully

## Open Questions

- **BFF or direct API calls?** The architecture specifies a BFF, but for the initial implementation, the frontend could call the control plane API directly (it's already HTTP/JSON with CORS). The BFF adds resilience (Redis fallback) and is the auth integration point. _Decided:_ BFF, per the architecture. The Redis fallback resilience requirement from the definition of done requires it, and retrofitting a BFF after building direct API calls is more rework than starting with one.
- **State management library?** Options: (a) React hooks + context for data fetching state (no library); (b) TanStack Query (React Query) for caching, deduplication, and background refresh; (c) Zustand or Jotai for global state. _Leaning toward:_ TanStack Query for server state (data fetching) with plain React context for UI state (sidebar open/closed, filters). TanStack Query handles caching, deduplication, refetching, and optimistic updates out of the box — reinventing this with raw hooks would be significant effort.
- **BFF co-located or separate package?** Should the BFF live in `dashboard/server/` (co-located with the frontend) or in a separate workspace package? Co-located is simpler and keeps the BFF close to its consumer. Separate is cleaner for independent deployment. _Leaning toward:_ co-located in `dashboard/server/`, with a separate `tsconfig.json` for the server build. Single deployment image supports this.
- **Prometheus query complexity?** The metrics dashboard requires PromQL queries. Should the BFF send raw PromQL and the frontend render results, or should the BFF expose higher-level endpoints (e.g., `/api/metrics/latency?range=1h`) and handle PromQL internally? _Leaning toward:_ BFF handles PromQL — the frontend should not need to know about Prometheus query syntax.
- **Chart library:** PatternFly react-charts (Victory-based) is the default. For complex visualizations like the memory heatmap, we may need additional components. Should we allow a second chart library (e.g., D3 for custom SVG), or restrict to PatternFly charts only? _Leaning toward:_ PatternFly charts only for the initial implementation. Custom SVG if needed for the memory visualization, but no additional chart libraries unless PatternFly charts prove insufficient.
- **Dark mode:** PatternFly 6 supports light and dark themes. Should the dashboard support theme switching, or ship with light theme only? _Leaning toward:_ light theme only for the initial implementation. PatternFly's design tokens make adding dark mode later a token swap, not a rewrite.
- **PF5 → PF6 porting strategy:** v1 uses PatternFly 5 (or possibly 4). Should we port components to PF6 inline during Task 3.1, or copy them as-is and run a batch PF6 migration pass afterward? _Leaning toward:_ port to PF6 inline during Task 3.1. Batch migration risks compounding breakage. Porting one component at a time with immediate visual verification catches PF6 incompatibilities early and keeps each component shippable.

## Dependencies

- **Phase 2 outputs** — control plane API for model lifecycle commands, cluster state, worker management, SSE events
- **Phase 1 outputs** — running proxy for end-to-end model serving (deployed models serve inference through the proxy)
- **Phase 0 outputs** — runner contract types re-exported through `@sardeenz/types`
- **Redis/Valkey instance** — for BFF direct reads (resilience) and development
- **Prometheus instance** — for metrics dashboard data source
- **Node.js 22+** — runtime for both frontend build and BFF
- **TypeScript toolchain** — compiler, linter, test runner (Vitest)
- **Playwright** — E2E testing framework
- **PatternFly 6** — `@patternfly/react-core`, `@patternfly/react-icons`, `@patternfly/react-table`, `@patternfly/react-charts`
- **v1 repo access** — for porting UI components in Task 3.1

## Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| PatternFly 6 is newer with fewer community examples | Slower UI development, unexpected component gaps or behavioral differences | Use official PatternFly.org docs as sole reference; use the `/patternfly-6-development` skill; avoid Context7 for PF components |
| Real-time updates create excessive Redis/SSE load | Dashboard polling or fan-out degrades proxy/control plane performance | Single upstream SSE connection in BFF; fan-out to frontend clients; throttle memory update re-renders to 1/second |
| v1 component porting takes longer than expected | UI delivery slows as PF5→PF6 upgrades or v1→v2 data model changes prove harder than expected | Time-box porting to 2 days per component; rebuild from scratch only if porting costs more than building new. Track port verdicts in `v1-component-mapping.md` to catch patterns early (e.g., if PF5→PF6 migration is consistently painful, batch the upgrade separately) |
| Prometheus integration complexity | PromQL query authoring and result transformation adds unexpected scope | Start with simple queries (rate, histogram_quantile); BFF handles all PromQL; frontend receives chart-ready JSON |
| BFF adds latency to every request | Dashboard feels slower than direct API calls | Keep BFF thin — proxy requests without transformation where possible; add caching only where it adds value |
| TanStack Query learning curve | Data fetching bugs if team is unfamiliar with the library's caching model | Start with simple `useQuery`/`useMutation` patterns; avoid advanced features (optimistic updates, infinite queries) until needed |

## References

- [Overall project plan](overall-plan.md) — Phase 3 deliverables and definition of done
- [Architecture overview](../architecture/overview.md) — system design, request flows, dashboard role
- [ADR-002: Four-component split](../architecture/adrs/adr-002-four-component-split.md) — dashboard as BFF + frontend pair
- [ADR-005: OpenAPI contracts](../architecture/adrs/adr-005-openapi-contracts.md) — cross-language contract strategy
- [ADR-006: New platform](../architecture/adrs/adr-006-new-platform.md) — new platform with v1 component reuse
- [ADR-012: TypeScript stack](../architecture/adrs/adr-012-typescript-stack.md) — React + PatternFly 6 + Vite choice rationale
- [Control plane API spec](../../packages/contracts/specs/control-plane.yaml) — admin API endpoints and schemas (Phase 2 output)
- [Proxy ↔ control plane spec](../../packages/contracts/specs/proxy-control-plane.yaml) — routing map and model state schemas
- [PatternFly 6 guide](../development/patternfly.md) — PF6 usage rules, import patterns, design tokens
- [Coding standards](../development/coding-standards.md) — TypeScript, React, and file naming conventions
- [Sardeenz v1](https://github.com/rh-aiservices-bu/sardeenz) — reference implementation for UI patterns
