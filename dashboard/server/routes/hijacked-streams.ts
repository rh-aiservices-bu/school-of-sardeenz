import type { FastifyInstance } from 'fastify';

/**
 * Per-app registry of closers for responses the BFF hijacks with `reply.hijack()`: the
 * Redis-backed `/api/events` SSE relay, the control-plane model-log tail and the streaming
 * chat-completions proxy.
 *
 * A hijacked response is invisible to Fastify's request lifecycle — the route handler awaits the
 * client, not the other way round — so `server.close()` waits for the browser to hang up. A
 * dashboard tab never does, which left a rolling restart sitting on SIGTERM until the pod's grace
 * period killed it. `preClose` runs before the listener stops (and before `server.close()`, so the
 * sockets are still writable); running every live stream's cleanup there ends the stream, and the
 * browsers/proxied clients reconnect to whichever replica takes over.
 *
 * One registry and one hook per Fastify instance: every route module asks for the same set, so
 * the hook is registered exactly once and during route registration (Fastify refuses hooks added
 * after the instance is listening).
 */
const registries = new WeakMap<FastifyInstance, Set<() => void>>();

export function hijackedStreamClosers(app: FastifyInstance): Set<() => void> {
  const existing = registries.get(app);
  if (existing) return existing;

  const closers = new Set<() => void>();
  registries.set(app, closers);

  app.addHook('preClose', (done) => {
    for (const close of [...closers]) {
      try {
        close();
      } catch (err) {
        // One wedged stream must not keep the others open: a closer that throws would skip the
        // rest of the loop, and `done()` never being called would hang `app.close()` — the very
        // failure this hook exists to prevent.
        app.log.warn({ err }, 'Failed to end a hijacked stream during shutdown');
      }
    }
    closers.clear();
    done();
  });

  return closers;
}
