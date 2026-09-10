// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { ServerResponse } from 'node:http';
import { ModelLifecycleState } from '@sardeenz/types';

import { registerModelLogRoutes } from '../model-logs.js';
import { ControlPlaneError } from '../../errors.js';
import type { RouteDeps } from '../deps.js';
import type { InstanceState } from '../../services/model-lifecycle.js';
import type { WorkerRecord } from '../../services/worker-pool.js';

function makeState(overrides: Partial<InstanceState> = {}): InstanceState {
  return {
    instanceId: 'inst-000000000001',
    modelName: 'test-model',
    state: ModelLifecycleState.STARTING,
    workerId: null,
    runnerHost: null,
    runnerPort: null,
    runnerId: null,
    deviceIndices: null,
    lastInferenceAt: null,
    stateChangedAt: new Date().toISOString(),
    errorMessage: null,
    ...overrides,
  };
}

function makeWorker(overrides: Partial<WorkerRecord> = {}): WorkerRecord {
  return {
    workerId: 'worker-1',
    status: 'ONLINE' as WorkerRecord['status'],
    capabilities: [],
    devices: [],
    lastHeartbeatAt: new Date().toISOString(),
    joinedAt: new Date().toISOString(),
    managementUrl: 'http://worker-1:8080',
    ...overrides,
  };
}

function makeSseBodyStream(frames: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < frames.length) {
        controller.enqueue(encoder.encode(frames[i]));
        i++;
      } else {
        controller.close();
      }
    },
  });
}

function makeUpstreamResponse(frames: string[]): Response {
  return { ok: true, status: 200, body: makeSseBodyStream(frames) } as unknown as Response;
}

function make404Response(): Response {
  return { ok: false, status: 404, body: null } as unknown as Response;
}

interface Mocks {
  lifecycle: { getInstancesForModel: ReturnType<typeof vi.fn> };
  modelRepository: { findByName: ReturnType<typeof vi.fn> };
  workerPool: { getWorker: ReturnType<typeof vi.fn> };
  createWorkerClient: ReturnType<typeof vi.fn>;
}

function createMocks(): Mocks {
  return {
    lifecycle: { getInstancesForModel: vi.fn() },
    modelRepository: { findByName: vi.fn() },
    workerPool: { getWorker: vi.fn() },
    createWorkerClient: vi.fn(),
  };
}

/** Mirrors what the real getInstancesForModel would return for a single-instance model. */
function oneInstance(state: InstanceState | null): InstanceState[] {
  return state ? [state] : [];
}

function toDeps(mocks: Mocks, deployTimeoutSecs = 5): RouteDeps {
  return {
    config: { deployTimeoutSecs } as unknown as RouteDeps['config'],
    modelRepository: mocks.modelRepository as unknown as RouteDeps['modelRepository'],
    instanceRepository: {} as RouteDeps['instanceRepository'],
    lifecycle: mocks.lifecycle as unknown as RouteDeps['lifecycle'],
    memoryBudget: {} as RouteDeps['memoryBudget'],
    workerPool: mocks.workerPool as unknown as RouteDeps['workerPool'],
    routingMap: {} as RouteDeps['routingMap'],
    placement: {} as RouteDeps['placement'],
    eviction: {} as RouteDeps['eviction'],
    sleepWake: {} as RouteDeps['sleepWake'],
    deployOrchestration: {} as RouteDeps['deployOrchestration'],
    moveOrchestration: {} as RouteDeps['moveOrchestration'],
    leaderElection: {} as RouteDeps['leaderElection'],
    notifications: {} as RouteDeps['notifications'],
    catalogService: {} as RouteDeps['catalogService'],
    moduleStore: {} as RouteDeps['moduleStore'],
    weightsBrowser: {} as RouteDeps['weightsBrowser'],
    proxyProtocols: {} as RouteDeps['proxyProtocols'],
    createRunnerClient: vi.fn(),
    createWorkerClient: mocks.createWorkerClient,
  };
}

async function buildTestApp(deps: RouteDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorate('hijackedResponses', new Set<ServerResponse>());
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ControlPlaneError) {
      return reply.code(error.statusCode).send(error.toResponse());
    }
    return reply.code(500).send({ error: (error as Error).message, code: 'INTERNAL_ERROR' });
  });
  registerModelLogRoutes(app, deps);
  await app.ready();
  return app;
}

