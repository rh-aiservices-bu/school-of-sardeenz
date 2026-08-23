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
}): { app: FastifyInstance } {
  const deps = {
    workerPool: { getAllWorkers: vi.fn(() => [worker]) },
    lifecycle: { getAllInstances: vi.fn(() => Promise.resolve(opts.instances ?? [])) },
    memoryBudget: {
      getWorkerBudget: vi.fn(() => undefined),
      getClusterSummary: vi.fn(() => ({
        totalBytes: 0,
        usedBytes: 0,
        availableBytes: 0,
        reservedBytes: 0,
      })),
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
