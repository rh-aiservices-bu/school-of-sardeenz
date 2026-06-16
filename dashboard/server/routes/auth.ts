import { timingSafeEqual, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { CookieSerializeOptions } from '@fastify/cookie';
import type { Config } from '../config.js';
import type { JwtPayload } from '../plugins/auth.js';

const SSE_COOKIE_NAME = 'sardeenz_sse';

function sseCookieOptions(expiresInSec: number, request: FastifyRequest): CookieSerializeOptions {
  const isLocalhost = request.hostname === 'localhost' || request.hostname.startsWith('127.');
  return {
    path: '/api/events',
    httpOnly: true,
    sameSite: 'strict',
    secure: !isLocalhost,
    maxAge: expiresInSec,
  };
}

function clearSseCookieOptions(request: FastifyRequest): CookieSerializeOptions {
  const isLocalhost = request.hostname === 'localhost' || request.hostname.startsWith('127.');
  return {
    path: '/api/events',
    httpOnly: true,
    sameSite: 'strict',
    secure: !isLocalhost,
    maxAge: 0,
  };
}

/* ------------------------------------------------------------------ */
/* Simple in-memory rate limiter                                      */
/* ------------------------------------------------------------------ */
interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX = 10; // max attempts per window
const loginAttempts = new Map<string, RateLimitEntry>();

/** @internal — exposed for test cleanup only */
export function _resetRateLimiter(): void {
  loginAttempts.clear();
}

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now >= entry.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }
  entry.count++;
  return entry.count > RATE_LIMIT_MAX;
}

// Periodic cleanup so the map doesn't grow unbounded
const CLEANUP_INTERVAL_MS = 5 * 60_000;
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of loginAttempts) {
    if (now >= entry.resetAt) loginAttempts.delete(key);
  }
}, CLEANUP_INTERVAL_MS);
cleanupTimer.unref();

/* ------------------------------------------------------------------ */
/* OAuth CSRF state store (in-memory with TTL)                        */
/* ------------------------------------------------------------------ */
const STATE_TTL_MS = 5 * 60_000; // 5 minutes
const pendingStates = new Map<string, number>(); // state → expiresAt

function createState(): string {
  const state = randomBytes(32).toString('hex');
  pendingStates.set(state, Date.now() + STATE_TTL_MS);
  return state;
}

function consumeState(state: string): boolean {
  const expiresAt = pendingStates.get(state);
  if (expiresAt === undefined) return false;
  pendingStates.delete(state);
  return Date.now() < expiresAt;
}

