// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { ModelLifecycleState, WorkerStatus } from '@sardeenz/types';
import { registerWorkerRoutes } from '../workers.js';
import type { RouteDeps } from '../deps.js';

const workerWithCaps = {
  workerId: 'w1',
  status: WorkerStatus.ONLINE,
  devices: [{ deviceIndex: 0, deviceType: 'CUDA', memoryTotalBytes: 1 }],
  capabilities: [
    {
      runnerType: 'vllm',
      engineName: 'vLLM',
      supportedModelTypes: ['TEXT'],
      supportedDeviceTypes: ['CUDA'],
      supportedSleepLevels: ['L1'],
    },
  ],
  lastHeartbeatAt: null,
};

const workerWithoutCaps = {
  workerId: 'w2',
  status: WorkerStatus.ONLINE,
  devices: [{ deviceIndex: 0, deviceType: 'CUDA', memoryTotalBytes: 1 }],
  capabilities: [],
  lastHeartbeatAt: null,
};

function buildApp(): { app: FastifyInstance } {
  const deps = {
    workerPool: { getAllWorkers: vi.fn(() => [workerWithCaps, workerWithoutCaps]) },
    lifecycle: { getAllInstances: vi.fn(() => Promise.resolve([])) },
    memoryBudget: { getWorkerBudget: vi.fn(() => undefined) },
  } as unknown as RouteDeps;

  const app = Fastify({ logger: false });
  app.setErrorHandler((error: Error & { statusCode?: number; code?: string }, _req, reply) => {
    return reply.code(error.statusCode ?? 500).send({ error: error.message, code: error.code });
  });
  registerWorkerRoutes(app, deps);
  return { app };
}

describe('GET /api/v1/workers runnerCapabilities', () => {
  it('returns runnerCapabilities matching the mapped capability shape for a worker that reported them', async () => {
    const { app } = buildApp();

    const res = await app.inject({ method: 'GET', url: '/api/v1/workers' });
    expect(res.statusCode).toBe(200);

    const body = res.json<{ workers: Array<{ workerId: string; runnerCapabilities?: unknown }> }>();
    const w1 = body.workers.find((w) => w.workerId === 'w1');
    expect(w1?.runnerCapabilities).toEqual([
      {
        runnerType: 'vllm',
        engineName: 'vLLM',
        supportedModelTypes: ['TEXT'],
        supportedDeviceTypes: ['CUDA'],
        supportedSleepLevels: ['L1'],
      },
    ]);
  });

  it('omits the runnerCapabilities key for a worker that did not report capabilities', async () => {
    const { app } = buildApp();

    const res = await app.inject({ method: 'GET', url: '/api/v1/workers' });
    const body = res.json<{ workers: Array<Record<string, unknown>> }>();
    const w2 = body.workers.find((w) => w.workerId === 'w2');

    expect(w2).toBeDefined();
    expect('runnerCapabilities' in (w2 as Record<string, unknown>)).toBe(false);
  });
});

describe('GET /api/v1/workers/:workerId — memoryUsedBytes population', () => {
  function buildDetailApp(opts: {
    instances?: unknown[];
    records?: Array<{ name: string; requiredMemory: number | null }>;
  }): { app: FastifyInstance } {
    const deps = {
      workerPool: {
        getWorker: vi.fn(() => workerWithCaps),
      },
      lifecycle: { getAllInstances: vi.fn(() => Promise.resolve(opts.instances ?? [])) },
      memoryBudget: { getWorkerBudget: vi.fn(() => undefined) },
      modelRepository: { findAll: vi.fn(() => Promise.resolve(opts.records ?? [])) },
    } as unknown as RouteDeps;

    const app = Fastify({ logger: false });
    app.setErrorHandler((error: Error & { statusCode?: number; code?: string }, _req, reply) => {
      return reply.code(error.statusCode ?? 500).send({ error: error.message, code: error.code });
    });
    registerWorkerRoutes(app, deps);
    return { app };
  }

  it('populates models[].memoryUsedBytes from requiredMemory', async () => {
    const { app } = buildDetailApp({
      instances: [
        {
          workerId: 'w1',
          modelName: 'llama-3-8b',
          state: ModelLifecycleState.ACTIVE,
          deviceIndices: [0],
        },
      ],
      records: [{ name: 'llama-3-8b', requiredMemory: 8 * 1024 ** 3 }],
    });

    const res = await app.inject({ method: 'GET', url: '/api/v1/workers/w1' });
    expect(res.statusCode).toBe(200);

    const body = res.json<{ models: Array<{ modelName: string; memoryUsedBytes?: number }> }>();
    const model = body.models.find((m) => m.modelName === 'llama-3-8b');
    expect(model?.memoryUsedBytes).toBe(8 * 1024 ** 3);
  });

  it('omits memoryUsedBytes when the model has no requiredMemory record', async () => {
    const { app } = buildDetailApp({
      instances: [
        {
          workerId: 'w1',
          modelName: 'llama-3-8b',
          state: ModelLifecycleState.ACTIVE,
          deviceIndices: [0],
        },
      ],
      records: [],
    });

    const res = await app.inject({ method: 'GET', url: '/api/v1/workers/w1' });
    const body = res.json<{ models: Array<Record<string, unknown>> }>();
    const model = body.models.find((m) => m['modelName'] === 'llama-3-8b');

    expect(model).toBeDefined();
    expect('memoryUsedBytes' in (model as Record<string, unknown>)).toBe(false);
  });
});

