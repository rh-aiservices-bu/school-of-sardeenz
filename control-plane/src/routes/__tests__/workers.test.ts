// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { WorkerStatus } from '@sardeenz/types';
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
