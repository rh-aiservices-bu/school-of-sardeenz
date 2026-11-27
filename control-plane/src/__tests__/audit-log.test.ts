// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { MockInstance } from 'vitest';

import { buildServer } from '../server.js';
import { ControlPlaneError } from '../errors.js';
import { registerAuditHooks } from '../utils/audit-log.js';
import type { Config } from '../config.js';
import type { RouteDeps } from '../routes/deps.js';

// Same server-assembly fidelity as auth-hook.test.ts: the real `buildServer` over mocked deps,
// driven with `app.inject`. That is what proves the hooks see a real routing table.
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
    evictionMaxPerCycle: 3,
    colocationMaxPoolHeadroomPercent: 50,
    poolPressureEnabled: false,
    poolPressureThresholdPercent: 90,
    poolPressureReleaseTargetPercent: 75,
    poolPressureDebounceTicks: 3,
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
    allowInsecureCatalog: false,
    apiToken,
    workerToken: '',
  };
}

function makeRouteDeps(config: Config): RouteDeps {
  const activeInstance = {
    modelName: 'llama-3',
    instanceId: 'inst-0a1b2c3d4e5f',
    state: 'ACTIVE',
    runnerHost: '10.0.0.1',
    runnerPort: 8000,
  };
  return {
    config,
    modelRepository: {
      findByName: vi.fn(() => Promise.resolve(null)),
      findAll: vi.fn(() => Promise.resolve([])),
      create: vi.fn(() => Promise.reject(new Error('database exploded'))),
      delete: vi.fn(() => Promise.resolve(true)),
    },
    lifecycle: {
      getInstancesForModel: vi.fn(() => Promise.resolve([activeInstance])),
      getMoveOperation: vi.fn(() => Promise.resolve(undefined)),
      transition: vi.fn(() => Promise.resolve()),
      getAllInstances: vi.fn(() => Promise.resolve([])),
      getLastInferenceTimestamps: vi.fn(() => Promise.resolve(new Map())),
    },
    routingMap: {
      setModelState: vi.fn(() => Promise.resolve()),
      removeModel: vi.fn(() => Promise.resolve()),
    },
    notifications: {
      createNotification: vi.fn(() => Promise.resolve()),
      listNotifications: vi.fn(() => Promise.resolve([])),
      markAsRead: vi.fn(() => Promise.resolve()),
      markAllAsRead: vi.fn(() => Promise.resolve()),
      removeNotification: vi.fn(() => Promise.resolve()),
      clearAll: vi.fn(() => Promise.resolve()),
    },
    sleepWake: {
      sleepModel: vi.fn(() => Promise.resolve()),
      wakeModel: vi.fn(() => Promise.resolve()),
    },
    eviction: { recordEviction: vi.fn() },
    weightsPolicy: { findRefusedWeightFiles: vi.fn(() => Promise.resolve([])) },
    memoryBudget: {
      getAllBudgets: vi.fn(() => []),
      getWorkerBudget: vi.fn(() => undefined),
      getMeasuredByInstance: vi.fn(() => new Map()),
    },
    workerPool: { getAllWorkers: vi.fn(() => []) },
    leaderElection: { isLeader: true, consecutiveLeaseFailures: 0 },
    placement: {},
    catalogService: {},
    moduleStore: {},
    weightsBrowser: {},
    createRunnerClient: vi.fn(() => ({})),
    createWorkerClient: vi.fn(() => ({})),
  } as unknown as RouteDeps;
}

interface BuiltApp {
  app: FastifyInstance;
  routes: RouteDeps;
}

async function buildApp(apiToken: string): Promise<BuiltApp> {
  const config = makeConfig(apiToken);
  const routes = makeRouteDeps(config);
  const redis = { ping: vi.fn(() => Promise.resolve('PONG')) };
  const db = { query: vi.fn(() => Promise.resolve({ rowCount: 1 })) };
  const app = await buildServer({
    config,
    redis: redis as unknown as Parameters<typeof buildServer>[0]['redis'],
    db: db as unknown as Parameters<typeof buildServer>[0]['db'],
    routes,
  });
  await app.ready();
  return { app, routes };
}

function spyOnAudit(app: FastifyInstance): MockInstance {
  return vi.spyOn(app.log, 'info');
}

/** The audit lines only — the same logger carries ordinary request/lifecycle output. */
function auditLines(infoSpy: MockInstance): Record<string, unknown>[] {
  return infoSpy.mock.calls
    .map((call) => call[0] as Record<string, unknown>)
    .filter((line) => line['audit'] === true);
}

