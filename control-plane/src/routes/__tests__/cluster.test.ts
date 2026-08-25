// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { ModelLifecycleState, WorkerStatus } from '@sardeenz/types';
import { registerClusterRoutes } from '../cluster.js';
import type { RouteDeps } from '../deps.js';

const worker = {
  workerId: 'w1',
  status: WorkerStatus.ONLINE,
  devices: [{ deviceIndex: 0, deviceType: 'CUDA', memoryTotalBytes: 16 * 1024 ** 3 }],
};

const instanceActive = {
  workerId: 'w1',
  modelName: 'llama-3-8b',
  state: ModelLifecycleState.ACTIVE,
  deviceIndices: [0],
};

const instanceSleeping = {
  workerId: 'w1',
  modelName: 'mistral-7b',
  state: ModelLifecycleState.SLEEPING,
  deviceIndices: [0],
};

function buildApp(opts: {
  instances?: unknown[];
  records?: Array<{ name: string; requiredMemory: number | null }>;
  getWorkerBudget?: ReturnType<typeof vi.fn>;
  clusterSummary?: {
    totalBytes: number;
    usedBytes: number;
    availableBytes: number;
    reservedBytes: number;
    measuredUsedBytes?: number;
  };
}): { app: FastifyInstance } {
  const deps = {
    leaderElection: { isLeader: true },
    workerPool: { getAllWorkers: vi.fn(() => [worker]) },
    lifecycle: { getAllInstances: vi.fn(() => Promise.resolve(opts.instances ?? [])) },
    memoryBudget: {
      getWorkerBudget: opts.getWorkerBudget ?? vi.fn(() => undefined),
      getClusterSummary: vi.fn(
        () =>
          opts.clusterSummary ?? {
            totalBytes: 0,
            usedBytes: 0,
            availableBytes: 0,
            reservedBytes: 0,
          },
      ),
    },
    modelRepository: { findAll: vi.fn(() => Promise.resolve(opts.records ?? [])) },
  } as unknown as RouteDeps;

  const app = Fastify({ logger: false });
  app.setErrorHandler((error: Error & { statusCode?: number; code?: string }, _req, reply) => {
    return reply.code(error.statusCode ?? 500).send({ error: error.message, code: error.code });
  });
  registerClusterRoutes(app, deps);
  return { app };
}

describe('GET /api/v1/cluster/memory — memoryUsedBytes population', () => {
  it('populates memoryUsedBytes per model from requiredMemory', async () => {
    const { app } = buildApp({
      instances: [instanceActive],
      records: [{ name: 'llama-3-8b', requiredMemory: 8 * 1024 ** 3 }],
    });

    const res = await app.inject({ method: 'GET', url: '/api/v1/cluster/memory' });
    expect(res.statusCode).toBe(200);

    const body = res.json<{
      workers: Array<{ models: Array<{ modelName: string; memoryUsedBytes?: number }> }>;
    }>();
    const model = body.workers[0]?.models.find((m) => m.modelName === 'llama-3-8b');
    expect(model?.memoryUsedBytes).toBe(8 * 1024 ** 3);
  });

  it('omits memoryUsedBytes when the model has no requiredMemory record', async () => {
    const { app } = buildApp({
      instances: [instanceActive],
      records: [{ name: 'llama-3-8b', requiredMemory: null }],
    });

    const res = await app.inject({ method: 'GET', url: '/api/v1/cluster/memory' });
    const body = res.json<{ workers: Array<{ models: Array<Record<string, unknown>> }> }>();
    const model = body.workers[0]?.models.find((m) => m['modelName'] === 'llama-3-8b');

    expect(model).toBeDefined();
    expect('memoryUsedBytes' in (model as Record<string, unknown>)).toBe(false);
  });

  it('emits memoryUsedBytes for both replicas of a model', async () => {
    const replica2 = { ...instanceActive };
    const { app } = buildApp({
      instances: [instanceActive, replica2],
      records: [{ name: 'llama-3-8b', requiredMemory: 8 * 1024 ** 3 }],
    });

    const res = await app.inject({ method: 'GET', url: '/api/v1/cluster/memory' });
    const body = res.json<{
      workers: Array<{ models: Array<{ modelName: string; memoryUsedBytes?: number }> }>;
    }>();
    const models = body.workers[0]?.models.filter((m) => m.modelName === 'llama-3-8b') ?? [];

    expect(models).toHaveLength(2);
    for (const m of models) {
      expect(m.memoryUsedBytes).toBe(8 * 1024 ** 3);
    }
  });

  it('populates memoryUsedBytes for a SLEEPING model (stable across ACTIVE/SLEEPING)', async () => {
    const { app } = buildApp({
      instances: [instanceSleeping],
      records: [{ name: 'mistral-7b', requiredMemory: 14 * 1024 ** 3 }],
    });

    const res = await app.inject({ method: 'GET', url: '/api/v1/cluster/memory' });
    const body = res.json<{
      workers: Array<{ models: Array<{ modelName: string; memoryUsedBytes?: number }> }>;
    }>();
    const model = body.workers[0]?.models.find((m) => m.modelName === 'mistral-7b');
    expect(model?.memoryUsedBytes).toBe(14 * 1024 ** 3);
  });
});

