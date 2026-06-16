# Admin Dashboard

The admin dashboard is the operator-facing web interface for managing models, monitoring GPU memory utilization, and observing cluster health. It consists of two deployable units: a React single-page application (SPA) and a Fastify backend-for-frontend (BFF) service, packaged as a single container image.

For the overall system context, see the [architecture overview](../overview.md). For the dashboard's API data source, see the [control plane API spec](../../../packages/contracts/specs/control-plane.yaml).

For the TypeScript stack rationale, see [ADR-012](../adrs/adr-012-typescript-stack.md). For the four-component split rationale (dashboard as BFF + frontend pair), see [ADR-002](../adrs/adr-002-four-component-split.md).

## Scope

The dashboard owns the **operator experience** for day-to-day cluster management. It does not:

- **Make orchestration decisions.** The control plane handles placement, eviction, and lifecycle transitions. The dashboard triggers actions (deploy, sleep, wake, delete) and displays their results.
- **Replace Prometheus/Grafana.** The metrics dashboard provides a convenience view of key metrics. Production alerting and deep observability remain in external tooling.
- **Enforce RBAC beyond simple role-based auth.** A lightweight auth system (JWT, three modes: `none` / `simple` / `oauth`) is implemented. Per-model permissions and audit logging remain future work.
- **Manage multiple clusters.** Single cluster only.

## Architecture

```
                                    ┌────────────────────────┐
                                    │   Frontend SPA         │
                                    │   (React + PF6)        │
                                    │                        │
                                    │  ┌─────────────────┐   │
                                    │  │ TanStack Query   │   │
                                    │  │ + SSE EventSource│   │
              Operator              │  └────────┬────────┘   │
             (browser)              └───────────┼────────────┘
                                                │ /api/*
                                                ▼
                                    ┌────────────────────────┐
                                    │   BFF (Fastify)        │
                                    │                        │
                                    │  ┌──────┬──────┬────┐  │
                                    │  │ CP   │Redis │Prom│  │
                                    │  │Client│Reader│Clt │  │
                                    │  └──┬───┴──┬───┴──┬─┘  │
                                    └─────┼──────┼──────┼────┘
                                          │      │      │
                              ┌───────────┘      │      └───────────┐
                              ▼                  ▼                  ▼
                     ┌─────────────┐    ┌─────────────┐    ┌─────────────┐
                     │ Control     │    │ Redis /     │    │ Prometheus  │
                     │ Plane API   │    │ Valkey      │    │             │
                     └─────────────┘    └─────────────┘    └─────────────┘
```

### Why a BFF?

Three reasons justify a backend-for-frontend rather than direct API calls from the browser:

1. **Resilience.** The dashboard must remain functional during brief control plane restarts. The BFF reads model and worker state directly from Redis when the control plane is unreachable, serving partial but usable responses marked with `source: "redis-fallback"`.

2. **Aggregation.** Dashboard views combine data from multiple sources (control plane API, Redis key scans, Prometheus queries). Composing these server-side avoids multiple browser-to-backend round trips and keeps Prometheus query knowledge out of the frontend.

3. **Auth integration point.** When authentication is added in a future phase, the BFF is the natural place for session management and token validation, avoiding CORS complexity with direct control plane calls.

## Data Flow

### Read path (e.g., model list)

```
Browser → GET /api/models
       → BFF tries: controlPlane.listModels()
         ├─ Success → proxy response to browser
         └─ Network error → redis.listModels() → respond with source: "redis-fallback"
```

Write operations (deploy, sleep, wake, delete) are proxied to the control plane only. They do not fall back to Redis because Redis is a read-only mirror of control plane state.

### Real-time updates (SSE)

```
Browser → EventSource(/api/events?token=<jwt>)
       → BFF creates a per-client Redis subscriber on channel: {prefix}:routing-updates
       → Translates RoutingMapUpdate payloads → ClusterEvent objects
       → Forwards each event as SSE data frames
       → Sends keepalive ping comments every 30 seconds
       → Frontend useEventStream() hook:
         ├─ Parses ClusterEvent objects
         ├─ Dispatches to TanStack Query cache invalidation
         └─ Maintains 100-event ring buffer for event feed display
```

