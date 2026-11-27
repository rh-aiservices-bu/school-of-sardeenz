// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import type { FastifyInstance } from 'fastify';
import { authPlugin } from '../../plugins/auth.js';
import { registerAuthRoutes, _resetRateLimiter, _resetExchangeCodes } from '../../routes/auth.js';
import { registerModelRoutes } from '../../routes/models.js';
import { registerModelLogRoutes } from '../../routes/model-logs.js';
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
    prometheusBearerTokenPath: '',
    prometheusCaPath: '',
    prometheusTenantNamespace: '',
    inferenceUrl: 'http://inference.test',
    maxConcurrentInferenceRequestsPerUser: 4,
    upstreamTimeoutMs: 15_000,
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
    publicUrl: '',
    repoStatsUrl: '',
    ...overrides,
  };
}

const proxyRequestFn = vi.fn();

function buildDeps(config: Config): RouteDeps {
  return {
    config,
    controlPlane: {
      proxyRequest: proxyRequestFn,
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
    inference: {
      chatCompletions: vi.fn(),
      isHealthy: vi.fn(),
    } as unknown as RouteDeps['inference'],
    githubRepoStats: {
      getStats: () => Promise.resolve({ stars: null, forks: null, fetchedAt: null }),
      setLogger: () => {},
    } as unknown as RouteDeps['githubRepoStats'],
  };
}

async function buildApp(
  config: Config,
  decorate?: (app: FastifyInstance) => void,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, trustProxy: true });
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
  registerModelLogRoutes(app, deps);
  decorate?.(app);
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

/** Builds a fake upstream `Response` whose body streams the given SSE-frame strings. */
function makeUpstreamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream);
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
/* OAuth + OpenShift RBAC                                              */
/* ------------------------------------------------------------------ */
describe('OpenShift OAuth login', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('gets identity and groups from the OpenShift Kubernetes API before resolving marker roles', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'oauth-access-token' })))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ metadata: { name: 'alice' }, groups: ['platform-admins'] })),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: { allowed: true } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: { allowed: false } })));
    vi.stubGlobal('fetch', fetchMock);

    const config = makeConfig({
      authMode: 'oauth',
      oauthClientSecret: 'oauth-secret',
      oauthIssuerUrl: 'https://oauth.example.com/oauth',
      k8sApiUrl: 'https://kubernetes.default.svc',
      serviceAccountToken: 'reviewer-token',
      publicUrl: 'https://dashboard.example.com',
    });
    const app = await buildApp(config);
    const login = await app.inject({ method: 'GET', url: '/api/auth/login' });
    const state = new URL(login.headers.location ?? '').searchParams.get('state');
    const callback = await app.inject({
      method: 'GET',
      url: `/api/auth/callback?code=authorization-code&state=${state}`,
    });
    await app.close();

    expect(callback.statusCode).toBe(302);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      'https://kubernetes.default.svc/apis/user.openshift.io/v1/users/~',
    );
    expect(fetchMock.mock.calls[2]?.[0]).toContain('/localsubjectaccessreviews');
  });
});

