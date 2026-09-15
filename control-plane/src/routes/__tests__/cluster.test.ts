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
  instanceId: 'inst-a',
  workerId: 'w1',
  modelName: 'llama-3-8b',
  state: ModelLifecycleState.ACTIVE,
  deviceIndices: [0],
};

const instanceSleeping = {
  instanceId: 'inst-b',
  workerId: 'w1',
  modelName: 'mistral-7b',
  state: ModelLifecycleState.SLEEPING,
  deviceIndices: [0],
};

function buildApp(opts: {
  instances?: unknown[];
  records?: Array<{ name: string; displayName?: string | null }>;
  getWorkerBudget?: ReturnType<typeof vi.fn>;
  clusterSummary?: {
    totalBytes: number;
    usedBytes: number;
    availableBytes: number;
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

// Doctrine (#163 round 2): the old requiredMemory-based per-model seam (#123/#151) is gone.
// GET /api/v1/cluster/memory now returns one entry per running INSTANCE, with `displayName` and
// `instanceId` for click-through, and `memoryUsedBytes` sourced from measured (NVML) attribution
// via the worker's budget.instanceMeasurements — never from the configured requiredMemory.
describe('GET /api/v1/cluster/memory — per-instance models (#163 doctrine)', () => {
  const instancePending = {
    instanceId: 'inst-p',
    workerId: 'w1',
    modelName: 'pending-model',
    state: ModelLifecycleState.PENDING,
    deviceIndices: [0],
  };

  const instanceStopped = {
    instanceId: 'inst-s',
    workerId: 'w1',
    modelName: 'stopped-model',
    state: ModelLifecycleState.STOPPED,
    deviceIndices: [0],
  };

  function budgetWithMeasurement(instanceId: string, bytes: number): ReturnType<typeof vi.fn> {
    return vi.fn(() => ({
      workerId: 'w1',
      devices: [
        {
          deviceIndex: 0,
          deviceType: 'CUDA',
          totalBytes: 16 * 1024 ** 3,
          usedBytes: bytes,
          availableBytes: 16 * 1024 ** 3 - bytes,
        },
      ],
      lastReportAt: new Date().toISOString(),
      stale: false,
      instanceMeasurements: [
        { instanceId, modelName: 'llama-3-8b', deviceIndex: 0, measuredUsedBytes: bytes },
      ],
    }));
  }

  it('populates memoryUsedBytes per instance from measured attribution', async () => {
    const { app } = buildApp({
      instances: [instanceActive],
      getWorkerBudget: budgetWithMeasurement('inst-a', 8 * 1024 ** 3),
    });

    const res = await app.inject({ method: 'GET', url: '/api/v1/cluster/memory' });
    expect(res.statusCode).toBe(200);

    const body = res.json<{
      workers: Array<{
        models: Array<{ modelName: string; instanceId?: string; memoryUsedBytes?: number }>;
      }>;
    }>();
    const model = body.workers[0]?.models.find((m) => m.modelName === 'llama-3-8b');
    expect(model?.instanceId).toBe('inst-a');
    expect(model?.memoryUsedBytes).toBe(8 * 1024 ** 3);
  });

  it('omits memoryUsedBytes when nothing has been attributed to the instance yet (e.g. STARTING)', async () => {
    const { app } = buildApp({
      instances: [instanceActive],
      getWorkerBudget: vi.fn(() => undefined),
    });

    const res = await app.inject({ method: 'GET', url: '/api/v1/cluster/memory' });
    const body = res.json<{ workers: Array<{ models: Array<Record<string, unknown>> }> }>();
    const model = body.workers[0]?.models.find((m) => m['modelName'] === 'llama-3-8b');

    expect(model).toBeDefined();
    expect('memoryUsedBytes' in (model as Record<string, unknown>)).toBe(false);
  });

  it('emits one entry with distinct instanceIds for two replicas of a model', async () => {
    const replica2 = { ...instanceActive, instanceId: 'inst-a2' };
    const { app } = buildApp({
      instances: [instanceActive, replica2],
      getWorkerBudget: vi.fn(() => ({
        workerId: 'w1',
        devices: [
          {
            deviceIndex: 0,
            deviceType: 'CUDA',
            totalBytes: 16 * 1024 ** 3,
            usedBytes: 0,
            availableBytes: 16 * 1024 ** 3,
          },
        ],
        lastReportAt: new Date().toISOString(),
        stale: false,
        instanceMeasurements: [
          {
            instanceId: 'inst-a',
            modelName: 'llama-3-8b',
            deviceIndex: 0,
            measuredUsedBytes: 8 * 1024 ** 3,
          },
          {
            instanceId: 'inst-a2',
            modelName: 'llama-3-8b',
            deviceIndex: 0,
            measuredUsedBytes: 8 * 1024 ** 3,
          },
        ],
      })),
    });

    const res = await app.inject({ method: 'GET', url: '/api/v1/cluster/memory' });
    const body = res.json<{
      workers: Array<{
        models: Array<{ modelName: string; instanceId?: string; memoryUsedBytes?: number }>;
      }>;
    }>();
    const models = body.workers[0]?.models.filter((m) => m.modelName === 'llama-3-8b') ?? [];

    expect(models).toHaveLength(2);
    expect(models.map((m) => m.instanceId).sort()).toEqual(['inst-a', 'inst-a2']);
    for (const m of models) {
      expect(m.memoryUsedBytes).toBe(8 * 1024 ** 3);
    }
  });

  it('populates memoryUsedBytes for a SLEEPING instance (stable across ACTIVE/SLEEPING)', async () => {
    const { app } = buildApp({
      instances: [instanceSleeping],
      getWorkerBudget: budgetWithMeasurement('inst-b', 14 * 1024 ** 3),
    });

    const res = await app.inject({ method: 'GET', url: '/api/v1/cluster/memory' });
    const body = res.json<{
      workers: Array<{ models: Array<{ modelName: string; memoryUsedBytes?: number }> }>;
    }>();
    const model = body.workers[0]?.models.find((m) => m.modelName === 'mistral-7b');
    expect(model?.memoryUsedBytes).toBe(14 * 1024 ** 3);
  });

  it('includes displayName on the instance entry when the model record has one', async () => {
    const { app } = buildApp({
      instances: [instanceActive],
      records: [{ name: 'llama-3-8b', displayName: 'Llama 3 8B' }],
    });

    const res = await app.inject({ method: 'GET', url: '/api/v1/cluster/memory' });
    const body = res.json<{ workers: Array<{ models: Array<{ displayName?: string }> }> }>();
    expect(body.workers[0]?.models[0]?.displayName).toBe('Llama 3 8B');
  });

  it('excludes PENDING and STOPPED instances from models even when the PENDING instance carries a measurement', async () => {
    const { app } = buildApp({
      instances: [instanceActive, instancePending, instanceStopped],
      getWorkerBudget: budgetWithMeasurement('inst-p', 4 * 1024 ** 3),
    });

    const res = await app.inject({ method: 'GET', url: '/api/v1/cluster/memory' });
    expect(res.statusCode).toBe(200);

    const body = res.json<{ workers: Array<{ models: Array<{ instanceId?: string }> }> }>();
    expect(body.workers[0]?.models.map((m) => m.instanceId)).toEqual(['inst-a']);
  });
});

describe('measured memory (#163 doctrine: measured is THE number, no reserved/measured split)', () => {
  it('GET /api/v1/cluster/status memory has exactly totalBytes/usedBytes/availableBytes', async () => {
    const { app } = buildApp({
      clusterSummary: {
        totalBytes: 16 * 1024 ** 3,
        usedBytes: 4 * 1024 ** 3,
        availableBytes: 12 * 1024 ** 3,
      },
    });

    const res = await app.inject({ method: 'GET', url: '/api/v1/cluster/status' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ memory: Record<string, unknown> }>();
    expect(body.memory).toEqual({
      totalBytes: 16 * 1024 ** 3,
      usedBytes: 4 * 1024 ** 3,
      availableBytes: 12 * 1024 ** 3,
    });
  });

  it('GET /api/v1/cluster/memory includes per-device deviceName/utilizationPercent/temperatureC and a measured-only summary', async () => {
    const getWorkerBudget = vi.fn(() => ({
      workerId: 'w1',
      devices: [
        {
          deviceIndex: 0,
          deviceType: 'CUDA',
          totalBytes: 16 * 1024 ** 3,
          usedBytes: 5 * 1024 ** 3,
          availableBytes: 11 * 1024 ** 3,
          deviceName: 'NVIDIA GeForce RTX 4070 Ti',
          utilizationPercent: 42,
          temperatureC: 61,
        },
      ],
      lastReportAt: new Date().toISOString(),
      stale: false,
    }));
    const { app } = buildApp({
      getWorkerBudget,
      clusterSummary: {
        totalBytes: 16 * 1024 ** 3,
        usedBytes: 5 * 1024 ** 3,
        availableBytes: 11 * 1024 ** 3,
      },
    });

    const res = await app.inject({ method: 'GET', url: '/api/v1/cluster/memory' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      workers: Array<{
        devices: Array<{
          memoryUsedBytes: number;
          deviceName?: string;
          utilizationPercent?: number;
          temperatureC?: number;
        }>;
      }>;
      summary: Record<string, unknown>;
    }>();
    const device = body.workers[0]?.devices[0];
    expect(device?.memoryUsedBytes).toBe(5 * 1024 ** 3);
    expect(device?.deviceName).toBe('NVIDIA GeForce RTX 4070 Ti');
    expect(device?.utilizationPercent).toBe(42);
    expect(device?.temperatureC).toBe(61);
    expect(body.summary).toEqual({
      totalBytes: 16 * 1024 ** 3,
      usedBytes: 5 * 1024 ** 3,
      availableBytes: 11 * 1024 ** 3,
    });
  });

  it('GET /api/v1/cluster/memory omits deviceName/utilizationPercent/temperatureC per-device when the budget device has none, and never emits memoryReservedBytes', async () => {
    const { app } = buildApp({});

    const res = await app.inject({ method: 'GET', url: '/api/v1/cluster/memory' });
    const body = res.json<{ workers: Array<{ devices: Array<Record<string, unknown>> }> }>();
    const device = body.workers[0]?.devices[0];
    expect(device).toBeDefined();
    expect('deviceName' in (device ?? {})).toBe(false);
    expect('utilizationPercent' in (device ?? {})).toBe(false);
    expect('temperatureC' in (device ?? {})).toBe(false);
    expect('memoryReservedBytes' in (device ?? {})).toBe(false);
    expect('memoryMeasuredUsedBytes' in (device ?? {})).toBe(false);
    expect('kvCache' in (device ?? {})).toBe(false);
  });

  it('GET /api/v1/cluster/memory relays the per-device kvCache block verbatim (issue #165)', async () => {
    const kvCache = {
      totalBytes: 12 * 1024 ** 3,
      usedBytes: 5 * 1024 ** 3,
      preallocBytes: 1 * 1024 ** 3,
      freeBytes: 6 * 1024 ** 3,
    };
    const getWorkerBudget = vi.fn(() => ({
      workerId: 'w1',
      devices: [
        {
          deviceIndex: 0,
          deviceType: 'CUDA',
          totalBytes: 16 * 1024 ** 3,
          usedBytes: 5 * 1024 ** 3,
          availableBytes: 11 * 1024 ** 3,
          kvCache,
        },
      ],
      lastReportAt: new Date().toISOString(),
      stale: false,
    }));
    const { app } = buildApp({
      getWorkerBudget,
      clusterSummary: {
        totalBytes: 16 * 1024 ** 3,
        usedBytes: 5 * 1024 ** 3,
        availableBytes: 11 * 1024 ** 3,
      },
    });

    const res = await app.inject({ method: 'GET', url: '/api/v1/cluster/memory' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      workers: Array<{ devices: Array<Record<string, unknown>> }>;
      summary: Record<string, unknown>;
    }>();
    const device = body.workers[0]?.devices[0];
    expect(device?.kvCache).toEqual(kvCache);
    // kvCache is telemetry only — the VRAM figures are untouched by it.
    expect(device?.memoryUsedBytes).toBe(5 * 1024 ** 3);
    expect(device?.memoryAvailableBytes).toBe(11 * 1024 ** 3);
  });
});
