// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import type { FastifyInstance } from 'fastify';
import { registerModelLogRoutes } from '../../routes/model-logs.js';
import { authPlugin } from '../../plugins/auth.js';
import { registerAuthRoutes } from '../../routes/auth.js';
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
    corsOrigin: 'http://localhost:5173',
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

const proxyRequestFn = vi.fn();

function buildDeps(config: Config): RouteDeps {
  return {
    config,
    controlPlane: {
      proxyRequest: proxyRequestFn,
      listModels: vi.fn(),
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
  registerModelLogRoutes(app, buildDeps(config));
  await app.ready();
  return app;
}

/** Builds an app with both auth routes and model-log routes registered, for cookie-flow tests. */
async function buildAppWithAuth(config: Config): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof BffError) {
      return reply.code(error.statusCode).send(error.toResponse());
    }
    return reply.code(500).send({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });

  await app.register(fastifyCookie);
  await app.register(authPlugin, { config });
  registerAuthRoutes(app, config);
  registerModelLogRoutes(app, buildDeps(config));
  await app.ready();
  return app;
}

/** Builds a fake upstream `Response` whose body streams the given SSE-frame strings. */
function makeUpstreamResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, { status });
}

describe('GET /api/models/:name/logs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('pipes the upstream SSE stream through to the client', async () => {
    const logFrame = `event: log\ndata: ${JSON.stringify({
      ts: '2026-08-20T00:00:00.000Z',
      stream: 'stdout',
      content: 'Loading weights...',
    })}\n\n`;
    const endFrame = 'event: end\ndata: {}\n\n';
    proxyRequestFn.mockResolvedValue(makeUpstreamResponse([logFrame, endFrame]));

    const app = await buildApp(makeConfig());
    const res = await app.inject({ method: 'GET', url: '/api/models/llama-3/logs' });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream');
    expect(res.payload).toContain('event: log');
    expect(res.payload).toContain('Loading weights...');
    expect(res.payload).toContain('event: end');
    expect(proxyRequestFn).toHaveBeenCalledWith('GET', '/api/v1/models/llama-3/logs');
  });

  it('encodes the model name in the upstream path', async () => {
    proxyRequestFn.mockResolvedValue(makeUpstreamResponse([]));

    const app = await buildApp(makeConfig());
    await app.inject({ method: 'GET', url: '/api/models/my%2Fmodel/logs' });
    await app.close();

    expect(proxyRequestFn).toHaveBeenCalledWith('GET', '/api/v1/models/my%2Fmodel/logs');
  });

  it('surfaces a 404 from the control plane as JSON before hijacking', async () => {
    proxyRequestFn.mockResolvedValue(
      new Response(JSON.stringify({ error: 'Not found: unknown-model', code: 'NOT_FOUND' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const app = await buildApp(makeConfig());
    const res = await app.inject({ method: 'GET', url: '/api/models/unknown-model/logs' });
    await app.close();

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'Not found: unknown-model' });
  });

  it('returns 502 when the control plane is unreachable', async () => {
    proxyRequestFn.mockRejectedValue(new Error('ECONNREFUSED'));

    const app = await buildApp(makeConfig());
    const res = await app.inject({ method: 'GET', url: '/api/models/llama-3/logs' });
    await app.close();

    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ code: 'UPSTREAM_ERROR' });
  });

  describe('auth enforcement', () => {
    it('returns 401 without a JWT when AUTH_MODE=simple', async () => {
      const app = await buildApp(makeConfig({ authMode: 'simple' }));
      const res = await app.inject({ method: 'GET', url: '/api/models/llama-3/logs' });
      await app.close();

      expect(res.statusCode).toBe(401);
      expect(proxyRequestFn).not.toHaveBeenCalled();
    });

    it('accepts the sardeenz_sse cookie (EventSource cannot set headers)', async () => {
      proxyRequestFn.mockResolvedValue(makeUpstreamResponse(['event: end\ndata: {}\n\n']));
      const config = makeConfig({ authMode: 'simple' });
      const app = await buildApp(config);

      const token = app.jwt.sign(
        { username: 'admin', roles: ['admin'], authMode: 'simple' },
        { expiresIn: 3600 },
      );

      const res = await app.inject({
        method: 'GET',
        url: '/api/models/llama-3/logs',
        cookies: { sardeenz_sse: token },
      });
      await app.close();

      expect(res.statusCode).toBe(200);
    });

    it('accepts the login-issued sardeenz_sse cookie, scoped to Path=/api', async () => {
      proxyRequestFn.mockResolvedValue(makeUpstreamResponse(['event: end\ndata: {}\n\n']));
      const config = makeConfig({ authMode: 'simple' });
      const app = await buildAppWithAuth(config);

      const loginRes = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'admin', password: 'secret123' },
      });
      const setCookieHeader = loginRes.headers['set-cookie'];
      const cookieStr = Array.isArray(setCookieHeader)
        ? setCookieHeader.join('; ')
        : (setCookieHeader ?? '');
      expect(cookieStr).toContain('Path=/api');
      expect(cookieStr).not.toContain('Path=/api/events');

      const cookieMatch = /sardeenz_sse=([^;]+)/.exec(cookieStr);
      const token = cookieMatch?.[1] ?? '';

      const res = await app.inject({
        method: 'GET',
        url: '/api/models/llama-3/logs',
        cookies: { sardeenz_sse: token },
      });
      await app.close();

      expect(res.statusCode).toBe(200);
    });

    it('returns 403 for a role without admin-readonly', async () => {
      const config = makeConfig({ authMode: 'simple' });
      const app = await buildApp(config);

      const token = app.jwt.sign({ username: 'viewer', roles: [], authMode: 'simple' }, {
        expiresIn: 3600,
      });

      const res = await app.inject({
        method: 'GET',
        url: '/api/models/llama-3/logs',
        headers: { authorization: `Bearer ${token}` },
      });
      await app.close();

      expect(res.statusCode).toBe(403);
      expect(proxyRequestFn).not.toHaveBeenCalled();
    });
  });
});
