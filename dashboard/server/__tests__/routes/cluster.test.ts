// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { registerClusterRoutes } from '../../routes/cluster.js';
import { authPlugin } from '../../plugins/auth.js';
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
  inferenceUrl: 'http://inference.test',
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

const getClusterStatusFn = vi.fn();
const getClusterMemoryFn = vi.fn();
const getRedisClusterStatusFn = vi.fn();
const getRedisClusterMemoryFn = vi.fn();

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
      listWorkers: vi.fn(),
      getWorker: vi.fn(),
      getClusterStatus: getClusterStatusFn,
      getClusterMemory: getClusterMemoryFn,
      isHealthy: vi.fn(),
    } as unknown as RouteDeps['controlPlane'],
    redis: {
      listModels: vi.fn(),
      getModel: vi.fn(),
      getModelNames: vi.fn(),
      listWorkers: vi.fn(),
      getClusterStatus: getRedisClusterStatusFn,
      getClusterMemory: getRedisClusterMemoryFn,
      getWorkerDetail: vi.fn(),
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
  registerClusterRoutes(app, deps);
  await app.ready();
  return app;
}

// ---------------------------------------------------------------------------
// GET /api/cluster/status
// ---------------------------------------------------------------------------

describe('GET /api/cluster/status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('proxies to control plane and returns the response on success', async () => {
    const statusData = {
      workerCount: 2,
      workersOnline: 2,
      modelCounts: { total: 1, active: 1, sleeping: 0, starting: 0, error: 0, other: 0 },
      memory: { totalBytes: 1000, usedBytes: 500, availableBytes: 500 },
    };
    getClusterStatusFn.mockResolvedValue({ status: 200, data: statusData });

    const app = await buildApp(buildDeps());
    const res = await app.inject({ method: 'GET', url: '/api/cluster/status' });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ workerCount: 2 });
    expect(getRedisClusterStatusFn).not.toHaveBeenCalled();
  });

  it('falls back to Redis when control plane throws', async () => {
    getClusterStatusFn.mockRejectedValue(BffError.upstreamError('Control plane down'));
    getRedisClusterStatusFn.mockResolvedValue({
      workerCount: 1,
      workersOnline: 1,
      modelCounts: { total: 0, active: 0, sleeping: 0, starting: 0, error: 0, other: 0 },
      memory: { totalBytes: 500, usedBytes: 0, availableBytes: 500 },
    });

    const app = await buildApp(buildDeps());
    const res = await app.inject({ method: 'GET', url: '/api/cluster/status' });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ source: 'redis-fallback', workerCount: 1 });
  });
});

// ---------------------------------------------------------------------------
// GET /api/cluster/memory
// ---------------------------------------------------------------------------

describe('GET /api/cluster/memory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('proxies to control plane and returns the response on success', async () => {
    const memoryData = {
      workers: [{ workerId: 'w1', devices: [] }],
      summary: { totalBytes: 1000, usedBytes: 500, availableBytes: 500, reservedBytes: 0 },
    };
    getClusterMemoryFn.mockResolvedValue({ status: 200, data: memoryData });

    const app = await buildApp(buildDeps());
    const res = await app.inject({ method: 'GET', url: '/api/cluster/memory' });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ workers: [{ workerId: 'w1' }] });
    expect(getRedisClusterMemoryFn).not.toHaveBeenCalled();
  });

  it('falls back to Redis when control plane throws', async () => {
    getClusterMemoryFn.mockRejectedValue(BffError.upstreamError('Control plane down'));
    const redisMemory = {
      workers: [{ workerId: 'w1', devices: [] }],
      summary: { totalBytes: 1000, usedBytes: 400, availableBytes: 600, reservedBytes: 0 },
    };
    getRedisClusterMemoryFn.mockResolvedValue(redisMemory);

    const app = await buildApp(buildDeps());
    const res = await app.inject({ method: 'GET', url: '/api/cluster/memory' });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ source: 'redis-fallback', workers: [{ workerId: 'w1' }] });
    expect(getRedisClusterMemoryFn).toHaveBeenCalledOnce();
  });

  it('returns 502 when control plane is down and Redis has no cached data', async () => {
    getClusterMemoryFn.mockRejectedValue(BffError.upstreamError('Control plane down'));
    getRedisClusterMemoryFn.mockResolvedValue(null);

    const app = await buildApp(buildDeps());
    const res = await app.inject({ method: 'GET', url: '/api/cluster/memory' });
    await app.close();

    expect(res.statusCode).toBe(502);
    expect(getRedisClusterMemoryFn).toHaveBeenCalledOnce();
  });
});
