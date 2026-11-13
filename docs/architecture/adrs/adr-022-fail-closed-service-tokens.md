# ADR-022: Service Tokens Fail Closed; the Dev Opt-Out Is a Dev-Only Escape Hatch

## Status

Accepted. Implemented in M15 ([#234](https://github.com/rh-aiservices-bu/school-of-sardeenz/issues/234),
merged `46f204d`). Extends [ADR-013](adr-013-secrets-management.md), whose "inter-component
authentication … is a separate design decision for Phase 2" deferral this record resolves.

## Context

Both services that gate on a shared bearer token defaulted the token to the empty string:
`control-plane/src/config.ts` (`SARDEENZ_API_TOKEN`, `SARDEENZ_WORKER_TOKEN`) and
`runners/dev-worker/src/config.ts` (`SARDEENZ_WORKER_TOKEN`). The auth hooks register **iff** a
token exists, so an empty value — exactly what a `secretKeyRef` whose Secret key holds `''`
injects — silently disabled every `/api/v1/*` route and the worker API, with only a log warning.
`control-plane/AGENTS.md` claimed "every route is behind the auth hook", which was true only for
a correctly populated Secret.

## Decision

1. **Fail closed at config load.** `loadConfig()` throws, before any server is built, when
   `SARDEENZ_API_TOKEN` **or** `SARDEENZ_WORKER_TOKEN` is unset or blank (control plane — both
   required: an empty worker token makes `WorkerClient` send unauthenticated requests and 401
   every runner op at runtime, far from the config error) or when the worker's own
   `SARDEENZ_WORKER_TOKEN` is unset or blank. "Blank" includes whitespace-only values, which
   are rejected as missing; the stored value is never trimmed, so the constant-time bearer
   comparison stays byte-exact. The throw names exactly the missing variable(s) and
   the escape hatch, mirroring the `SARDEENZ_SINGLE_INSTANCE` fail-closed pattern. The process
   exits with a fatal startup error.
2. **One dev-only opt-out.** `SARDEENZ_ALLOW_UNAUTHENTICATED_API` (truthy `1/true/yes/on`,
   case-insensitive via the existing bool helpers; `false`/absent/empty reject) disables the gate.
   Tokens stay `''` under the opt-out, so auth-hook registration and warnings behave as before —
   now behind an explicit operator decision. The opt-out is documented in `.env.example` and the
   setup guide as local-development only and is **never** set in `deployment/**`.
3. **No deployment change.** In-cluster tokens already come from `secretKeyRef`
   (`sardeenz-service-tokens`); hardening the manifests is not the gate's job.

## Consequences

- A misconfigured Secret now produces a pod that fails at startup (`CreateContainerConfigError`
  or an immediate crash-loop) instead of a service that serves unauthenticated traffic.
- The BFF needs no equivalent change: it already refuses to start without `JWT_SECRET` unless
  `AUTH_MODE=none`, which production rejects.
- **Traps for a future engineer.** "Warn and boot" (the pre-M15 behavior) or adding an in-cluster
  override re-opens every protected route silently — the exact failure this ADR closes. Reusing
  the opt-out in an overlay or a platform manifest does the same. The gate is plain truthiness:
  a whitespace-only token still passes (tracked as
  [#268](https://github.com/rh-aiservices-bu/school-of-sardeenz/issues/268)).
- Tests that build `Config` objects directly (`auth-hook.test.ts`, worker `auth.test.ts`) remain
  legitimate and untouched; tests that call the real `loadConfig()` set tokens or the opt-out.

## Non-goals

- Token rotation automation, per-client tokens, and token scoping — unchanged from ADR-013.
- Replacing shared bearer tokens with mTLS or a service mesh.
