// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { registerModelRoutes } from '../../routes/models.js';
import { authPlugin } from '../../plugins/auth.js';
import { BffError } from '../../errors.js';
import type { RouteDeps } from '../../routes/deps.js';
import type { Config } from '../../config.js';
import { ModelLifecycleState } from '@sardeenz/types';
import type { ControlPlaneComponents } from '@sardeenz/types';

type ModelInfo = ControlPlaneComponents['schemas']['ModelInfo'];

const mockConfig: Config = {
  listenAddr: '0.0.0.0',
  listenPort: 4000,
  logLevel: 'silent',
  controlPlaneUrl: 'http://cp.test',
  redisUrl: 'redis://localhost:6379',
  redisKeyPrefix: 'sardeenz',
  prometheusUrl: 'http://prom.test',
  authMode: 'none',
  adminUsername: 'admin',
  adminPassword: '',
  jwtSecret: '',
  jwtExpirationHours: 8,
  oauthClientId: 'sardeenz',
  oauthClientSecret: '',
  oauthIssuerUrl: '',
  k8sApiUrl: '',
  namespace: 'sardeenz',
  controlPlaneApiToken: '',
  publicUrl: '',
};

const sampleModel: ModelInfo = {
  modelName: 'llama-3',
  state: ModelLifecycleState.ACTIVE,
  runnerType: 'vllm',
  createdAt: '2026-01-01T00:00:00.000Z',
};

// Named mock functions kept at module scope to avoid unbound-method issues.
const listModelsFn = vi.fn();
const getModelFn = vi.fn();
const deployModelFn = vi.fn();
const listRedisModelsFn = vi.fn();
const getRedisModelFn = vi.fn();

function buildDeps(): RouteDeps {
  return {
    config: mockConfig,
    controlPlane: {
      proxyRequest: vi.fn(),
      listModels: listModelsFn,
      getModel: getModelFn,
      deployModel: deployModelFn,
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
      listModels: listRedisModelsFn,
      getModel: getRedisModelFn,
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

async function buildApp(deps: RouteDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof BffError) {
      return reply.code(error.statusCode).send(error.toResponse());
    }
    return reply.code(500).send({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });
  await app.register(authPlugin, { config: mockConfig });
  registerModelRoutes(app, deps);
  await app.ready();
  return app;
}

describe('GET /api/models', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('proxies to control plane and returns the response on success', async () => {
    listModelsFn.mockResolvedValue({ status: 200, data: { models: [sampleModel] } });

    const app = await buildApp(buildDeps());
    const res = await app.inject({ method: 'GET', url: '/api/models' });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ models: [{ modelName: 'llama-3' }] });
    expect(listRedisModelsFn).not.toHaveBeenCalled();
  });

  it('passes state query parameter to control plane', async () => {
    listModelsFn.mockResolvedValue({ status: 200, data: { models: [] } });

    const app = await buildApp(buildDeps());
    await app.inject({ method: 'GET', url: '/api/models?state=ACTIVE' });
    await app.close();

    expect(listModelsFn).toHaveBeenCalledWith('ACTIVE');
  });

  it('falls back to Redis when control plane throws', async () => {
    listModelsFn.mockRejectedValue(BffError.upstreamError('Control plane down'));
    listRedisModelsFn.mockResolvedValue([sampleModel]);

    const app = await buildApp(buildDeps());
    const res = await app.inject({ method: 'GET', url: '/api/models' });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      source: 'redis-fallback',
      models: [{ modelName: 'llama-3' }],
    });
  });
});

describe('GET /api/models/:name', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('proxies to control plane and returns the model on success', async () => {
    getModelFn.mockResolvedValue({ status: 200, data: sampleModel });

    const app = await buildApp(buildDeps());
    const res = await app.inject({ method: 'GET', url: '/api/models/llama-3' });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ modelName: 'llama-3' });
  });

  it('falls back to Redis when control plane throws', async () => {
    getModelFn.mockRejectedValue(BffError.upstreamError('Control plane down'));
    getRedisModelFn.mockResolvedValue(sampleModel);

    const app = await buildApp(buildDeps());
    const res = await app.inject({ method: 'GET', url: '/api/models/llama-3' });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ source: 'redis-fallback', modelName: 'llama-3' });
  });

  it('returns 404 when Redis also has no model', async () => {
    getModelFn.mockRejectedValue(BffError.upstreamError('Control plane down'));
    getRedisModelFn.mockResolvedValue(null);

    const app = await buildApp(buildDeps());
    const res = await app.inject({ method: 'GET', url: '/api/models/unknown-model' });
    await app.close();

    expect(res.statusCode).toBe(404);
  });
});

describe('POST /api/models', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('proxies deploy request to control plane without Redis fallback', async () => {
    deployModelFn.mockResolvedValue({
      status: 202,
      data: { modelName: 'llama-3', state: ModelLifecycleState.PENDING },
    });

    const app = await buildApp(buildDeps());
    const payload = {
      modelName: 'llama-3',
      runnerType: 'vllm',
      modelPath: '/models/llama',
      requiredMemory: 8589934592,
      tensorParallel: 1,
      pinned: false,
    };
    const res = await app.inject({ method: 'POST', url: '/api/models', payload });
    await app.close();

    expect(res.statusCode).toBe(202);
    expect(listRedisModelsFn).not.toHaveBeenCalled();
  });
});