The BFF's SSE relay subscribes to the Redis `{prefix}:routing-updates` pub/sub channel (not the control plane's `/api/v1/events` SSE endpoint directly). Each connected browser client gets its own Redis subscriber; the subscriber is cleaned up when the client disconnects. Events flow even during control plane restarts, since the control plane publishes to Redis as part of its state transitions.

### Metrics path

```
Browser → GET /api/metrics/latency?start=...&end=...&step=...
       → BFF → Prometheus HTTP API (query_range)
       → Transform Prometheus response → chart-ready JSON → browser
```

The frontend never constructs PromQL queries. The BFF owns the query templates and exposes higher-level endpoints.

## Frontend Architecture

### Technology stack

| Layer | Choice | Rationale |
| --- | --- | --- |
| Framework | React 18 | Industry standard, large ecosystem, team familiarity |
| UI library | PatternFly 6 | Red Hat design system, built-in accessibility, consistent with v1 |
| Build tool | Vite | Fast dev server, optimized production builds |
| Server state | TanStack Query v5 | Caching, deduplication, background refresh, optimistic updates |
| Routing | React Router v6 | Client-side routing with nested layouts |
| Testing | Vitest + React Testing Library | Fast, Vite-native test runner |

### Route structure

| Path | Component | View |
| --- | --- | --- |
| `/` | `ClusterOverview` | Cluster health dashboard (landing page) |
| `/models` | `ModelList` | Model management table with filtering/sorting |
| `/models/deploy` | `ModelDeploy` | Deploy form (full page) |
| `/models/:modelName` | `ModelDetail` | Model detail with progress/error display |
| `/workers` | `WorkerList` | Worker list table |
| `/workers/:workerId` | `WorkerDetail` | Per-worker GPU memory breakdown |
| `/metrics` | `MetricsDashboard` | Prometheus-backed performance charts |

### State management

The frontend uses **TanStack Query for all server state** (data fetching, caching, mutations). There is no global client-side state store. UI-only state (sidebar open/closed, filter selections, modal visibility) lives in component-local `useState`.

Query invalidation is event-driven: the `useEventStream` hook listens for SSE events and invalidates the relevant query keys. For example, a `MODEL_STATE_CHANGED` event invalidates both `['models']` and `['cluster']` query keys, triggering a refetch only for components currently mounted and subscribed to those queries.

### SSE reconnection and degraded mode

The `useEventStream` hook connects to `/api/events` via `EventSource` (JWT token passed as `?token=` since `EventSource` cannot send headers). The hook implements a two-tier failure model:

```
CONNECTED → (SSE error) → RECONNECTING → (5 failures) → DEGRADED
    ↑                          ↑                              |
    +---------- (SSE recovers) +----- (SSE recovers) ---------+
```

- **`connected`** — SSE stream is live; events drive cache invalidation in real time
- **`reconnecting`** — temporary failure; retries every 5 seconds
- **`degraded`** — 5+ consecutive failures; retries slow to every 30 seconds

In degraded state, the `DegradedBanner` component shows a persistent warning: "Real-time updates unavailable — polling for changes". Query hooks automatically switch to faster polling intervals to compensate. The banner auto-dismisses as soon as the connection recovers.

### Shared components

| Component | Purpose |
| --- | --- |
| `AppLayout` | PF6 Page shell with masthead, sidebar nav, active highlighting |
| `StateLabel` | Model lifecycle state as a colored PF6 Label with state-appropriate icons |
| `MemoryVisualization` | Stacked memory bar (used / reserved / available) with tooltips and expandable inline detail panel |
| `DegradedBanner` | Persistent warning banner shown when control plane is unreachable or SSE is in degraded state |

### State color mapping

Consistent across all views:

| State | PF6 Label color | Semantic meaning |
| --- | --- | --- |
| `ACTIVE` | green | Healthy, serving inference |
| `SLEEPING` | blue | Weights offloaded, can be woken |
| `STARTING` | teal | Loading weights, spinner icon |
| `DRAINING` | orange | Completing in-flight requests |
| `ERROR` | red | Requires operator intervention |
| `STOPPING` / `STOPPED` | grey | Being removed or removed |
| `PENDING` | yellow | Deployment accepted, not yet placed |