describe('measured memory (#163)', () => {
  it('GET /api/v1/cluster/status includes memory.measuredUsedBytes when defined on the summary', async () => {
    const { app } = buildApp({
      clusterSummary: {
        totalBytes: 16 * 1024 ** 3,
        usedBytes: 0,
        availableBytes: 16 * 1024 ** 3,
        reservedBytes: 0,
        measuredUsedBytes: 4 * 1024 ** 3,
      },
    });

    const res = await app.inject({ method: 'GET', url: '/api/v1/cluster/status' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ memory: { measuredUsedBytes?: number } }>();
    expect(body.memory.measuredUsedBytes).toBe(4 * 1024 ** 3);
  });

  it('GET /api/v1/cluster/status omits memory.measuredUsedBytes when the summary has none', async () => {
    const { app } = buildApp({});

    const res = await app.inject({ method: 'GET', url: '/api/v1/cluster/status' });
    const body = res.json<{ memory: Record<string, unknown> }>();
    expect('measuredUsedBytes' in body.memory).toBe(false);
  });

  it('GET /api/v1/cluster/memory includes per-device memoryMeasuredUsedBytes and summary.measuredUsedBytes', async () => {
    const getWorkerBudget = vi.fn(() => ({
      workerId: 'w1',
      devices: [
        {
          deviceIndex: 0,
          deviceType: 'CUDA',
          totalBytes: 16 * 1024 ** 3,
          usedBytes: 0,
          reservedBytes: 0,
          availableBytes: 16 * 1024 ** 3,
          measuredUsedBytes: 5 * 1024 ** 3,
        },
      ],
      lastReportAt: new Date().toISOString(),
      stale: false,
    }));
    const { app } = buildApp({
      getWorkerBudget,
      clusterSummary: {
        totalBytes: 16 * 1024 ** 3,
        usedBytes: 0,
        availableBytes: 16 * 1024 ** 3,
        reservedBytes: 0,
        measuredUsedBytes: 5 * 1024 ** 3,
      },
    });

    const res = await app.inject({ method: 'GET', url: '/api/v1/cluster/memory' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      workers: Array<{ devices: Array<{ memoryMeasuredUsedBytes?: number }> }>;
      summary: { measuredUsedBytes?: number };
    }>();
    expect(body.workers[0]?.devices[0]?.memoryMeasuredUsedBytes).toBe(5 * 1024 ** 3);
    expect(body.summary.measuredUsedBytes).toBe(5 * 1024 ** 3);
  });

  it('GET /api/v1/cluster/memory omits memoryMeasuredUsedBytes per-device when the budget device has none', async () => {
    const { app } = buildApp({});

    const res = await app.inject({ method: 'GET', url: '/api/v1/cluster/memory' });
    const body = res.json<{ workers: Array<{ devices: Array<Record<string, unknown>> }> }>();
    const device = body.workers[0]?.devices[0];
    expect(device).toBeDefined();
    expect('memoryMeasuredUsedBytes' in (device ?? {})).toBe(false);
  });
});