describe('measured memory (#163)', () => {
  const measuredBudget = {
    workerId: 'w1',
    devices: [
      {
        deviceIndex: 0,
        deviceType: 'CUDA',
        totalBytes: 16 * 1024 ** 3,
        usedBytes: 0,
        reservedBytes: 0,
        availableBytes: 16 * 1024 ** 3,
        measuredUsedBytes: 7 * 1024 ** 3,
      },
    ],
    lastReportAt: new Date().toISOString(),
    stale: false,
  };

  it('GET /api/v1/workers includes per-device memoryMeasuredUsedBytes when the budget has one', async () => {
    const deps = {
      workerPool: { getAllWorkers: vi.fn(() => [workerWithCaps, workerWithoutCaps]) },
      lifecycle: { getAllInstances: vi.fn(() => Promise.resolve([])) },
      memoryBudget: {
        getWorkerBudget: vi.fn((workerId: string) =>
          workerId === 'w1' ? measuredBudget : undefined,
        ),
      },
    } as unknown as RouteDeps;

    const app = Fastify({ logger: false });
    app.setErrorHandler((error: Error & { statusCode?: number; code?: string }, _req, reply) => {
      return reply.code(error.statusCode ?? 500).send({ error: error.message, code: error.code });
    });
    registerWorkerRoutes(app, deps);

    const res = await app.inject({ method: 'GET', url: '/api/v1/workers' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      workers: Array<{ workerId: string; devices: Array<{ memoryMeasuredUsedBytes?: number }> }>;
    }>();
    const w1 = body.workers.find((w) => w.workerId === 'w1');
    expect(w1?.devices[0]?.memoryMeasuredUsedBytes).toBe(7 * 1024 ** 3);

    const w2 = body.workers.find((w) => w.workerId === 'w2');
    expect('memoryMeasuredUsedBytes' in (w2?.devices[0] as Record<string, unknown>)).toBe(false);
  });

  it('GET /api/v1/workers/:workerId includes per-device memoryMeasuredUsedBytes when the budget has one', async () => {
    const deps = {
      workerPool: { getWorker: vi.fn(() => workerWithCaps) },
      lifecycle: { getAllInstances: vi.fn(() => Promise.resolve([])) },
      modelRepository: { findAll: vi.fn(() => Promise.resolve([])) },
      memoryBudget: { getWorkerBudget: vi.fn(() => measuredBudget) },
    } as unknown as RouteDeps;

    const app = Fastify({ logger: false });
    app.setErrorHandler((error: Error & { statusCode?: number; code?: string }, _req, reply) => {
      return reply.code(error.statusCode ?? 500).send({ error: error.message, code: error.code });
    });
    registerWorkerRoutes(app, deps);

    const res = await app.inject({ method: 'GET', url: '/api/v1/workers/w1' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ devices: Array<{ memoryMeasuredUsedBytes?: number }> }>();
    expect(body.devices[0]?.memoryMeasuredUsedBytes).toBe(7 * 1024 ** 3);
  });
});
