# ADR-035: The Audit Line Records an Asserted Actor, Never an Authenticated One

## Status

Accepted. Implements [#335](https://github.com/rh-aiservices-bu/school-of-sardeenz/issues/335)
(M22). Extends [ADR-022](adr-022-fail-closed-service-tokens.md) (one service token, fail closed);
the threat model ([#337](https://github.com/rh-aiservices-bu/school-of-sardeenz/issues/337)) lists
the trust assumption as an accepted risk.

## Context

Mutating control-plane actions (deploy, start/stop, move, drain, wake, catalog import) were
attributable only to "the service token". The dashboard already knows which user asked — it verifies
a JWT on every request — but the BFF's control-plane client is a startup singleton with no request
state, so there was no obvious place to put a per-request identity.

Two facts bound what any audit line here can mean:

- **All components share one service token** (BFF, proxy, workers; ADR-022). Any holder can claim
  any actor, including one it did not authenticate. A dedicated per-caller token is out of scope.
- **A pre-handler hook cannot know the outcome.** The useful fields (`status`, and the conflict
  reason on failure) only exist after the handler has run.

## Decision

1. **The line records an _asserted_ actor.** The BFF opens an `AsyncLocalStorage` request context in
   its auth hook, records the JWT-verified username and roles, and forwards them as optional
   `x-sardeenz-actor` / `x-sardeenz-actor-roles` headers on non-GET calls. The control plane reads
   those headers **only after its own service token authenticated the request**; with no token
   configured they are never read, and a spoofed header on an unauthenticated request is ignored
   (the request is rejected, and audited as `service`).
2. **Absent means `service`.** The header is optional on every mutating operation, so the proxy's
   wake call, workers and scripts need no change and no contract edit. `actor: "service"` means only
   that no actor was asserted — a token holder may assert that literal and a user may be named
   `service`, so the value alone does not prove automation; `actorRoles`/`action`/`target`
   disambiguate.
3. **One line per mutating request, emitted from `onResponse`.** The final status is known there;
   `onError` records the reason for failures without reading `reply.statusCode`. Exactly one line is
   emitted per request, including failing ones (a failing action must still be attributable).
4. **The action table is closed and checked at boot.** `control-plane/src/utils/audit-log.ts` holds
   20 `"METHOD /api/v1/route"` names; a new mutating route without an entry fails the server build
   (`onRoute` guard) instead of going unaudited. The contract carries the optional actor header on
   all 19 mutating operations.
5. **Details are allowlisted, and everything is bounded.** `target` is a fixed key set from path
   params (plus body `modelName` for deploy/wake), `params` is a per-action allowlist
   (`force`, move pair, deployment pair). Every field that leaves the process is capped — strings
   256, actor-roles 32 from a ≤512-char header, device indices ≤64 integers, `requestId` 128 —
   because the line is retained longer than debug logs and an unbounded field is rotation pressure
   on the audit trail itself. No body, header, engine arg or token is ever logged.
6. **Attribution, not authorization.** The line is for investigation. No code path may consume it
   for access decisions; that would promote an unauthenticated assertion into a security control.

## Consequences

- A deploy, move, drain or wake can be attributed to the dashboard user who asked, in one JSON line
  per request, without a database table or a dashboard view.
- The line's actor is exactly as trustworthy as the shared token allows. A holder can frame another
  name; the record says so in the docs rather than implying non-repudiation.
- The per-request context lives in the BFF, so `AUTH_MODE=none` produces `service` lines (and still
  forwards `x-request-id` for correlation).
- A mutating route registered outside `/api/v1/` would not be audited — the guard is scoped to that
  prefix by decision.

## Non-goals

- A Postgres audit table, an audit dashboard view, or per-model permissions.
- Per-caller tokens or rotation (would make the actor authenticated; recorded as a future option).
- Auditing read-only requests or SSE streams.
- Reconstructing the request payload; the line deliberately carries only allowlisted details.
