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
| `src/contexts/`     | `Auth`, `Theme`, `Notification`, `Degraded`                                                                            |
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
- **Dual-React caveat (#148):** the root hoists React 19 (via Redocly) while the app is React 18.
  `vitest.config.ts` alias-pins the whole render tree; keep new test deps ESM-importable or they
  bind the wrong React.

## Build & Test

```bash
npm run typecheck -w @sardeenz/dashboard   # + typecheck:e2e for the Playwright project
npm run test -w @sardeenz/dashboard        # vitest unit tests (src/__tests__, server/__tests__)
npm run test:e2e -w @sardeenz/dashboard    # vite build + Playwright against e2e/mocks (CI-enforced)
```

Dev: `make dev-dashboard` (Vite, `logs/dashboard.log`) and `make dev-bff` (`logs/dashboard-server.log`).
The dev server runs on the host; verify UI changes in a browser (Playwright MCP) before reporting done.