/* ------------------------------------------------------------------ */
/* POST /api/auth/exchange — single-use code handoff (issue #136)      */
/* ------------------------------------------------------------------ */
describe('POST /api/auth/exchange (oauth mode)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetRateLimiter();
    _resetExchangeCodes();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const oauthConfig = () =>
    makeConfig({
      authMode: 'oauth',
      oauthClientSecret: 'oauth-secret',
      oauthIssuerUrl: 'https://oauth.example.com/oauth',
      k8sApiUrl: 'https://kubernetes.default.svc',
      serviceAccountToken: 'reviewer-token',
      publicUrl: 'https://dashboard.example.com',
    });

  /** Answer the callback's upstream calls: token, OpenShift user, two marker-role reviews. */
  function stubOauthFetch(): void {
    const fetchMock = vi.fn((input: string, init?: RequestInit): Promise<Response> => {
      if (input.endsWith('/token')) {
        return Promise.resolve(
          new Response(JSON.stringify({ access_token: 'oauth-access-token' })),
        );
      }
      if (input.includes('/apis/user.openshift.io/v1/users/~')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ metadata: { name: 'alice' }, groups: ['platform-admins'] }),
          ),
        );
      }
      // LocalSubjectAccessReview — only the `admin` marker role is granted.
      const rawBody = init?.body;
      const request = JSON.parse(typeof rawBody === 'string' ? rawBody : '{}') as {
        spec?: { resourceAttributes?: { resource?: string } };
      };
      const allowed = request.spec?.resourceAttributes?.resource === 'admin';
      return Promise.resolve(new Response(JSON.stringify({ status: { allowed } })));
    });
    vi.stubGlobal('fetch', fetchMock);
  }

  /** Runs the login redirect + callback and returns the callback response. */
  async function runCallback(app: FastifyInstance) {
    const login = await app.inject({ method: 'GET', url: '/api/auth/login' });
    const state = new URL(login.headers.location ?? '').searchParams.get('state');
    return app.inject({
      method: 'GET',
      url: `/api/auth/callback?code=authorization-code&state=${state}`,
    });
  }

  /** Mints a fresh exchange code through the callback and returns it. */
  async function mintCode(app: FastifyInstance): Promise<string> {
    const callback = await runCallback(app);
    expect(callback.statusCode).toBe(302);
    const location = callback.headers.location ?? '';
    return new URL(location, 'https://dashboard.example.com').searchParams.get('code') ?? '';
  }

  it('redirects to a single opaque exchange code, never the token', async () => {
    stubOauthFetch();
    const app = await buildApp(oauthConfig());

    const callback = await runCallback(app);
    await app.close();

    expect(callback.statusCode).toBe(302);
    const location = callback.headers.location ?? '';
    expect(location).toMatch(/^\/oauth\/callback\?code=[0-9a-f]{64}$/);
    const params = new URL(location, 'https://dashboard.example.com').searchParams;
    expect([...params.keys()]).toEqual(['code']);
    expect(location).not.toContain('token=');
    expect(location).not.toContain('eyJ');
  });

  it('exchanges the code for the callback-issued JWT', async () => {
    stubOauthFetch();
    const app = await buildApp(oauthConfig());

    const code = await mintCode(app);
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/exchange',
      payload: { code },
    });

    expect(res.statusCode).toBe(200);
    const body = parseJson<{ token: string; expiresIn: number }>(res);
    expect(body.expiresIn).toBe(8 * 3600);
    const verified = app.jwt.verify<{ username: string; roles: string[] }>(body.token);
    await app.close();

    expect(verified.username).toBe('alice');
    expect(verified.roles).toEqual(['admin']);
  });

  it('invalidates the code on first use', async () => {
    stubOauthFetch();
    const app = await buildApp(oauthConfig());

    const code = await mintCode(app);
    const first = await app.inject({
      method: 'POST',
      url: '/api/auth/exchange',
      payload: { code },
    });
    const second = await app.inject({
      method: 'POST',
      url: '/api/auth/exchange',
      payload: { code },
    });
    await app.close();

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(400);
    expect(parseJson(second)).toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('issues no token when a consumed code is replayed', async () => {
    stubOauthFetch();
    const app = await buildApp(oauthConfig());

    const code = await mintCode(app);
    await app.inject({ method: 'POST', url: '/api/auth/exchange', payload: { code } });
    const second = await app.inject({
      method: 'POST',
      url: '/api/auth/exchange',
      payload: { code },
    });
    const third = await app.inject({
      method: 'POST',
      url: '/api/auth/exchange',
      payload: { code },
    });
    await app.close();

    expect(second.statusCode).toBe(400);
    expect('token' in parseJson<Record<string, unknown>>(second)).toBe(false);
    expect(third.statusCode).toBe(400);
    expect('token' in parseJson<Record<string, unknown>>(third)).toBe(false);
  });

  it('rejects a code past its TTL', async () => {
    stubOauthFetch();
    const app = await buildApp(oauthConfig());

    const code = await mintCode(app);
    const now = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now + 61_000);
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/exchange',
      payload: { code },
    });
    await app.close();

    expect(res.statusCode).toBe(400);
    expect(parseJson(res)).toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('rejects an unknown code', async () => {
    const app = await buildApp(oauthConfig());

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/exchange',
      payload: { code: 'a'.repeat(64) },
    });
    await app.close();

    expect(res.statusCode).toBe(400);
    expect(parseJson(res)).toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('rejects a missing or non-string code with 400, never 500', async () => {
    const app = await buildApp(oauthConfig());

    const noBody = await app.inject({ method: 'POST', url: '/api/auth/exchange' });
    const emptyBody = await app.inject({
      method: 'POST',
      url: '/api/auth/exchange',
      payload: {},
    });
    const nonString = await app.inject({
      method: 'POST',
      url: '/api/auth/exchange',
      payload: { code: 42 },
    });
    await app.close();

    for (const res of [noBody, emptyBody, nonString]) {
      expect(res.statusCode).toBe(400);
      expect(parseJson(res)).toMatchObject({ code: 'INVALID_REQUEST' });
    }
  });

  it('rate-limits a broken IP but not other clients', async () => {
    stubOauthFetch();
    const app = await buildApp(oauthConfig());

    const badCode = { code: 'a'.repeat(64) };
    for (let i = 0; i < 10; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/exchange',
        payload: badCode,
        headers: { 'x-forwarded-for': '10.0.0.1' },
      });
      expect(res.statusCode).toBe(400);
    }
    const blocked = await app.inject({
      method: 'POST',
      url: '/api/auth/exchange',
      payload: badCode,
      headers: { 'x-forwarded-for': '10.0.0.1' },
    });
    const otherIp = await app.inject({
      method: 'POST',
      url: '/api/auth/exchange',
      payload: badCode,
      headers: { 'x-forwarded-for': '10.0.0.2' },
    });
    await app.close();

    expect(blocked.statusCode).toBe(429);
    expect(parseJson(blocked)).toMatchObject({ code: 'RATE_LIMITED' });
    expect(otherIp.statusCode).toBe(400);
  });

  it('clears the rate-limit bucket on a successful exchange', async () => {
    stubOauthFetch();
    const app = await buildApp(oauthConfig());

    for (let i = 0; i < 9; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/exchange',
        payload: { code: 'a'.repeat(64) },
        headers: { 'x-forwarded-for': '10.0.0.3' },
      });
      expect(res.statusCode).toBe(400);
    }

    const code = await mintCode(app);
    const valid = await app.inject({
      method: 'POST',
      url: '/api/auth/exchange',
      payload: { code },
      headers: { 'x-forwarded-for': '10.0.0.3' },
    });
    // A rate-limited request must never burn the code, so a second minted code is needed.
    const nextCode = await mintCode(app);
    const next = await app.inject({
      method: 'POST',
      url: '/api/auth/exchange',
      payload: { code: nextCode },
      headers: { 'x-forwarded-for': '10.0.0.3' },
    });
    await app.close();

    expect(valid.statusCode).toBe(200);
    expect(next.statusCode).toBe(200);
  });

  it('is reachable without an Authorization header (public allowlist entry)', async () => {
    const app = await buildApp(oauthConfig());

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/exchange',
      payload: { code: 'a'.repeat(64) },
    });
    await app.close();

    expect(res.statusCode).toBe(400);
    expect(parseJson(res)).toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('does not exist outside oauth mode', async () => {
    const noneApp = await buildApp(makeConfig({ authMode: 'none' }));
    const simpleApp = await buildApp(makeConfig({ authMode: 'simple' }));

    const noneRes = await noneApp.inject({
      method: 'POST',
      url: '/api/auth/exchange',
      payload: { code: 'a'.repeat(64) },
    });
    const simpleRes = await simpleApp.inject({
      method: 'POST',
      url: '/api/auth/exchange',
      payload: { code: 'a'.repeat(64) },
    });
    await noneApp.close();
    await simpleApp.close();

    expect(noneRes.statusCode).toBe(404);
    expect(simpleRes.statusCode).toBe(404);
  });

  it('sets the SSE cookie on the callback but no cookie on the exchange', async () => {
    stubOauthFetch();
    const app = await buildApp(oauthConfig());

    const callback = await runCallback(app);
    const callbackCookies = callback.headers['set-cookie'];
    const callbackCookieStr = Array.isArray(callbackCookies)
      ? callbackCookies.join('; ')
      : (callbackCookies ?? '');
    const code = new URL(
      callback.headers.location ?? '',
      'https://dashboard.example.com',
    ).searchParams.get('code');

    const exchange = await app.inject({
      method: 'POST',
      url: '/api/auth/exchange',
      payload: { code },
    });
    await app.close();

    expect(callbackCookieStr).toContain('sardeenz_sse=');
    expect(exchange.statusCode).toBe(200);
    expect(exchange.headers['set-cookie']).toBeUndefined();
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
/* Rate limiter hardening (issue #105)                                 */
/* ------------------------------------------------------------------ */
describe('POST /api/auth/login rate limiter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetRateLimiter();
  });

  it('does not share a rate-limit bucket across different IPs', async () => {
    const config = makeConfig({ authMode: 'simple' });
    const app = await buildApp(config);

    // Exhaust the limit for one IP with wrong credentials.
    for (let i = 0; i < 10; i++) {
      await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'admin', password: 'wrong' },
        headers: { 'x-forwarded-for': '10.0.0.1' },
      });
    }
    const blockedRes = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'wrong' },
      headers: { 'x-forwarded-for': '10.0.0.1' },
    });
    expect(blockedRes.statusCode).toBe(429);

    // A different IP attempting the same username must not be blocked.
    const otherIpRes = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'secret123' },
      headers: { 'x-forwarded-for': '10.0.0.2' },
    });
    await app.close();

    expect(otherIpRes.statusCode).toBe(200);
  });

  it('does not share a rate-limit bucket across different usernames on the same IP', async () => {
    const config = makeConfig({ authMode: 'simple' });
    const app = await buildApp(config);

    for (let i = 0; i < 10; i++) {
      await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'admin', password: 'wrong' },
      });
    }
    const blockedRes = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'wrong' },
    });
    expect(blockedRes.statusCode).toBe(429);

    const otherUserRes = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'someone-else', password: 'wrong' },
    });
    await app.close();

    expect(otherUserRes.statusCode).toBe(401);
  });

  it('clears the rate-limit bucket on successful login', async () => {
    const config = makeConfig({ authMode: 'simple' });
    const app = await buildApp(config);

    for (let i = 0; i < 9; i++) {
      await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'admin', password: 'wrong' },
      });
    }

    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'secret123' },
    });
    expect(loginRes.statusCode).toBe(200);

    // Bucket was cleared, so a fresh set of attempts should not be immediately blocked.
    const nextRes = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'secret123' },
    });
    await app.close();

    expect(nextRes.statusCode).toBe(200);
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

  it('rejects token via query parameter on non-SSE routes (fallback is SSE-only, #237)', async () => {
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

    expect(res.statusCode).toBe(401);
  });

  it('rejects token via query parameter on a protected non-SSE POST (#237)', async () => {
    const config = makeConfig({ authMode: 'simple' });
    const app = await buildApp(config);

    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'secret123' },
    });
    const token = extractToken(loginRes);

    const res = await app.inject({
      method: 'POST',
      url: `/api/models?token=${token}`,
      payload: { modelName: 'test-model' },
    });
    await app.close();

    expect(res.statusCode).toBe(401);
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
/* Query-token fallback restricted to SSE routes (issue #237)          */
/* ------------------------------------------------------------------ */
describe('Query-token fallback restricted to SSE routes (issue #237)', () => {
  /**
   * Hijack-and-end twin of the real /api/events route. The real handler
   * (routes/events.ts:112,153-156) hijacks the socket and awaits client
   * close, so `app.inject` never resolves while the stream is open. The
   * unit under test is the plugin's extractToken gate, not the SSE
   * plumbing, so the twin keeps the real route's preHandler shape
   * ([authenticate, requireRole('admin-readonly')]) and ends immediately.
   * NEVER register this twin alongside `registerEventRoutes` on the same
   * app — Fastify throws on duplicate method+path.
   * Keep in sync with the real registration at server/routes/events.ts:64-66.
   */
  const withEventsTwin = (app: FastifyInstance): void => {
    app.get(
      '/api/events',
      { preHandler: [app.authenticate, app.requireRole('admin-readonly')] },
      async (_request, reply) => {
        reply.hijack();
        reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream' });
        reply.raw.end('event: end\ndata: {}\n\n');
      },
    );
  };

  /** Sign directly (pattern: model-logs.test.ts:236-239) — no login round-trip, no rate limiter. */
  const signAdminToken = (app: FastifyInstance): string =>
    app.jwt.sign({ username: 'admin', roles: ['admin'], authMode: 'simple' }, { expiresIn: 3600 });

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('accepts ?token=<valid> on GET /api/models/:name/logs (SSE)', async () => {
    proxyRequestFn.mockResolvedValue(makeUpstreamResponse(['event: end\ndata: {}\n\n']));
    const app = await buildApp(makeConfig({ authMode: 'simple' }));

    const res = await app.inject({
      method: 'GET',
      url: `/api/models/llama-3/logs?token=${signAdminToken(app)}`,
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream');
    expect(res.payload).toContain('event: end');
    expect(proxyRequestFn).toHaveBeenCalledWith('GET', '/api/v1/models/llama-3/logs');
  });

  it('accepts ?token=<valid> on GET /api/models/:name/instances/:instanceId/startup-logs (SSE)', async () => {
    proxyRequestFn.mockResolvedValue(
      makeUpstreamResponse(['event: log\ndata: {"content":"boot"}\n\n']),
    );
    const app = await buildApp(makeConfig({ authMode: 'simple' }));

    const res = await app.inject({
      method: 'GET',
      url: `/api/models/llama-3/instances/inst-b/startup-logs?token=${signAdminToken(app)}`,
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('boot');
  });

  it('accepts ?token=<valid> with percent-encoded parametric ids (segment count stable)', async () => {
    proxyRequestFn.mockResolvedValue(makeUpstreamResponse(['event: end\ndata: {}\n\n']));
    const app = await buildApp(makeConfig({ authMode: 'simple' }));

    const res = await app.inject({
      method: 'GET',
      url: `/api/models/my%2Fmodel/instances/inst%2Fb/startup-logs?token=${signAdminToken(app)}`,
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(proxyRequestFn).toHaveBeenCalledWith(
      'GET',
      '/api/v1/models/my%2Fmodel/instances/inst%2Fb/startup-logs',
    );
  });

  it('accepts ?token=<valid> on GET /api/events (route-level double)', async () => {
    const app = await buildApp(makeConfig({ authMode: 'simple' }), withEventsTwin);

    const res = await app.inject({
      method: 'GET',
      url: `/api/events?token=${signAdminToken(app)}`,
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('event: end');
  });

  it('returns 401 for an invalid token on GET /api/events (gate admits, signature rejects)', async () => {
    const app = await buildApp(makeConfig({ authMode: 'simple' }), withEventsTwin);

    const res = await app.inject({ method: 'GET', url: '/api/events?token=not-a-jwt' });
    await app.close();

    expect(res.statusCode).toBe(401);
  });

  it('returns 401 when no token is present on GET /api/events (fallback is opt-in per request)', async () => {
    const app = await buildApp(makeConfig({ authMode: 'simple' }), withEventsTwin);

    const res = await app.inject({ method: 'GET', url: '/api/events' });
    await app.close();

    expect(res.statusCode).toBe(401);
  });

  it('returns 401 for an invalid token on a parametric SSE route', async () => {
    const app = await buildApp(makeConfig({ authMode: 'simple' }));

    const res = await app.inject({
      method: 'GET',
      url: '/api/models/llama-3/logs?token=not-a-jwt',
    });
    await app.close();

    expect(res.statusCode).toBe(401);
    expect(proxyRequestFn).not.toHaveBeenCalled();
  });

  it('returns 401 for a valid token on the near-miss non-SSE route /api/models/:name/startup-logs', async () => {
    // Pins the matcher's last-segment invariant: this 4-segment JSON route
    // (server/routes/models.ts:61) differs from the SSE `logs` pattern only in
    // its final literal; a suffix-style widening of SSE_TOKEN_PATHS must not
    // silently open the query fallback to it.
    const app = await buildApp(makeConfig({ authMode: 'simple' }));

    const res = await app.inject({
      method: 'GET',
      url: `/api/models/llama-3/startup-logs?token=${signAdminToken(app)}`,
    });
    await app.close();

    expect(res.statusCode).toBe(401);
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