describe('GET /api/v1/models/:modelName/logs', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close();
  });

  it('returns 404 for an unknown model before hijacking', async () => {
    const mocks = createMocks();
    mocks.lifecycle.getInstancesForModel.mockResolvedValue([]);
    mocks.modelRepository.findByName.mockResolvedValue(null);
    app = await buildTestApp(toDeps(mocks));

    const res = await app.inject({ method: 'GET', url: '/api/v1/models/ghost/logs' });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'MODEL_NOT_FOUND' });
  });

  it('streams worker log frames through by instance when the runner is already placed', async () => {
    const mocks = createMocks();
    // workerId is set at STARTING; runnerId is deliberately NOT required to attach — logs are
    // addressed by instance id so they're reachable during cold-start and after failure.
    mocks.lifecycle.getInstancesForModel.mockResolvedValue(
      oneInstance(makeState({ workerId: 'worker-1', state: ModelLifecycleState.ACTIVE })),
    );
    mocks.workerPool.getWorker.mockReturnValue(makeWorker());
    const streamRunnerLogsByInstance = vi
      .fn()
      .mockResolvedValue(makeUpstreamResponse(['event: log\ndata: hello world\n\n']));
    mocks.createWorkerClient.mockReturnValue({ streamRunnerLogsByInstance });
    app = await buildTestApp(toDeps(mocks));

    const res = await app.inject({ method: 'GET', url: '/api/v1/models/test-model/logs' });

    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.body).toContain('event: log\ndata: hello world');
    expect(res.body).toContain('event: end');
    expect(mocks.createWorkerClient).toHaveBeenCalledWith('http://worker-1:8080');
    expect(streamRunnerLogsByInstance).toHaveBeenCalledWith(
      'inst-000000000001',
      expect.any(AbortSignal),
    );
  });

  it('registers the hijacked raw response and removes it once the stream ends', async () => {
    const mocks = createMocks();
    mocks.lifecycle.getInstancesForModel.mockResolvedValue(
      oneInstance(makeState({ workerId: 'worker-1', state: ModelLifecycleState.ACTIVE })),
    );
    mocks.workerPool.getWorker.mockReturnValue(makeWorker());
    const streamRunnerLogsByInstance = vi
      .fn()
      .mockResolvedValue(makeUpstreamResponse(['event: log\ndata: hello world\n\n']));
    mocks.createWorkerClient.mockReturnValue({ streamRunnerLogsByInstance });
    app = await buildTestApp(toDeps(mocks));

    const addSpy = vi.spyOn(app.hijackedResponses, 'add');
    const deleteSpy = vi.spyOn(app.hijackedResponses, 'delete');

    await app.inject({ method: 'GET', url: '/api/v1/models/test-model/logs' });

    expect(addSpy).toHaveBeenCalledTimes(1);
    expect(deleteSpy).toHaveBeenCalledTimes(1);
    expect(app.hijackedResponses.size).toBe(0);
  });

  it('retries while the worker returns 404, then streams once the runner registers', async () => {
    const mocks = createMocks();
    // workerId is known throughout STARTING; the worker 404s until it receives the start command.
    mocks.lifecycle.getInstancesForModel.mockResolvedValue(
      oneInstance(makeState({ workerId: 'worker-1' })),
    );
    mocks.workerPool.getWorker.mockReturnValue(makeWorker());
    const streamRunnerLogsByInstance = vi
      .fn()
      .mockResolvedValueOnce(make404Response())
      .mockResolvedValueOnce(make404Response())
      .mockResolvedValue(makeUpstreamResponse(['event: log\ndata: late runner\n\n']));
    mocks.createWorkerClient.mockReturnValue({ streamRunnerLogsByInstance });
    app = await buildTestApp(toDeps(mocks));

    const res = await app.inject({ method: 'GET', url: '/api/v1/models/test-model/logs' });

    expect(res.body).toContain(': waiting');
    expect(res.body).toContain('event: log\ndata: late runner');
    expect(streamRunnerLogsByInstance.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(streamRunnerLogsByInstance).toHaveBeenLastCalledWith(
      'inst-000000000001',
      expect.any(AbortSignal),
    );
  }, 10_000);

  it('times out (ending the stream) when the runner never registers', async () => {
    const mocks = createMocks();
    mocks.lifecycle.getInstancesForModel.mockResolvedValue(
      oneInstance(makeState({ workerId: 'worker-1' })),
    );
    mocks.workerPool.getWorker.mockReturnValue(makeWorker());
    // Worker keeps 404-ing — runner never comes up. Short deploy timeout bounds the wait.
    const streamRunnerLogsByInstance = vi.fn().mockResolvedValue(make404Response());
    mocks.createWorkerClient.mockReturnValue({ streamRunnerLogsByInstance });
    app = await buildTestApp(toDeps(mocks, 1));

    const res = await app.inject({ method: 'GET', url: '/api/v1/models/test-model/logs' });

    expect(res.body).toContain(': waiting');
    expect(res.body).toContain('event: end');
    expect(res.body).toContain('timed out waiting for runner placement');
  }, 10_000);

  it('prefers the STARTING instance when the model has a replica already ACTIVE', async () => {
    const mocks = createMocks();
    const active = makeState({
      instanceId: 'inst-active',
      workerId: 'worker-active',
      state: ModelLifecycleState.ACTIVE,
      stateChangedAt: '2026-01-01T00:00:00.000Z',
    });
    const starting = makeState({
      instanceId: 'inst-starting',
      workerId: 'worker-1',
      state: ModelLifecycleState.STARTING,
      stateChangedAt: '2026-06-01T00:00:00.000Z',
    });
    mocks.lifecycle.getInstancesForModel.mockResolvedValue([active, starting]);
    mocks.workerPool.getWorker.mockReturnValue(makeWorker());
    const streamRunnerLogsByInstance = vi
      .fn()
      .mockResolvedValue(makeUpstreamResponse(['event: log\ndata: cold-starting replica\n\n']));
    mocks.createWorkerClient.mockReturnValue({ streamRunnerLogsByInstance });
    app = await buildTestApp(toDeps(mocks));

    await app.inject({ method: 'GET', url: '/api/v1/models/test-model/logs' });

    // The STARTING instance's worker (worker-1) is attached to, not the older ACTIVE one.
    expect(mocks.createWorkerClient).toHaveBeenCalledWith('http://worker-1:8080');
    expect(streamRunnerLogsByInstance).toHaveBeenCalledWith(
      'inst-starting',
      expect.any(AbortSignal),
    );
  });
});
