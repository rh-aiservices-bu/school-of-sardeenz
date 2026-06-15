# Admin Dashboard

The admin dashboard is the operator-facing web interface for managing models, monitoring GPU memory utilization, and observing cluster health. It consists of two deployable units: a React single-page application (SPA) and a Fastify backend-for-frontend (BFF) service, packaged as a single container image.

For the overall system context, see the [architecture overview](../overview.md). For the dashboard's API data source, see the [control plane API spec](../../../packages/contracts/specs/control-plane.yaml).

For the TypeScript stack rationale, see [ADR-012](../adrs/adr-012-typescript-stack.md). For the four-component split rationale (dashboard as BFF + frontend pair), see [ADR-002](../adrs/adr-002-four-component-split.md).

## Scope

The dashboard owns the **operator experience** for day-to-day cluster management. It does not:

- **Make orchestration decisions.** The control plane handles placement, eviction, and lifecycle transitions. The dashboard triggers actions (deploy, sleep, wake, delete) and displays their results.
- **Replace Prometheus/Grafana.** The metrics dashboard provides a convenience view of key metrics. Production alerting and deep observability remain in external tooling.
- **Enforce authentication or authorization.** This is deferred to a future phase. The BFF is the planned integration point for auth middleware.
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
Browser → EventSource(/api/events)
       → BFF subscribes to Redis pub/sub channel: {prefix}:events
       → Forwards each JSON event as SSE data frames
       → Sends keepalive pings every 30 seconds
       → Frontend useEventStream() hook:
         ├─ Parses ClusterEvent objects
         ├─ Dispatches to TanStack Query cache invalidation
         └─ Maintains 100-event ring buffer for event feed display
```

The BFF's SSE relay subscribes to the Redis pub/sub channel rather than the control plane's `/api/v1/events` endpoint. This means events flow even during control plane restarts, since the control plane publishes events to Redis as part of its state transitions.

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

### SSE reconnection

The `useEventStream` hook connects to `/api/events` via `EventSource`. On disconnect, it reconnects after a 5-second backoff. The hook exposes a `ConnectionStatus` (`connected` | `connecting` | `disconnected`) for UI display.

### Shared components

| Component | Purpose |
| --- | --- |
| `AppLayout` | PF6 Page shell with masthead, sidebar nav, active highlighting |
| `StateLabel` | Model lifecycle state as a colored PF6 Label with state-appropriate icons |
| `MemoryBar` | Stacked memory bar (used / reserved / available) |

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
| E2E | Playwright | Critical admin workflows against real frontend + BFF with mock upstreams |

## Prometheus Integration

The metrics dashboard queries three metric families:

| Metric | Type | Source | Dashboard chart |
| --- | --- | --- | --- |
| `sardeenz_proxy_request_duration_seconds` | Histogram | Proxy | p95 latency line chart |
| `sardeenz_proxy_requests_total` | Counter | Proxy | Throughput (req/s) line chart |
| `sardeenz_control_plane_device_memory_bytes` | Gauge | Control plane | Device memory instant query |

Time ranges map to PromQL step sizes: 15m → 15s, 1h → 60s, 6h → 300s, 24h → 900s. The BFF constructs the PromQL and handles time range parameters; the frontend receives chart-ready arrays.
