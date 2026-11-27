// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { registerModelRoutes } from '../../routes/models.js';
import { authPlugin } from '../../plugins/auth.js';
import { ControlPlaneClient } from '../../clients/control-plane.js';
import { BffError } from '../../errors.js';
import type { RouteDeps } from '../../routes/deps.js';
import type { Config } from '../../config.js';

const mockConfig: Config = {
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
  authMode: 'simple',
  adminUsername: 'admin',
  adminPassword: '',
  jwtSecret: 'test-jwt-secret-that-is-long-enough',
  jwtExpirationHours: 8,
  oauthClientId: 'sardeenz',
  oauthClientSecret: '',
  oauthIssuerUrl: '',
  k8sApiUrl: '',
  namespace: 'sardeenz',
  controlPlaneApiToken: 'bff-service-token',
  publicUrl: '',
  repoStatsUrl: '',
};

const fetchSpy = vi.fn();

function buildDeps(config: Config): RouteDeps {
  return {
    config,
    // The real client: the point of this suite is JWT → authPlugin → request context →
    // ControlPlaneClient → (stubbed) fetch, with nothing mocked in between.
    controlPlane: new ControlPlaneClient(config),
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

async function buildApp(config: Config): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof BffError) {
      return reply.code(error.statusCode).send(error.toResponse());
    }
    return reply.code(500).send({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });
  await app.register(authPlugin, { config });
  registerModelRoutes(app, buildDeps(config));
  await app.ready();
  return app;
}

function firstCallHeaders(): Record<string, string> {
  const init = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
  return (init?.headers ?? {}) as Record<string, string>;
}

describe('BFF actor forwarding to the control plane', () => {
  beforeEach(() => {
    fetchSpy.mockReset();
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 202,
      json: () => Promise.resolve({ modelName: 'llama-3', state: 'PENDING' }),
    });
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('a dashboard-initiated POST carries the logged-in user', async () => {
    const app = await buildApp(mockConfig);
    const token = app.jwt.sign(
      { username: 'alice', roles: ['admin'], authMode: 'simple' },
      { expiresIn: 3600 },
    );

    const res = await app.inject({
      method: 'POST',
      url: '/api/models',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        modelName: 'llama-3',
        runnerType: 'vllm',
        modelPath: '/weights/llama-3',
        requiredMemory: 4096,
      },
    });
    await app.close();

    expect(res.statusCode).toBe(202);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const headers = firstCallHeaders();
    expect(headers['X-Sardeenz-Actor']).toBe('alice');
    expect(headers['X-Sardeenz-Actor-Roles']).toBe('admin');
    // the BFF request id rides along for log correlation
    expect(headers['x-request-id']).toEqual(expect.any(String));
    expect(headers['Authorization']).toBe('Bearer bff-service-token');
  });

  it('AUTH_MODE=none sends no actor', async () => {
    const app = await buildApp({
      ...mockConfig,
      authMode: 'none',
      jwtSecret: '',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/models',
      payload: {
        modelName: 'llama-3',
        runnerType: 'vllm',
        modelPath: '/weights/llama-3',
        requiredMemory: 4096,
      },
    });
    await app.close();

    expect(res.statusCode).toBe(202);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const headers = firstCallHeaders();
    expect(headers['X-Sardeenz-Actor']).toBeUndefined();
    expect(headers['X-Sardeenz-Actor-Roles']).toBeUndefined();
  });
});