## BFF Architecture

### Technology stack

| Layer | Choice | Rationale |
| --- | --- | --- |
| Framework | Fastify 5 | High performance, structured logging, plugin ecosystem |
| Redis client | ioredis | Cluster support, pub/sub, SCAN iteration |
| HTTP client | undici (via fetch) | Node.js native, connection pooling |
| Logging | pino (via Fastify) | JSON structured logging, request ID propagation |

### Upstream clients

**ControlPlaneClient** — Typed HTTP proxy to the control plane's admin API. Each method wraps a `fetch` call, checks the response status, and either returns the body or throws a `BffError`. Used for all write operations and as the primary read path.

**RedisReader** — Direct Redis reader for resilience. Uses SCAN to enumerate model names from `{prefix}:models:state:*` keys, then reads per-model keys (`state`, `worker`, `memory`, `required-memory`, `runner-type`, `pinned`, `created-at`, `inference:last`). For workers, reads JSON hashes from `{prefix}:workers:*`. Also provides `getClusterStatus()` which aggregates model counts and memory totals from the raw keys. `getClusterMemory()` reads the per-device snapshot at `{prefix}:cluster:memory` (written by the control plane's `MemoryBudgetService` on each budget refresh, TTL 300s). `getWorkerDetail(id)` reads the full worker record from `{prefix}:worker:{id}:detail` (written by `WorkerPoolService` on each heartbeat check, TTL 120s). Only used when the control plane is unreachable.

**PrometheusClient** — Thin wrapper around the Prometheus HTTP API. Supports `query_range` (for time-series charts) and `query` (for instant gauges).

### Redis fallback behavior

Read routes follow this pattern:

```typescript
try {
  const { status, data } = await controlPlane.listModels();
  return reply.code(status).send(data);
} catch {
  log.warn('Control plane unavailable, falling back to Redis');
  const models = await redis.listModels();
  return reply.code(200).send({ models, source: 'redis-fallback' });
}
```

The `source: "redis-fallback"` field signals to the frontend that the response is from the fallback path. The `DegradedBanner` component detects this field across all active queries and shows a persistent warning: "Control plane unreachable — showing cached data". The banner auto-dismisses as soon as fresh data resumes.

Write routes (POST, DELETE) never fall back. They return the upstream error to the client, since Redis is a read-only mirror.

### Fallback coverage

| Route | Fallback | Degraded behavior |
| --- | --- | --- |
| `GET /api/models` | Redis | Full model list, may be stale |
| `GET /api/models/:name` | Redis | Full model detail, may be stale |
| `GET /api/workers` | Redis | Worker list, may be stale |
| `GET /api/workers/:id` | Redis | Worker detail, may be stale |
| `GET /api/cluster/status` | Redis | Aggregate status, may be stale |
| `GET /api/cluster/memory` | Redis | Per-device memory, may be stale |
| `GET /api/metrics/*` | None | Metrics unavailable (Prometheus dependency) |
| `GET /api/events` | None | SSE stream disconnected |
| `POST/DELETE /api/models/*` | None | Mutating operations fail with 502 |

### Health probes

| Endpoint | Purpose | Checks |
| --- | --- | --- |
| `GET /healthz` | Liveness | Always returns 200 |
| `GET /readyz` | Readiness | Checks control plane, Redis, Prometheus connectivity |

### Static file serving

In production (`NODE_ENV=production`), the BFF serves the frontend's static assets from `dist/client/` using `@fastify/static`. A catch-all not-found handler serves `index.html` for SPA client-side routing. In development, Vite's dev server handles static assets and proxies `/api` requests to the BFF.

## Configuration

### BFF environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `SARDEENZ_BFF_LISTEN_ADDR` | `0.0.0.0:4000` | BFF listen address and port |
| `SARDEENZ_CONTROL_PLANE_URL` | `http://localhost:3000` | Control plane base URL |
| `SARDEENZ_REDIS_URL` | `redis://localhost:6379` | Redis/Valkey connection string |
| `SARDEENZ_REDIS_KEY_PREFIX` | `sardeenz` | Prefix for all Redis keys |
| `SARDEENZ_PROMETHEUS_URL` | `http://localhost:9090` | Prometheus query API base URL |
| `SARDEENZ_CORS_ORIGIN` | `http://localhost:5173` | Allowed CORS origin (dev only) |
| `SARDEENZ_LOG_LEVEL` | `info` | Pino log level |
| `AUTH_MODE` | `none` | Authentication mode: `none`, `simple`, or `oauth` |
| `ADMIN_USERNAME` | `admin` | Admin username for `simple` auth mode |
| `ADMIN_PASSWORD` | _(empty)_ | Admin password for `simple` auth mode |
| `JWT_SECRET` | _(empty)_ | JWT signing secret (required when `AUTH_MODE` is not `none`) |
| `JWT_EXPIRATION_HOURS` | `8` | JWT token expiration in hours |
| `OAUTH_CLIENT_ID` | `sardeenz` | OAuth client ID (for `oauth` mode) |
| `OAUTH_CLIENT_SECRET` | _(empty)_ | OAuth client secret (for `oauth` mode) |
| `OAUTH_ISSUER_URL` | _(empty)_ | OAuth OIDC issuer URL (for `oauth` mode) |
| `K8S_API_URL` | _(empty)_ | Kubernetes API URL for RBAC role resolution (for `oauth` mode) |
| `NAMESPACE` | `sardeenz` | Kubernetes namespace for RBAC scope (for `oauth` mode) |

### Frontend environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `VITE_API_URL` | `/api` | BFF API base URL (for non-proxied setups) |

## Container Image

Single container image (`containers/dashboard/Dockerfile`) using a multi-stage build:

1. **deps stage** — `npm ci` with workspace manifests only (cache-friendly)
2. **build stage** — TypeScript compilation (shared types + BFF) and Vite production build (frontend)
3. **runtime stage** — Node.js 22 slim with compiled BFF, frontend static assets, and production dependencies

The BFF serves both the API and the frontend from a single port (4000). This simplifies deployment for an internal admin tool where scaling the frontend independently is unnecessary.

## Testing Strategy

| Level | Tool | Scope |
| --- | --- | --- |
| Unit (frontend) | Vitest + React Testing Library | API client, hooks, utility functions, component rendering |
| Unit (BFF) | Vitest | Upstream clients (mocked HTTP), route handlers (mocked deps) |
| E2E (workflows) | Playwright | Critical admin workflows against real frontend + BFF with mock upstreams |
| E2E (accessibility) | Playwright + `@axe-core/playwright` | WCAG 2.1 AA scans on all key pages using the mock harness |

### E2E mock service harness

The Playwright tests use a purpose-built mock harness rather than real upstream services:

- **`MockControlPlane`** (`dashboard/e2e/mocks/control-plane.ts`) — Fastify server on a random port serving all BFF-facing control plane endpoints with configurable canned responses. Supports stateful scenarios (deploy, delete, sleep, wake) and an SSE `pushEvent()` API for testing real-time transitions.
- **`MockPrometheus`** (`dashboard/e2e/mocks/prometheus.ts`) — Fastify server serving `/api/v1/query_range` and `/api/v1/query` with pluggable response factories.
- **Playwright fixtures** (`dashboard/e2e/fixtures.ts`) — per-test fixture that starts both mock servers on random ports, spawns the BFF process pointed at the mocks, and tears everything down after the test.

## Prometheus Integration

The metrics dashboard exposes ten BFF routes, each backed by Prometheus queries:

| BFF route | Metric(s) queried | Type | Dashboard chart |
| --- | --- | --- | --- |
| `GET /api/metrics/latency` | `sardeenz_proxy_request_duration_seconds` | Histogram | p50/p95/p99 latency line chart |
| `GET /api/metrics/throughput` | `sardeenz_proxy_requests_total` | Counter | Throughput (req/s) line chart |
| `GET /api/metrics/connections` | `sardeenz_proxy_active_connections`, `sardeenz_proxy_parked_connections` | Gauge | Active and parked connection gauges |
| `GET /api/metrics/parking-duration` | `sardeenz_proxy_parking_duration_seconds` | Histogram | p50/p95 parking wait time |
| `GET /api/metrics/memory` | `sardeenz_control_plane_device_memory_bytes` | Gauge | Device memory instant query |
| `GET /api/metrics/memory-history` | `sardeenz_control_plane_device_memory_bytes` | Gauge | Device memory over time (range) |
| `GET /api/metrics/wake-triggers` | `sardeenz_control_plane_wake_triggers_total` | Counter | Wake trigger frequency bar chart |
| `GET /api/metrics/state-transitions` | `sardeenz_control_plane_state_transitions_total` | Counter | State transitions by type |
| `GET /api/metrics/evictions` | `sardeenz_control_plane_evictions_total` | Counter | Evictions over time |
| `GET /api/metrics/operations` | `sardeenz_control_plane_{deploy,sleep,wake,eviction,placement}_duration_seconds` | Histogram | p95 operation duration by type |

Time ranges map to PromQL step sizes: 15m → 15s, 1h → 60s, 6h → 300s, 24h → 900s, 7d → 3600s. The BFF constructs the PromQL and handles time range parameters; the frontend receives chart-ready arrays.

## Authentication

The BFF implements a lightweight auth system controlled by the `AUTH_MODE` environment variable.

### Three modes

| Mode | Behavior |
| --- | --- |
| `none` (default) | No authentication. `authenticate` and `requireRole` decorators are no-ops. All routes are open. Use for local development and air-gapped deployments. |
| `simple` | Username/password login. `POST /api/auth/login` validates credentials against `ADMIN_USERNAME` / `ADMIN_PASSWORD` and returns a signed JWT. |
| `oauth` | OIDC authorization code flow. `GET /api/auth/callback` exchanges the code for tokens via the configured OIDC issuer, then issues an internal JWT. |

### JWT flow

1. Client authenticates and receives a JWT signed with `JWT_SECRET`.
2. Subsequent requests include the token as `Authorization: Bearer <token>`.
3. SSE routes that cannot send headers accept `?token=<jwt>` as a query-parameter fallback.
4. The `authenticate` preHandler verifies the token; `requireRole('admin-readonly')` checks the `roles` claim.

### Route protection

Protected routes use `{ preHandler: [app.authenticate, app.requireRole('admin-readonly')] }`. Public routes (`/api/health`, `/api/auth/*`, `/healthz`, `/readyz`) are exempt.

## Internationalization (i18n)

The frontend uses **react-i18next** with a namespace-per-page pattern.

### Namespaces

| Namespace | Pages / components |
| --- | --- |
| `common` | Shared strings: nav labels, action names, status labels, degraded banner |
| `cluster` | Cluster Overview page |
| `models` | Model List, Model Detail, Model Deploy pages |
| `workers` | Worker List, Worker Detail pages |
| `metrics` | Metrics Dashboard page |
| `auth` | Login page, OAuth callback page |

### Configuration

`dashboard/src/i18n.ts` initialises i18next with:
- Browser language detection (navigator → htmlTag, no localStorage caching)
- English as the sole locale at present (locale files at `dashboard/src/locales/en/`)
- `escapeValue: false` (React handles XSS escaping)

New strings go in the appropriate namespace JSON file. New languages add a parallel `locales/<lang>/` directory with the same files.

## Degraded Mode

Two independent conditions can trigger the degraded state indicator:

### Redis fallback (control plane unreachable)

When the BFF cannot reach the control plane, read routes fall back to Redis and include `source: "redis-fallback"` in the response body. The `DegradedContext` on the frontend detects this field across all active TanStack Query results and sets `isDegraded = true`. `DegradedBanner` then shows: "Control plane unreachable — showing cached data".

### SSE degraded state

After 5 consecutive SSE connection failures, `useEventStream` transitions to `degraded` status (reconnect backoff 30s instead of 5s). `DegradedBanner` shows: "Real-time updates unavailable — polling for changes".

### Priority

Redis fallback takes precedence in the banner (more severe: data staleness) over SSE degraded (less severe: push updates delayed). Both conditions auto-clear as soon as fresh data or a healthy SSE connection resumes — no manual dismissal required.
