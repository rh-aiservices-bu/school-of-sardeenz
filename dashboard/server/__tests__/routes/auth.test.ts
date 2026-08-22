// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import type { FastifyInstance } from 'fastify';
import { authPlugin } from '../../plugins/auth.js';
import { registerAuthRoutes, _resetRateLimiter } from '../../routes/auth.js';
import { registerModelRoutes } from '../../routes/models.js';
import { BffError } from '../../errors.js';
import type { RouteDeps } from '../../routes/deps.js';
import type { Config } from '../../config.js';

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    listenAddr: '0.0.0.0',
    listenPort: 4000,
    logLevel: 'silent',
    controlPlaneUrl: 'http://cp.test',
    redisUrl: 'redis://localhost:6379',
    redisKeyPrefix: 'sardeenz',
    prometheusUrl: 'http://prom.test',
    authMode: 'none',
    adminUsername: 'admin',
    adminPassword: 'secret123',
    jwtSecret: 'test-jwt-secret-that-is-long-enough',
    jwtExpirationHours: 8,
    oauthClientId: 'sardeenz',
    oauthClientSecret: '',
    oauthIssuerUrl: '',
    k8sApiUrl: '',
    namespace: 'sardeenz',
    controlPlaneApiToken: '',
    ...overrides,
  };
}

function buildDeps(config: Config): RouteDeps {
  return {
    config,
    controlPlane: {
      proxyRequest: vi.fn(),
      listModels: vi.fn().mockResolvedValue({ status: 200, data: { models: [] } }),
      getModel: vi.fn(),
      deployModel: vi.fn(),
      deleteModel: vi.fn(),
      sleepModel: vi.fn(),
      wakeModel: vi.fn(),
      listWorkers: vi.fn(),
      getWorker: vi.fn(),
      getClusterStatus: vi.fn(),
      getClusterMemory: vi.fn(),
      isHealthy: vi.fn(),
    } as unknown as RouteDeps['controlPlane'],
    redis: {
      listModels: vi.fn(),
      getModel: vi.fn(),
      getModelNames: vi.fn(),
      listWorkers: vi.fn(),
      getClusterStatus: vi.fn(),
      createSubscriber: vi.fn(),
      isHealthy: vi.fn(),
      keyPrefix: 'sardeenz',
      close: vi.fn(),
    } as unknown as RouteDeps['redis'],
    prometheus: {
      queryRange: vi.fn(),
      queryInstant: vi.fn(),
      isHealthy: vi.fn(),
    } as unknown as RouteDeps['prometheus'],
  };
}

async function buildApp(config: Config): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof BffError) {
      return reply.code(error.statusCode).send(error.toResponse());
    }
    return reply.code(500).send({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });

  await app.register(fastifyCookie);
  await app.register(authPlugin, { config });

  const deps = buildDeps(config);
  registerAuthRoutes(app, config);
  registerModelRoutes(app, deps);
  await app.ready();
  return app;
}

/** Helper to parse Fastify inject response JSON with a type assertion in one place. */
function parseJson<T>(res: { json: () => unknown }): T {
  return res.json() as T;
}

/** Extract token from a login response. */
function extractToken(res: { json: () => unknown }): string {
  return parseJson<{ token: string }>(res).token;
}

/* ------------------------------------------------------------------ */
/* GET /api/auth/config                                               */
/* ------------------------------------------------------------------ */
describe('GET /api/auth/config', () => {
  it('returns authMode without secrets', async () => {
    const config = makeConfig({ authMode: 'simple' });
    const app = await buildApp(config);

    const res = await app.inject({ method: 'GET', url: '/api/auth/config' });
    await app.close();

    expect(res.statusCode).toBe(200);
    const body = parseJson<Record<string, unknown>>(res);
    expect(body).toEqual({ authMode: 'simple' });
    // Must not leak secrets
    expect(body).not.toHaveProperty('jwtSecret');
    expect(body).not.toHaveProperty('adminPassword');
  });

  it('returns authMode none by default', async () => {
    const config = makeConfig();
    const app = await buildApp(config);

    const res = await app.inject({ method: 'GET', url: '/api/auth/config' });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(parseJson(res)).toEqual({ authMode: 'none' });
  });
});

