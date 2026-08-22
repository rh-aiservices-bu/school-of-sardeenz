// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { registerProbes } from '../../health/probes.js';
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
  corsOrigin: 'http://localhost:5173',
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
};

const cpIsHealthyFn = vi.fn<() => Promise<boolean>>();
const redisIsHealthyFn = vi.fn<() => Promise<boolean>>();
const promIsHealthyFn = vi.fn<() => Promise<boolean>>();

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
      getClusterStatus: vi.fn(),
      getClusterMemory: vi.fn(),
      isHealthy: cpIsHealthyFn,
    } as unknown as RouteDeps['controlPlane'],
    redis: {
      listModels: vi.fn(),
      getModel: vi.fn(),
      getModelNames: vi.fn(),
      listWorkers: vi.fn(),
      getClusterStatus: vi.fn(),
      getClusterMemory: vi.fn(),
      getWorkerDetail: vi.fn(),
      createSubscriber: vi.fn(),
      isHealthy: redisIsHealthyFn,
      keyPrefix: 'sardeenz',
      close: vi.fn(),
    } as unknown as RouteDeps['redis'],
    prometheus: {
      queryRange: vi.fn(),
      queryInstant: vi.fn(),
      isHealthy: promIsHealthyFn,
    } as unknown as RouteDeps['prometheus'],
  };
}

interface ReadyzBody {
  status: string;
  checks: Record<string, string>;
}

async function buildApp(deps: RouteDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  registerProbes(app, deps);
  await app.ready();
  return app;
}

// ---------------------------------------------------------------------------
// GET /healthz
// ---------------------------------------------------------------------------

describe('GET /healthz', () => {
  it('always returns 200 ok', async () => {
    const app = await buildApp(buildDeps());
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });
});

// ---------------------------------------------------------------------------
// GET /readyz
// ---------------------------------------------------------------------------

describe('GET /readyz', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 200 ready when both control plane and Redis are healthy', async () => {
    cpIsHealthyFn.mockResolvedValue(true);
    redisIsHealthyFn.mockResolvedValue(true);
    promIsHealthyFn.mockResolvedValue(true);

    const app = await buildApp(buildDeps());
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    await app.close();

    expect(res.statusCode).toBe(200);
    const body = res.json<ReadyzBody>();
    expect(body.status).toBe('ready');
    expect(body.checks.controlPlane).toBe('ok');
    expect(body.checks.redis).toBe('ok');
  });

  it('returns 200 degraded when control plane is down but Redis is up', async () => {
    cpIsHealthyFn.mockResolvedValue(false);
    redisIsHealthyFn.mockResolvedValue(true);
    promIsHealthyFn.mockResolvedValue(true);

    const app = await buildApp(buildDeps());
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    await app.close();

    expect(res.statusCode).toBe(200);
    const body = res.json<ReadyzBody>();
    expect(body.status).toBe('degraded');
    expect(body.checks.controlPlane).toBe('error');
    expect(body.checks.redis).toBe('ok');
  });

  it('returns 200 degraded when Redis is down but control plane is up', async () => {
    cpIsHealthyFn.mockResolvedValue(true);
    redisIsHealthyFn.mockResolvedValue(false);
    promIsHealthyFn.mockResolvedValue(true);

    const app = await buildApp(buildDeps());
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    await app.close();

    expect(res.statusCode).toBe(200);
    const body = res.json<ReadyzBody>();
    expect(body.status).toBe('degraded');
    expect(body.checks.controlPlane).toBe('ok');
    expect(body.checks.redis).toBe('error');
  });

  it('returns 503 not_ready when both control plane and Redis are down', async () => {
    cpIsHealthyFn.mockResolvedValue(false);
    redisIsHealthyFn.mockResolvedValue(false);
    promIsHealthyFn.mockResolvedValue(true);

    const app = await buildApp(buildDeps());
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    await app.close();

    expect(res.statusCode).toBe(503);
    const body = res.json<ReadyzBody>();
    expect(body.status).toBe('not_ready');
    expect(body.checks.controlPlane).toBe('error');
    expect(body.checks.redis).toBe('error');
  });

  it('reports Prometheus as warning when it is down, but does not affect readiness', async () => {
    cpIsHealthyFn.mockResolvedValue(true);
    redisIsHealthyFn.mockResolvedValue(true);
    promIsHealthyFn.mockResolvedValue(false);

    const app = await buildApp(buildDeps());
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    await app.close();

    expect(res.statusCode).toBe(200);
    const body = res.json<ReadyzBody>();
    expect(body.status).toBe('ready');
    expect(body.checks.prometheus).toBe('warning');
  });

  it('returns 503 when all backends are down', async () => {
    cpIsHealthyFn.mockResolvedValue(false);
    redisIsHealthyFn.mockResolvedValue(false);
    promIsHealthyFn.mockResolvedValue(false);

    const app = await buildApp(buildDeps());
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    await app.close();

    expect(res.statusCode).toBe(503);
    const body = res.json<ReadyzBody>();
    expect(body.status).toBe('not_ready');
    expect(body.checks.controlPlane).toBe('error');
    expect(body.checks.redis).toBe('error');
    expect(body.checks.prometheus).toBe('warning');
  });
});
