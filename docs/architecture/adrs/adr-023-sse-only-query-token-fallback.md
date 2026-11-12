# ADR-023: The `?token=` SSE Fallback Is Kept but Path-Gated

## Status

Accepted. Implemented in M15 ([#237](https://github.com/rh-aiservices-bu/school-of-sardeenz/issues/237),
merged `46f204d`). First record of the SSE auth mechanism: the Phase 3 change that introduced
the fallback ([#66](https://github.com/rh-aiservices-bu/school-of-sardeenz/pull/66)) was never
recorded as an ADR.

## Context

`EventSource` cannot set request headers, so the dashboard BFF's token extractor accepted a
`?token=<jwt>` query parameter on **every** protected route. That authenticated state-changing
POST/DELETE calls from a URL and wrote tokens into access logs, browser history and `Referer`
headers — the concern that motivated #66's partial remediation and the #237 finding. The
`sardeenz_sse` HttpOnly cookie (Path=/api, SameSite=Strict) was added later as the intended SSE
mechanism but did not make the query fallback narrower.

## Decision

1. **Keep the fallback, exactly three routes.** The query token is honored only on
   `GET /api/events`, `GET /api/models/:name/logs` and
   `GET /api/models/:name/instances/:instanceId/startup-logs`, matched segment-wise on the
   query-stripped path (`SSE_TOKEN_PATHS` in `dashboard/server/plugins/auth.ts`). On every other
   route a query token is ignored and the request answers 401 through the ordinary missing-token
   path.
2. **The cookie stays the primary SSE credential.** The `sardeenz_sse` cookie and the
   `Authorization: Bearer` header clauses are unchanged; `AUTH_MODE=none` installs no extractor
   at all.
3. **The deprecation warning logs the query-stripped path only**, and only when a query token is
   actually accepted — the token itself must never reach the log.

## Consequences

- A future SSE route must be added to `SSE_TOKEN_PATHS` or browser `EventSource` auth breaks —
  the matcher's one place to extend, recorded in `dashboard/AGENTS.md`.
- Any route that "temporarily" accepts the query token outside that list re-opens the leak; the
  gate is the enforcement point, not documentation.
- **Closed residual risk (was accepted at M15):** Fastify's default request logger recorded the
  full URL (including `?token=`) for every request. The BFF now installs its own `req` serializer
  (`dashboard/server/log-redaction.ts`) that writes `token=[REDACTED]` and leaves other query
  parameters intact — [#269](https://github.com/rh-aiservices-bu/school-of-sardeenz/issues/269).
  The URL-fragment transit half of the problem remains #136 (Parking Lot).
- **Rejected alternatives.** Removing the fallback entirely breaks `EventSource` for authed
  browsers where third-party-cookie restrictions block the cookie; allowing it globally is the
  pre-M15 leak.

## Non-goals

- URL-fragment token transit (#136).
- Method- or content-type-based gating; an authenticated non-GET on an SSE path is harmless (the
  routes are GET-only and 404 otherwise).