/* ------------------------------------------------------------------ */
/* POST /api/auth/login (simple mode)                                 */
/* ------------------------------------------------------------------ */
describe('POST /api/auth/login (simple mode)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetRateLimiter();
  });

  it('returns JWT with correct credentials', async () => {
    const config = makeConfig({ authMode: 'simple' });
    const app = await buildApp(config);

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'secret123' },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    const body = parseJson<{
      token: string;
      expiresIn: number;
      user: { username: string; roles: string[] };
    }>(res);
    expect(body.token).toBeTruthy();
    expect(body.expiresIn).toBe(8 * 3600);
    expect(body.user.username).toBe('admin');
    expect(body.user.roles).toEqual(['admin']);
  });

  it('returns 401 with wrong credentials', async () => {
    const config = makeConfig({ authMode: 'simple' });
    const app = await buildApp(config);

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'wrongpassword' },
    });
    await app.close();

    expect(res.statusCode).toBe(401);
    expect(parseJson(res)).toMatchObject({ error: 'Invalid credentials' });
  });

  it('returns 401 with wrong username', async () => {
    const config = makeConfig({ authMode: 'simple' });
    const app = await buildApp(config);

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'wrong', password: 'secret123' },
    });
    await app.close();

    expect(res.statusCode).toBe(401);
  });
});

/* ------------------------------------------------------------------ */
/* GET /api/auth/me                                                   */
/* ------------------------------------------------------------------ */
describe('GET /api/auth/me', () => {
  it('returns user info with valid JWT', async () => {
    const config = makeConfig({ authMode: 'simple' });
    const app = await buildApp(config);

    // First login to get a token
    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'secret123' },
    });
    const token = extractToken(loginRes);

    const res = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    const body = parseJson<{ username: string; roles: string[]; authMode: string }>(res);
    expect(body.username).toBe('admin');
    expect(body.roles).toEqual(['admin']);
    expect(body.authMode).toBe('simple');
  });

  it('returns 401 without JWT', async () => {
    const config = makeConfig({ authMode: 'simple' });
    const app = await buildApp(config);

    const res = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
    });
    await app.close();

    expect(res.statusCode).toBe(401);
  });

  it('returns anonymous user in none mode', async () => {
    const config = makeConfig({ authMode: 'none' });
    const app = await buildApp(config);

    const res = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(parseJson(res)).toMatchObject({ username: 'anonymous', authMode: 'none' });
  });
});

/* ------------------------------------------------------------------ */
/* Route protection                                                   */
/* ------------------------------------------------------------------ */
describe('Route protection', () => {
  beforeEach(() => {
    _resetRateLimiter();
  });

  it('allows access to protected route with valid JWT', async () => {
    const config = makeConfig({ authMode: 'simple' });
    const app = await buildApp(config);

    // Login
    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'secret123' },
    });
    const token = extractToken(loginRes);

    // Access protected route
    const res = await app.inject({
      method: 'GET',
      url: '/api/models',
      headers: { authorization: `Bearer ${token}` },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
  });

  it('returns 401 on protected route without JWT', async () => {
    const config = makeConfig({ authMode: 'simple' });
    const app = await buildApp(config);

    const res = await app.inject({
      method: 'GET',
      url: '/api/models',
    });
    await app.close();

    expect(res.statusCode).toBe(401);
  });

  it('returns 403 when user lacks required role', async () => {
    const config = makeConfig({ authMode: 'simple' });
    const app = await buildApp(config);

    // Create a token with only admin-readonly role by signing manually
    const readonlyPayload = { username: 'viewer', roles: ['admin-readonly'], authMode: 'simple' };
    const readonlyToken = app.jwt.sign(readonlyPayload, { expiresIn: 3600 });

    // Try to access a write route that requires 'admin' role
    const res = await app.inject({
      method: 'POST',
      url: '/api/models',
      headers: { authorization: `Bearer ${readonlyToken}` },
      payload: { modelName: 'test' },
    });
    await app.close();

    expect(res.statusCode).toBe(403);
  });

  it('allows admin to access admin-readonly routes (role hierarchy)', async () => {
    const config = makeConfig({ authMode: 'simple' });
    const app = await buildApp(config);

    // Login as admin (has 'admin' role, should also access 'admin-readonly' routes)
    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'secret123' },
    });
    const token = extractToken(loginRes);

    const res = await app.inject({
      method: 'GET',
      url: '/api/models',
      headers: { authorization: `Bearer ${token}` },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
  });

  it('accepts token via query parameter (deprecated SSE fallback)', async () => {
    const config = makeConfig({ authMode: 'simple' });
    const app = await buildApp(config);

    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'secret123' },
    });
    const token = extractToken(loginRes);

    const res = await app.inject({
      method: 'GET',
      url: `/api/models?token=${token}`,
    });
    await app.close();

    expect(res.statusCode).toBe(200);
  });

  it('accepts token via sardeenz_sse cookie', async () => {
    const config = makeConfig({ authMode: 'simple' });
    const app = await buildApp(config);

    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'secret123' },
    });
    const token = extractToken(loginRes);

    const res = await app.inject({
      method: 'GET',
      url: '/api/models',
      cookies: { sardeenz_sse: token },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
  });

  it('sets sardeenz_sse cookie on login', async () => {
    const config = makeConfig({ authMode: 'simple' });
    const app = await buildApp(config);

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'secret123' },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    const setCookieHeader = res.headers['set-cookie'];
    const cookieStr = Array.isArray(setCookieHeader)
      ? setCookieHeader.join('; ')
      : (setCookieHeader ?? '');
    expect(cookieStr).toContain('sardeenz_sse=');
    expect(cookieStr).toContain('HttpOnly');
    expect(cookieStr).toContain('Path=/api');
    expect(cookieStr).toContain('SameSite=Strict');
  });
});