/* ------------------------------------------------------------------ */
/* Timing-safe string comparison                                      */
/* ------------------------------------------------------------------ */
function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // Still do a comparison to keep timing constant
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/* ------------------------------------------------------------------ */
/* Route registration                                                 */
/* ------------------------------------------------------------------ */
export function registerAuthRoutes(app: FastifyInstance, config: Config): void {
  const expiresInSec = config.jwtExpirationHours * 3600;

  // ------ GET /api/auth/config ------
  // Returns public auth configuration (no secrets).
  app.get('/api/auth/config', async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.send({ authMode: config.authMode });
  });

  // ------ Simple-mode login ------
  if (config.authMode === 'simple') {
    app.post('/api/auth/login', async (request: FastifyRequest, reply: FastifyReply) => {
      const ip = request.ip;
      if (isRateLimited(ip)) {
        return reply.code(429).send({ error: 'Too many login attempts', code: 'RATE_LIMITED' });
      }

      const body = request.body as { username?: string; password?: string } | undefined;
      const username = body?.username ?? '';
      const password = body?.password ?? '';

      const usernameOk = safeCompare(username, config.adminUsername);
      const passwordOk = safeCompare(password, config.adminPassword);

      if (!usernameOk || !passwordOk) {
        return reply.code(401).send({ error: 'Invalid credentials', code: 'UNAUTHORIZED' });
      }

      const payload: JwtPayload = {
        username: config.adminUsername,
        roles: ['admin'],
        authMode: 'simple',
      };

      const token = app.jwt.sign(payload, { expiresIn: expiresInSec });

      void reply.setCookie(SSE_COOKIE_NAME, token, sseCookieOptions(expiresInSec, request));
      return reply.send({
        token,
        expiresIn: expiresInSec,
        user: { username: payload.username, roles: payload.roles },
      });
    });
  }

  // ------ OAuth-mode routes ------
  if (config.authMode === 'oauth') {
    // GET /api/auth/login — redirect to OAuth provider
    app.get('/api/auth/login', async (_request: FastifyRequest, reply: FastifyReply) => {
      const state = createState();
      const params = new URLSearchParams({
        response_type: 'code',
        client_id: config.oauthClientId,
        redirect_uri: `${_request.protocol}://${_request.hostname}/api/auth/callback`,
        state,
        scope: 'user:info',
      });
      const authorizeUrl = `${config.oauthIssuerUrl}/authorize?${params.toString()}`;
      return reply.redirect(authorizeUrl);
    });

    // GET /api/auth/callback — exchange code for token
    app.get('/api/auth/callback', async (request: FastifyRequest, reply: FastifyReply) => {
      const query = request.query as Record<string, string>;
      const { code, state } = query;

      if (!state || !consumeState(state)) {
        return reply.code(400).send({ error: 'Invalid or expired state', code: 'INVALID_REQUEST' });
      }

      if (!code) {
        return reply.code(400).send({ error: 'Missing authorization code', code: 'INVALID_REQUEST' });
      }

      // Exchange code for OAuth token
      const tokenUrl = `${config.oauthIssuerUrl}/token`;
      const tokenRes = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          client_id: config.oauthClientId,
          client_secret: config.oauthClientSecret,
          redirect_uri: `${request.protocol}://${request.hostname}/api/auth/callback`,
        }),
      });

      if (!tokenRes.ok) {
        app.log.error({ status: tokenRes.status }, 'OAuth token exchange failed');
        return reply.code(502).send({ error: 'OAuth token exchange failed', code: 'UPSTREAM_ERROR' });
      }

      const tokenData = (await tokenRes.json()) as { access_token: string };

      // Fetch user info
      const userInfoUrl = `${config.oauthIssuerUrl}/userinfo`;
      const userInfoRes = await fetch(userInfoUrl, {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });

      let username = 'unknown';
      if (userInfoRes.ok) {
        const userInfo = (await userInfoRes.json()) as { preferred_username?: string; name?: string; sub?: string };
        username = userInfo.preferred_username ?? userInfo.name ?? userInfo.sub ?? 'unknown';
      }

      // Resolve roles via Kubernetes RBAC (if configured)
      let roles = ['admin-readonly'];
      if (config.k8sApiUrl) {
        try {
          const sarUrl = `${config.k8sApiUrl}/apis/authorization.k8s.io/v1/selfsubjectaccessreviews`;
          const sarRes = await fetch(sarUrl, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${tokenData.access_token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              apiVersion: 'authorization.k8s.io/v1',
              kind: 'SelfSubjectAccessReview',
              spec: {
                resourceAttributes: {
                  namespace: config.namespace,
                  verb: 'create',
                  resource: 'pods',
                },
              },
            }),
          });
          if (sarRes.ok) {
            const sarData = (await sarRes.json()) as { status?: { allowed?: boolean } };
            if (sarData.status?.allowed) {
              roles = ['admin'];
            }
          }
        } catch {
          app.log.warn('K8s RBAC check failed, defaulting to admin-readonly');
        }
      }

      const payload: JwtPayload = { username, roles, authMode: 'oauth' };
      const token = app.jwt.sign(payload, { expiresIn: expiresInSec });

      void reply.setCookie(SSE_COOKIE_NAME, token, sseCookieOptions(expiresInSec, request));
      return reply.redirect(`/oauth/callback#token=${token}`);
    });
  }

  // ------ GET /api/auth/me ------
  // Returns current user info from JWT. Requires authentication.
  app.get('/api/auth/me', {
    preHandler: config.authMode !== 'none'
      ? [app.authenticate]
      : [],
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (config.authMode === 'none') {
      return reply.send({ username: 'anonymous', roles: ['admin'], authMode: 'none' });
    }

    const user = request.user as JwtPayload;
    return reply.send({
      username: user.username,
      roles: user.roles,
      authMode: user.authMode,
    });
  });

  // ------ POST /api/auth/logout ------
  // Clears the SSE auth cookie.
  app.post('/api/auth/logout', async (request: FastifyRequest, reply: FastifyReply) => {
    void reply.clearCookie(SSE_COOKIE_NAME, clearSseCookieOptions(request));
    return reply.send({ ok: true });
  });
}
