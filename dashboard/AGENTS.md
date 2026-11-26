# Dashboard — AGENTS.md

Admin UI: React 18 + PatternFly 6 (Vite) frontend in `src/`, plus a Fastify **BFF** in `server/`
that fronts the control plane, Prometheus, Redis, and the inference endpoint (auth, SSE events,
Redis fallback when the control plane is down).

**Design doc:** [`docs/architecture/components/dashboard.md`](../docs/architecture/components/dashboard.md)
— BFF rationale, data flow, SSE/degraded mode, auth modes, env vars, testing strategy.
**PatternFly rules:** [`docs/development/patternfly.md`](../docs/development/patternfly.md).
**i18n:** [`docs/development/i18n.md`](../docs/development/i18n.md).
**Accessibility:** [`docs/development/accessibility-audit.md`](../docs/development/accessibility-audit.md).

## Layout

| Path                | Role                                                                                                                   |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `src/pages/`        | One folder per route: `Models`, `Workers`, `ClusterOverview`, `GpuMemory`, `Catalog`, `Metrics`, `Playground`, `Login` |
| `src/components/`   | Shared: `AppLayout`, `NotificationDrawer`, `DegradedBanner`, `LogViewer`, `StateLabel`, …                              |
| `src/hooks/`        | Data hooks per API area (`useModels`, `useWorkers`, `useEventStream`, …)                                               |
| `src/contexts/`     | `Auth`, `Theme`, `Notification`, `Degraded`, `InferenceWorkspace` (Playground sessions, app-level)                     |
| `src/api/client.ts` | Single typed HTTP client to the BFF                                                                                    |
| `src/utils/`        | Pure helpers (`memorySegments`, `format`, `parseSse`, `state-colors`)                                                  |
| `src/locales/en/`   | i18n namespaces                                                                                                        |
| `server/`           | BFF: `routes/` (auth, events, metrics, inference, catalog, …), `clients/`, `plugins/auth.ts`                           |
| `e2e/`              | Playwright specs + `mocks/` (control-plane, prometheus) + `helpers/redis.ts`                                           |

## Rules

- **PatternFly 6 only:** `pf-v6-` class prefix, `--pf-t--` semantic tokens, no hard-coded colors.
  Do **not** use Context7 for PatternFly (stale versions); use PatternFly.org and the local guide.
  Context7 is fine for React, Axios, React Router, Vitest.
- **Types come from the contract:** import API types from `@sardeenz/types`, never redeclare them.
- **Memory doctrine:** display measured VRAM only; never label anything "reserved". Placement
  math stays in the control plane.
- **All user-visible strings go through i18n** (`useTranslation`, namespace per page).
- **Keep the BFF thin:** no business logic; it proxies, authenticates, and degrades gracefully.
- **SSE query-token gate:** the deprecated `?token=` fallback is accepted only on the routes
  listed in `SSE_TOKEN_PATHS` (`server/plugins/auth.ts`). A new SSE route must be added there or
  `EventSource` auth breaks; everywhere else a query token is ignored → 401.
- **Never log a raw request URL:** the BFF installs its own Fastify `req` serializer
  (`server/log-redaction.ts`) that writes `token=[REDACTED]`. Route a new secret-bearing
  parameter through it instead of logging `request.url` directly.
- **One charting stack (#255):** `@patternfly/react-charts/victory` only — no `@nivo/*`, no direct
  `victory` dependency (both removed in #255). Size charts from your own container measurement; a
  "reserved for hatch patterns" look is a reduced-opacity fill (0.55), not a second chart library.
- **Hijacked-stream shutdown contract (#256):** any route that calls `reply.hijack()` must register
  its per-stream cleanup in the closers set from `server/routes/hijacked-streams.ts` (and remove it
  when the cleanup runs), or `server.close()` blocks on SIGTERM until the pod grace period —
  Fastify's lifecycle cannot see a hijacked response. Every closer runs in its own try/catch inside
  the single `preClose` hook.
- **Buffered upstream calls take a composed signal (#256):** pass `composeUpstreamSignal(...)`'s
  signal through the client call (timeout + client disconnect, `reply.raw`-based), classify
  rejections with `rethrowUpstreamAbort`, and never apply the timeout to a streaming/SSE route.
- **Dual-React caveat (#148, recipe proven in #176):** the root lockfile still hoists React 19.3.1
  beside the app's nested React 18.3.1 (a peer fill for the hoisted PatternFly/victory stack —
  Redocly stopped depending on React when it went to v2, so it is no longer the cause).
  `vitest.config.ts` keeps the render tree on React 18.3.1 with three levers (`mainFields` ESM-first,
  exact-file ESM aliases, `server.deps.inline` per package family); a new React-consuming test
  dependency must be added to `inline` (plus an ESM-entry alias if it only ships CJS) and get a case
  in `src/__tests__/render-probes.test.tsx`, or it binds the wrong React at first render. Details:
  [`docs/development/patternfly.md`](../docs/development/patternfly.md#unit-testing-vitest).

## Build & Test

```bash
npm run typecheck -w @sardeenz/dashboard   # + typecheck:e2e for the Playwright project
npm run test -w @sardeenz/dashboard        # vitest unit tests (src/__tests__, server/__tests__)
npm run test:e2e -w @sardeenz/dashboard    # vite build + Playwright against e2e/mocks (CI-enforced)
```

Dev: `make dev-dashboard` (Vite, `logs/dashboard.log`) and `make dev-bff` (`logs/dashboard-server.log`).
The dev server runs on the host; verify UI changes in a browser (Playwright MCP) before reporting done.
