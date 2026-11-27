import type { FastifyRequest } from 'fastify';

/** Placeholder written in place of a query token. */
export const REDACTED = '[REDACTED]';

const SECRET_PARAMS = new Set(['token', 'code']);

/**
 * Strip the value of any secret-bearing query parameter from a request URL before it is logged.
 *
 * Fastify's default request serializer logs `req.url` at info level, which would put a live
 * credential into the BFF access log verbatim. `token` is the deprecated `?token=<jwt>` SSE
 * fallback (and any `Referer`/upstream access log derived from it); `code` is a credential
 * too — both the upstream OAuth authorization code on `/api/auth/callback?code=…` and the
 * single-use exchange code on the SPA document request `/oauth/callback?code=…`, which the
 * BFF serves through its SPA fallback. Only the matched values are replaced; the rest of the
 * query string is preserved so other parameters stay debuggable, and a URL with no matching
 * parameter is returned untouched.
 */
export function redactUrlForLog(url: string): string {
  const queryStart = url.indexOf('?');
  if (queryStart === -1) return url;

  const path = url.slice(0, queryStart);
  const rawQuery = url.slice(queryStart + 1);

  // A client-supplied URL can carry a fragment after the query; keep it verbatim.
  const hashIndex = rawQuery.indexOf('#');
  const query = hashIndex === -1 ? rawQuery : rawQuery.slice(0, hashIndex);
  const fragment = hashIndex === -1 ? '' : rawQuery.slice(hashIndex);

  const params = new URLSearchParams(query);
  let redacted = false;
  for (const key of [...params.keys()]) {
    if (SECRET_PARAMS.has(key.toLowerCase())) {
      params.set(key, REDACTED);
      redacted = true;
    }
  }

  return redacted ? `${path}?${params.toString()}${fragment}` : url;
}

/**
 * Drop-in replacement for Fastify's built-in `req` serializer (same fields, redacted URL).
 * Installed in `buildServer` so every request log line — including the automatic
 * "incoming request" one — goes through the redaction.
 */
export function reqSerializer(req: FastifyRequest) {
  const acceptVersion = req.headers['accept-version'];
  return {
    method: req.method,
    url: redactUrlForLog(req.url),
    // Fastify's serializer contract types this as a single string; a repeated header is dropped.
    version: typeof acceptVersion === 'string' ? acceptVersion : undefined,
    host: req.host,
    remoteAddress: req.ip,
    remotePort: req.socket ? req.socket.remotePort : undefined,
  };
}
