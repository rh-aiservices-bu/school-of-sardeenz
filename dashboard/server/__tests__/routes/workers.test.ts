// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { registerWorkerRoutes } from '../../routes/workers.js';
import { authPlugin } from '../../plugins/auth.js';
import { BffError } from '../../errors.js';
import type { RouteDeps } from '../../routes/deps.js';
import type { Config } from '../../config.js';
import { WorkerStatus, ModelLifecycleState } from '@sardeenz/types';
import type { ControlPlaneComponents } from '@sardeenz/types';

type WorkerInfo = ControlPlaneComponents['schemas']['WorkerInfo'];
type WorkerDetail = ControlPlaneComponents['schemas']['WorkerDetail'];

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

const sampleWorkerInfo: WorkerInfo = {
  workerId: 'worker-1',
  status: WorkerStatus.ONLINE,
  devices: [
    {
      deviceIndex: 0,
      deviceType: 'GPU',
      memoryTotalBytes: 8_000_000_000,
      memoryUsedBytes: 2_000_000_000,
      memoryAvailableBytes: 6_000_000_000,
    },
  ],
  modelCount: 1,
};

const sampleWorkerDetail: WorkerDetail = {
  workerId: 'worker-1',
  status: WorkerStatus.ONLINE,
  devices: [
    {
      deviceIndex: 0,
      deviceType: 'GPU',
      memoryTotalBytes: 8_000_000_000,
      memoryUsedBytes: 2_000_000_000,
      memoryAvailableBytes: 6_000_000_000,
    },
  ],
  models: [{ modelName: 'llama-3', state: ModelLifecycleState.ACTIVE }],
  runnerCapabilities: [],
  joinedAt: '2026-01-01T00:00:00.000Z',
};

const listWorkersFn = vi.fn();
const getWorkerFn = vi.fn();
const listRedisWorkersFn = vi.fn();
const getRedisWorkerDetailFn = vi.fn();

function buildDeps(): RouteDeps {
  return {
    config: mockConfig,
    controlPlane: {
      proxyRequest: vi.fn(),
      listModels: vi.fn(),
      getModel: vi.fn(),
      deployModel: vi.fn(),
      deleteModel: vi.fn(),
      sleepModel: vi.fn(),
      wakeModel: vi.fn(),
      listWorkers: listWorkersFn,
      getWorker: getWorkerFn,
      getClusterStatus: vi.fn(),
      getClusterMemory: vi.fn(),
      isHealthy: vi.fn(),
    } as unknown as RouteDeps['controlPlane'],
    redis: {
      listModels: vi.fn(),
      getModel: vi.fn(),
      getModelNames: vi.fn(),
      listWorkers: listRedisWorkersFn,
      getClusterStatus: vi.fn(),
      getClusterMemory: vi.fn(),
      getWorkerDetail: getRedisWorkerDetailFn,
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
  registerWorkerRoutes(app, deps);
  await app.ready();
  return app;
}

// ---------------------------------------------------------------------------
// GET /api/workers
// ---------------------------------------------------------------------------

describe('GET /api/workers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('proxies to control plane and returns the response on success', async () => {
    listWorkersFn.mockResolvedValue({ status: 200, data: { workers: [sampleWorkerInfo] } });

    const app = await buildApp(buildDeps());
    const res = await app.inject({ method: 'GET', url: '/api/workers' });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ workers: [{ workerId: 'worker-1' }] });
    expect(listRedisWorkersFn).not.toHaveBeenCalled();
  });

  it('falls back to Redis when control plane throws', async () => {
    listWorkersFn.mockRejectedValue(BffError.upstreamError('Control plane down'));
    listRedisWorkersFn.mockResolvedValue([sampleWorkerInfo]);

    const app = await buildApp(buildDeps());
    const res = await app.inject({ method: 'GET', url: '/api/workers' });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      source: 'redis-fallback',
      workers: [{ workerId: 'worker-1' }],
    });
  });
});

// ---------------------------------------------------------------------------
// GET /api/workers/:id
// ---------------------------------------------------------------------------

describe('GET /api/workers/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('proxies to control plane and returns the worker detail on success', async () => {
    getWorkerFn.mockResolvedValue({ status: 200, data: sampleWorkerDetail });

    const app = await buildApp(buildDeps());
    const res = await app.inject({ method: 'GET', url: '/api/workers/worker-1' });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ workerId: 'worker-1' });
    expect(getRedisWorkerDetailFn).not.toHaveBeenCalled();
  });

  it('falls back to Redis when control plane throws', async () => {
    getWorkerFn.mockRejectedValue(BffError.upstreamError('Control plane down'));
    getRedisWorkerDetailFn.mockResolvedValue(sampleWorkerDetail);

    const app = await buildApp(buildDeps());
    const res = await app.inject({ method: 'GET', url: '/api/workers/worker-1' });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ source: 'redis-fallback', workerId: 'worker-1' });
    expect(getRedisWorkerDetailFn).toHaveBeenCalledWith('worker-1');
  });

  it('returns 404 when control plane is down and Redis has no cached data', async () => {
    getWorkerFn.mockRejectedValue(BffError.upstreamError('Control plane down'));
    getRedisWorkerDetailFn.mockResolvedValue(null);

    const app = await buildApp(buildDeps());
    const res = await app.inject({ method: 'GET', url: '/api/workers/unknown-worker' });
    await app.close();

    expect(res.statusCode).toBe(404);
    expect(getRedisWorkerDetailFn).toHaveBeenCalledWith('unknown-worker');
  });
});
