import { createHash, timingSafeEqual, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { CookieSerializeOptions } from '@fastify/cookie';
import type { Config } from '../config.js';
import type { JwtPayload } from '../plugins/auth.js';
import { resolveSardeenzRoles } from '../services/kubernetes-rbac.js';

const SSE_COOKIE_NAME = 'sardeenz_sse';

function isSecureRequest(config: Config, request: FastifyRequest): boolean {
  if (config.publicUrl) {
    return config.publicUrl.startsWith('https');
  }
  return !(request.hostname === 'localhost' || request.hostname.startsWith('127.'));
}

/**
 * Behind a reverse proxy, request.protocol/hostname reflect forwarded headers which are
 * spoofable unless the proxy is trusted and strips them from client input. SARDEENZ_PUBLIC_URL
 * pins the redirect_uri to the operator-configured origin; falls back to the request for dev.
 */
function oauthRedirectUri(config: Config, request: FastifyRequest): string {
  const origin = config.publicUrl || `${request.protocol}://${request.hostname}`;
  return `${origin}/api/auth/callback`;
}

function sseCookieOptions(
  expiresInSec: number,
  config: Config,
  request: FastifyRequest,
): CookieSerializeOptions {
  return {
    path: '/api',
    httpOnly: true,
    sameSite: 'strict',
    secure: isSecureRequest(config, request),
    maxAge: expiresInSec,
  };
}

function clearSseCookieOptions(config: Config, request: FastifyRequest): CookieSerializeOptions {
  return {
    path: '/api',
    httpOnly: true,
    sameSite: 'strict',
    secure: isSecureRequest(config, request),
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

function isRateLimited(key: string): boolean {
  const now = Date.now();
  const entry = loginAttempts.get(key);
  if (!entry || now >= entry.resetAt) {
    loginAttempts.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }
  entry.count++;
  return entry.count > RATE_LIMIT_MAX;
}

function clearRateLimit(key: string): void {
  loginAttempts.delete(key);
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
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb);
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
      const body = request.body as { username?: string; password?: string } | undefined;
      const username = body?.username ?? '';
      const password = body?.password ?? '';

      const rateLimitKey = `${request.ip}:${username}`;
      if (isRateLimited(rateLimitKey)) {
        return reply.code(429).send({ error: 'Too many login attempts', code: 'RATE_LIMITED' });
      }

      const usernameOk = safeCompare(username, config.adminUsername);
      const passwordOk = safeCompare(password, config.adminPassword);

      if (!usernameOk || !passwordOk) {
        return reply.code(401).send({ error: 'Invalid credentials', code: 'UNAUTHORIZED' });
      }

      clearRateLimit(rateLimitKey);

      const payload: JwtPayload = {
        username: config.adminUsername,
        roles: ['admin'],
        authMode: 'simple',
      };

      const token = app.jwt.sign(payload, { expiresIn: expiresInSec });

      void reply.setCookie(SSE_COOKIE_NAME, token, sseCookieOptions(expiresInSec, config, request));
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
    app.get('/api/auth/login', async (request: FastifyRequest, reply: FastifyReply) => {
      const state = createState();
      const params = new URLSearchParams({
        response_type: 'code',
        client_id: config.oauthClientId,
        redirect_uri: oauthRedirectUri(config, request),
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
        return reply
          .code(400)
          .send({ error: 'Missing authorization code', code: 'INVALID_REQUEST' });
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
          redirect_uri: oauthRedirectUri(config, request),
        }),
      });

      if (!tokenRes.ok) {
        app.log.error({ status: tokenRes.status }, 'OAuth token exchange failed');
        return reply
          .code(502)
          .send({ error: 'OAuth token exchange failed', code: 'UPSTREAM_ERROR' });
      }

      const tokenData = (await tokenRes.json()) as { access_token: string };

      // OpenShift exposes the user (including group membership) from its Kubernetes API, not
      // from an OAuth /userinfo endpoint. The OAuth access token's user:info scope authorizes it.
      const userInfoUrl = `${config.k8sApiUrl}/apis/user.openshift.io/v1/users/~`;
      const userInfoRes = await fetch(userInfoUrl, {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });

      let username = 'unknown';
      let groups: string[] = [];
      if (userInfoRes.ok) {
        const userInfo = (await userInfoRes.json()) as {
          preferred_username?: string;
          name?: string;
          sub?: string;
          groups?: string[];
          metadata?: { name?: string };
        };
        username =
          userInfo.preferred_username ??
          userInfo.name ??
          userInfo.metadata?.name ??
          userInfo.sub ??
          'unknown';
        groups = userInfo.groups ?? [];
      } else {
        app.log.error({ status: userInfoRes.status }, 'OAuth user-info lookup failed');
        return reply
          .code(502)
          .send({ error: 'OAuth user-info lookup failed', code: 'UPSTREAM_ERROR' });
      }

      let roles: Array<'admin' | 'admin-readonly'>;
      try {
        roles = await resolveSardeenzRoles(config, username, groups);
      } catch (error) {
        app.log.error(error, 'Kubernetes RBAC role resolution failed');
        return reply
          .code(502)
          .send({ error: 'Kubernetes RBAC role resolution failed', code: 'UPSTREAM_ERROR' });
      }
      if (roles.length === 0) {
        app.log.warn({ username, groups }, 'OAuth user has no Sardeenz RBAC role');
        return reply.code(403).send({ error: 'Access denied', code: 'FORBIDDEN' });
      }

      const payload: JwtPayload = { username, roles, authMode: 'oauth' };
      const token = app.jwt.sign(payload, { expiresIn: expiresInSec });

      void reply.setCookie(SSE_COOKIE_NAME, token, sseCookieOptions(expiresInSec, config, request));
      return reply.redirect(`/oauth/callback#token=${token}`);
    });
  }

  // ------ GET /api/auth/me ------
  // Returns current user info from JWT. Requires authentication.
  app.get(
    '/api/auth/me',
    {
      preHandler: config.authMode !== 'none' ? [app.authenticate] : [],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (config.authMode === 'none') {
        return reply.send({ username: 'anonymous', roles: ['admin'], authMode: 'none' });
      }

      const user = request.user as JwtPayload;
      return reply.send({
        username: user.username,
        roles: user.roles,
        authMode: user.authMode,
      });
    },
  );

  // ------ POST /api/auth/logout ------
  // Clears the SSE auth cookie.
  app.post('/api/auth/logout', async (request: FastifyRequest, reply: FastifyReply) => {
    void reply.clearCookie(SSE_COOKIE_NAME, clearSseCookieOptions(config, request));
    return reply.send({ ok: true });
  });
}