describe('control plane audit log', () => {
  it('emits exactly one audit line for a successful mutating request', async () => {
    const { app } = await buildApp('');
    const infoSpy = spyOnAudit(app);

    const res = await app.inject({ method: 'POST', url: '/api/v1/models/llama-3/sleep' });
    await app.close();

    expect(res.statusCode).toBe(202);
    const lines = auditLines(infoSpy);
    expect(lines).toHaveLength(1);
    const line = lines[0];
    expect(line['action']).toBe('sleepModel');
    expect(line['actor']).toBe('service');
    expect(line['actorRoles']).toBeUndefined();
    expect(line['target']).toEqual({ modelName: 'llama-3' });
    expect(line['params']).toEqual({});
    expect(line['outcome']).toEqual({ status: 202 });
    expect(typeof line['requestId']).toBe('string');
    // the line is emitted with `audit` as its log message, on the root logger
    expect(infoSpy.mock.calls.some((call) => call[1] === 'audit')).toBe(true);
  });

  it('reports the error code as the reason when the error carries no details.reason', async () => {
    const { app, routes } = await buildApp('');
    (routes.lifecycle.getInstancesForModel as unknown as MockInstance).mockResolvedValue([]);
    const infoSpy = spyOnAudit(app);

    const res = await app.inject({ method: 'POST', url: '/api/v1/models/llama-3/sleep' });
    await app.close();

    expect(res.statusCode).toBe(404);
    const lines = auditLines(infoSpy);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.['outcome']).toEqual({ status: 404, reason: 'MODEL_NOT_FOUND' });
  });

  it('emits exactly one line with details.reason when a dep throws operationInProgress', async () => {
    const { app, routes } = await buildApp('');
    (routes.lifecycle.getInstancesForModel as unknown as MockInstance).mockRejectedValue(
      ControlPlaneError.operationInProgress(
        'llama-3',
        'delete',
        'delete-in-progress',
        'a delete is already in progress',
      ),
    );
    const infoSpy = spyOnAudit(app);

    const res = await app.inject({ method: 'POST', url: '/api/v1/models/llama-3/sleep' });
    await app.close();

    expect(res.statusCode).toBe(409);
    const lines = auditLines(infoSpy);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.['outcome']).toEqual({ status: 409, reason: 'delete-in-progress' });
  });

  it('emits exactly one line when an unexpected error becomes a 500', async () => {
    const { app, routes } = await buildApp('');
    (routes.lifecycle.getInstancesForModel as unknown as MockInstance).mockRejectedValue(
      new Error('boom'),
    );
    const infoSpy = spyOnAudit(app);

    const res = await app.inject({ method: 'POST', url: '/api/v1/models/llama-3/sleep' });
    await app.close();

    expect(res.statusCode).toBe(500);
    const lines = auditLines(infoSpy);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.['outcome']).toEqual({ status: 500, reason: 'INTERNAL_ERROR' });
  });

  it('records the asserted actor when the bearer token authenticates', async () => {
    const { app } = await buildApp('secret-token');
    const infoSpy = spyOnAudit(app);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/models/llama-3/sleep',
      headers: {
        authorization: 'Bearer secret-token',
        'x-sardeenz-actor': 'alice',
        'x-sardeenz-actor-roles': 'admin,viewer',
      },
    });
    await app.close();

    expect(res.statusCode).toBe(202);
    const lines = auditLines(infoSpy);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.['actor']).toBe('alice');
    expect(lines[0]?.['actorRoles']).toEqual(['admin', 'viewer']);
  });

  it('ignores a spoofed actor header on an unauthenticated request', async () => {
    const { app } = await buildApp('secret-token');
    const infoSpy = spyOnAudit(app);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/models/llama-3/sleep',
      headers: { 'x-sardeenz-actor': 'root' },
    });
    await app.close();

    expect(res.statusCode).toBe(401);
    const lines = auditLines(infoSpy);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.['actor']).toBe('service');
    expect(lines[0]?.['outcome']).toEqual({ status: 401, reason: 'UNAUTHORIZED' });
  });

  it('ignores the actor header when no apiToken is configured', async () => {
    const { app } = await buildApp('');
    const infoSpy = spyOnAudit(app);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/models/llama-3/sleep',
      headers: {
        authorization: 'Bearer any-token',
        'x-sardeenz-actor': 'root',
        'x-sardeenz-actor-roles': 'admin',
      },
    });
    await app.close();

    expect(res.statusCode).toBe(202);
    const lines = auditLines(infoSpy);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.['actor']).toBe('service');
    expect(lines[0]?.['actorRoles']).toBeUndefined();
  });

  it('does not emit an audit line for non-mutating requests', async () => {
    const { app } = await buildApp('secret-token');
    const infoSpy = spyOnAudit(app);

    const models = await app.inject({
      method: 'GET',
      url: '/api/v1/models',
      headers: { authorization: 'Bearer secret-token' },
    });
    const workers = await app.inject({
      method: 'GET',
      url: '/api/v1/workers',
      headers: { authorization: 'Bearer secret-token' },
    });
    await app.close();

    expect(models.statusCode).toBe(200);
    expect(workers.statusCode).toBe(200);
    expect(auditLines(infoSpy)).toHaveLength(0);
  });

  it('never logs engine args, authorization headers or the request body', async () => {
    const { app } = await buildApp('secret-token');
    const infoSpy = spyOnAudit(app);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/models',
      headers: { authorization: 'Bearer secret-token' },
      payload: {
        modelName: 'llama-3',
        runnerType: 'vllm',
        modelPath: '/weights/llama-3',
        requiredMemory: 4096,
        engineArgs: ['--api-key', 'sekret-value'],
      },
    });
    await app.close();

    // The mocked repository rejects, so this is an audited failure — one line, not two.
    expect(res.statusCode).toBe(500);
    const lines = auditLines(infoSpy);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.['action']).toBe('deployModel');
    expect(lines[0]?.['target']).toEqual({ modelName: 'llama-3' });
    expect(lines[0]?.['params']).toEqual({ runnerType: 'vllm', requiredMemory: 4096 });
    const serialized = JSON.stringify(lines);
    expect(serialized).not.toContain('sekret-value');
    expect(serialized).not.toContain('secret-token');
  });

  it('bounds body-derived strings and the request id so one request cannot flood the stream', async () => {
    const { app } = await buildApp('secret-token');
    const infoSpy = spyOnAudit(app);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/models',
      headers: { authorization: 'Bearer secret-token' },
      payload: {
        modelName: 'm'.repeat(10_000),
        runnerType: 'r'.repeat(10_000),
        modelPath: '/weights/llama-3',
        requiredMemory: 4096,
      },
    });
    await app.close();

    // The oversize modelName fails schema validation — and the failure path still emits a line.
    expect(res.statusCode).toBe(400);
    const lines = auditLines(infoSpy);
    expect(lines).toHaveLength(1);
    expect((lines[0]?.['target'] as Record<string, string>)['modelName']).toHaveLength(256);
    expect((lines[0]?.['params'] as Record<string, string>)['runnerType']).toHaveLength(256);
  });

  it('caps a long x-request-id in the emitted line', async () => {
    const { app } = await buildApp('secret-token');
    const infoSpy = spyOnAudit(app);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/models/llama-3/sleep',
      headers: {
        authorization: 'Bearer secret-token',
        'x-request-id': 'r'.repeat(500),
      },
    });
    await app.close();

    expect(res.statusCode).toBe(202);
    const lines = auditLines(infoSpy);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.['requestId']).toHaveLength(128);
  });

  it('caps targetDeviceIndices at 64 entries and targetWorkerId at 256 characters', async () => {
    const { app } = await buildApp('secret-token');
    const infoSpy = spyOnAudit(app);

    const indices = Array.from({ length: 1000 }, (_, index) => index);
    await app.inject({
      method: 'POST',
      url: '/api/v1/models/llama-3/instances/inst-1/move',
      headers: { authorization: 'Bearer secret-token' },
      payload: { targetWorkerId: 'w'.repeat(1000), targetDeviceIndices: indices },
    });
    await app.close();

    const lines = auditLines(infoSpy);
    expect(lines).toHaveLength(1);
    const params = lines[0]?.['params'] as Record<string, unknown>;
    expect(params['targetDeviceIndices']).toEqual(indices.slice(0, 64));
    expect(params['targetWorkerId']).toHaveLength(256);
  });

  it('refuses to build when a mutating /api/v1 route has no action name', async () => {
    const bare = Fastify({ logger: false });
    registerAuditHooks(bare);

    expect(() => bare.post('/api/v1/unmapped', () => ({ ok: true }))).toThrow(
      'audit: no action name for POST /api/v1/unmapped',
    );
    await bare.close();
  });

  it('builds with the real route set, including the proxy-only wake route', async () => {
    const { app } = await buildApp('secret-token');
    expect(app.hasRoute({ method: 'POST', url: '/api/v1/wake' })).toBe(true);
    await app.close();
  });
});
