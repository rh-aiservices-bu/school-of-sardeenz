// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildServer } from '../server.js';
import type { Config } from '../config.js';
import type { RouteDeps } from '../routes/deps.js';

function makeConfig(apiToken: string): Config {
  return {
    listenAddr: '0.0.0.0',
    listenPort: 3000,
    logLevel: 'silent',
    redisUrl: 'redis://localhost:6379',
    databaseUrl: 'postgresql://sardeenz:sardeenz@localhost:5432/sardeenz',
    redisKeyPrefix: 'sardeenz',
    leaseName: 'sardeenz-control-plane',
    leaseNamespace: 'default',
    workerHeartbeatTimeoutSecs: 30,
    parkingTimeoutSecs: 120,
    evictionMaxPerCycle: 3,
    sleepTimeoutSecs: 300,
    wakeTimeoutSecs: 300,
    healthCheckIntervalSecs: 10,
    deployTimeoutSecs: 900,
    reconciliationIntervalSecs: 30,
    runnerCatalogUrl: 'http://catalog.test/runners.yaml',
    modulesDir: '/modules',
    weightsDir: '/weights',
    sifImporter: 'stub',
    apptainerBin: 'apptainer',
    verifySif: false,
    apiToken,
  };
}

function makeRouteDeps(config: Config): RouteDeps {
  return {
    config,
    modelRepository: { findAll: vi.fn(() => Promise.resolve([])) },
    lifecycle: {
      getAllStates: vi.fn(() => Promise.resolve([])),
      getLastInferenceTimestamps: vi.fn(() => Promise.resolve(new Map())),
    },
    memoryBudget: {
      getAllBudgets: vi.fn(() => []),
      getWorkerBudget: vi.fn(() => undefined),
    },
    workerPool: { getAllWorkers: vi.fn(() => []) },
    routingMap: {},
    placement: {},
    eviction: {},
    sleepWake: {},
    deployOrchestration: {},
    leaderElection: { isLeader: true, consecutiveLeaseFailures: 0 },
    notifications: {},
    catalogService: {},
    moduleStore: {},
    weightsBrowser: {},
    createRunnerClient: vi.fn(() => ({})),
    createWorkerClient: vi.fn(() => ({})),
  } as unknown as RouteDeps;
}

async function buildTestApp(apiToken: string): Promise<FastifyInstance> {
  const config = makeConfig(apiToken);
  const redis = { ping: vi.fn(() => Promise.resolve('PONG')) };
  const db = { query: vi.fn(() => Promise.resolve({ rowCount: 1 })) };
  const app = await buildServer({
    config,
    redis: redis as unknown as Parameters<typeof buildServer>[0]['redis'],
    db: db as unknown as Parameters<typeof buildServer>[0]['db'],
    routes: makeRouteDeps(config),
  });
  await app.ready();
  return app;
}

describe('control plane API auth hook', () => {
  it('rejects a request to a protected route with no Authorization header', async () => {
    const app = await buildTestApp('secret-token');
    const res = await app.inject({ method: 'GET', url: '/api/v1/models' });
    expect(res.statusCode).toBe(401);
    expect(res.json<{ code: string }>().code).toBe('UNAUTHORIZED');
    await app.close();
  });

  it('rejects a request with the wrong token', async () => {
    const app = await buildTestApp('secret-token');
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/models',
      headers: { authorization: 'Bearer wrong-token' },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('allows a request with the correct Bearer token through to the route', async () => {
    const app = await buildTestApp('secret-token');
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/workers',
      headers: { authorization: 'Bearer secret-token' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ workers: unknown[] }>().workers).toEqual([]);
    await app.close();
  });

  it('exempts /healthz even when a token is configured', async () => {
    const app = await buildTestApp('secret-token');
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('exempts /readyz even when a token is configured', async () => {
    const app = await buildTestApp('secret-token');
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('allows requests without a header when no token is configured (auth disabled)', async () => {
    const app = await buildTestApp('');
    const res = await app.inject({ method: 'GET', url: '/api/v1/workers' });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('rejects a token of a different length without crashing (timingSafeEqual guard)', async () => {
    const app = await buildTestApp('a-much-longer-secret-token-value');
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/models',
      headers: { authorization: 'Bearer short' },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
