import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-request store for the identity the BFF verified and the request id it will forward.
 *
 * The control-plane client is a startup singleton with no request state, and every mutating
 * call funnels through one method (`proxyRequest`); an `AsyncLocalStorage` lets that method read
 * "who is making this call" without threading an `actor` parameter through 19 methods and their
 * call sites — where a missed call site would silently attribute the action to the service.
 * `authenticate` is the only writer, so the stored actor is exactly the identity the BFF has
 * just verified (#335).
 */
export interface RequestActorContext {
  actor?: string;
  roles?: string[];
  requestId?: string;
}

const als = new AsyncLocalStorage<RequestActorContext>();

/**
 * Open the request context. The `onRequest` hook wraps `done` so the whole remaining lifecycle
 * (preHandler → handler → control-plane call) runs inside it.
 */
export function runWithRequestContext<T>(fn: () => T): T {
  return als.run({}, fn);
}

/** Record the verified identity. Called only from `authenticate` after `jwtVerify` succeeds. */
export function setActor(actor: string, roles: string[]): void {
  const store = als.getStore();
  if (store) {
    store.actor = actor;
    store.roles = roles;
  }
}

/** Record the BFF request id, forwarded as `x-request-id` for log correlation. */
export function setRequestId(requestId: string): void {
  const store = als.getStore();
  if (store) {
    store.requestId = requestId;
  }
}

/** The verified actor for the current async context, or undefined outside a request. */
export function getActor(): string | undefined {
  return als.getStore()?.actor;
}

/** The verified actor's roles, or undefined when none were captured. */
export function getActorRoles(): string[] | undefined {
  const roles = als.getStore()?.roles;
  return roles && roles.length > 0 ? roles : undefined;
}

/** The BFF request id for `x-request-id` correlation, or undefined outside a request. */
export function getRequestId(): string | undefined {
  return als.getStore()?.requestId;
}