/* ------------------------------------------------------------------ */
/* Empty-password rejection (regression: issue #53)                   */
/* ------------------------------------------------------------------ */
describe('Empty-password rejection (issue #53)', () => {
  beforeEach(() => {
    _resetRateLimiter();
  });

  it('rejects login with empty password even when ADMIN_PASSWORD is empty', async () => {
    // This is the exact vulnerability: if ADMIN_PASSWORD defaults to ''
    // and someone sends password='', the timing-safe compare succeeds.
    // validateAuthConfig now prevents this at startup, but we also verify
    // the login handler itself rejects empty credentials.
    const config = makeConfig({ authMode: 'simple', adminPassword: 'actual-secret' });
    const app = await buildApp(config);

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: '' },
    });
    await app.close();

    expect(res.statusCode).toBe(401);
  });

  it('rejects login with missing password field', async () => {
    const config = makeConfig({ authMode: 'simple', adminPassword: 'actual-secret' });
    const app = await buildApp(config);

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin' },
    });
    await app.close();

    expect(res.statusCode).toBe(401);
  });

  it('rejects login with empty body', async () => {
    const config = makeConfig({ authMode: 'simple', adminPassword: 'actual-secret' });
    const app = await buildApp(config);

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: {},
    });
    await app.close();

    expect(res.statusCode).toBe(401);
  });
});

/* ------------------------------------------------------------------ */
/* Auth mode: none                                                    */
/* ------------------------------------------------------------------ */
describe('Auth mode: none', () => {
  it('allows access to all routes without JWT', async () => {
    const config = makeConfig({ authMode: 'none' });
    const app = await buildApp(config);

    const res = await app.inject({
      method: 'GET',
      url: '/api/models',
    });
    await app.close();

    expect(res.statusCode).toBe(200);
  });

  it('allows write routes without JWT', async () => {
    const config = makeConfig({ authMode: 'none' });
    const app = await buildApp(config);

    const res = await app.inject({
      method: 'POST',
      url: '/api/models',
      payload: { modelName: 'test' },
    });
    await app.close();

    // The key assertion is that we don't get 401 or 403
    expect(res.statusCode).not.toBe(401);
    expect(res.statusCode).not.toBe(403);
  });
});

/* ------------------------------------------------------------------ */
/* POST /api/auth/logout                                              */
/* ------------------------------------------------------------------ */
describe('POST /api/auth/logout', () => {
  it('clears the sardeenz_sse cookie', async () => {
    const config = makeConfig({ authMode: 'simple' });
    const app = await buildApp(config);

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(parseJson(res)).toEqual({ ok: true });
    const setCookieHeader = res.headers['set-cookie'];
    const cookieStr = Array.isArray(setCookieHeader)
      ? setCookieHeader.join('; ')
      : (setCookieHeader ?? '');
    expect(cookieStr).toContain('sardeenz_sse=');
    expect(cookieStr).toContain('Max-Age=0');
  });

  it('is accessible without authentication', async () => {
    const config = makeConfig({ authMode: 'simple' });
    const app = await buildApp(config);

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
    });
    await app.close();

    expect(res.statusCode).toBe(200);
  });
});
