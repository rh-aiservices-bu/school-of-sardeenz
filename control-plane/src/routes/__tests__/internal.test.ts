import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { ModelLifecycleState } from '@sardeenz/types';

import { registerInternalRoutes } from '../internal.js';
import { ControlPlaneError } from '../../errors.js';
import type { RouteDeps } from '../deps.js';
import type { ModelState } from '../../services/model-lifecycle.js';

interface WakeResponse {
  accepted: boolean;
  modelName: string;
  currentState: string;
  message: string;
}

interface ErrorResponse {
  error: string;
  code: string;
  details?: Record<string, unknown>;
}

function makeSleepingState(overrides: Partial<ModelState> = {}): ModelState {
  return {
    modelName: 'test-model',
    state: ModelLifecycleState.SLEEPING,
    workerId: 'worker-1',
    runnerHost: '10.0.0.1',
    runnerPort: 5001,
    runnerId: 'runner-abc',
    deviceIndices: null,
    lastInferenceAt: null,
    stateChangedAt: new Date().toISOString(),
    errorMessage: null,
    ...overrides,
  };
}

// Mocks keyed by method name for easy vi.fn() access without unbound-method warnings.
interface MockLifecycle {
  getState: ReturnType<typeof vi.fn>;
  transition: ReturnType<typeof vi.fn>;
  getAllStates: ReturnType<typeof vi.fn>;
  createModel: ReturnType<typeof vi.fn>;
  removeModel: ReturnType<typeof vi.fn>;
  updateLastInference: ReturnType<typeof vi.fn>;
}

interface MockSleepWake {
  wakeModel: ReturnType<typeof vi.fn>;
}

interface MockRoutingMap {
  getRoutingMap: ReturnType<typeof vi.fn>;
}

interface Mocks {
  lifecycle: MockLifecycle;
  sleepWake: MockSleepWake;
  routingMap: MockRoutingMap;
  createRunnerClient: ReturnType<typeof vi.fn>;
  leaderElection: { isLeader: boolean };
}

function createMocks(): Mocks {
  return {
    lifecycle: {
      getState: vi.fn(),
      transition: vi.fn().mockResolvedValue({}),
      getAllStates: vi.fn(),
      createModel: vi.fn(),
      removeModel: vi.fn(),
      updateLastInference: vi.fn(),
    },
    sleepWake: {
      wakeModel: vi.fn().mockResolvedValue(undefined),
    },
    routingMap: {
      getRoutingMap: vi.fn().mockResolvedValue({}),
    },
    createRunnerClient: vi.fn().mockReturnValue({
      wake: vi.fn().mockResolvedValue(undefined),
      getHealth: vi.fn(),
    }),
    leaderElection: { isLeader: true },
  };
}

function toDeps(mocks: Mocks): RouteDeps {
  return {
    config: {} as RouteDeps['config'],
    modelRepository: {} as RouteDeps['modelRepository'],
    lifecycle: mocks.lifecycle as unknown as RouteDeps['lifecycle'],
    memoryBudget: {} as RouteDeps['memoryBudget'],
    workerPool: {} as RouteDeps['workerPool'],
    routingMap: mocks.routingMap as unknown as RouteDeps['routingMap'],
    placement: {} as RouteDeps['placement'],
    eviction: {} as RouteDeps['eviction'],
    sleepWake: mocks.sleepWake as unknown as RouteDeps['sleepWake'],
    deployOrchestration: {} as RouteDeps['deployOrchestration'],
    leaderElection: mocks.leaderElection as unknown as RouteDeps['leaderElection'],
    notifications: {} as RouteDeps['notifications'],
    catalogService: {} as RouteDeps['catalogService'],
    moduleStore: {} as RouteDeps['moduleStore'],
    createRunnerClient: mocks.createRunnerClient,
  };
}

async function buildTestApp(deps: RouteDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ControlPlaneError) {
      return reply.code(error.statusCode).send(error.toResponse());
    }
    const message = error instanceof Error ? error.message : String(error);
    return reply.code(500).send({ error: message, code: 'INTERNAL_ERROR' });
  });

  registerInternalRoutes(app, deps);
  await app.ready();
  return app;
}

describe('POST /api/v1/wake — internal wake route', () => {
  let app: FastifyInstance;
  let mocks: Mocks;

  beforeEach(() => {
    mocks = createMocks();
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  // -------------------------------------------------------------------------
  // Leader gate
  // -------------------------------------------------------------------------

  it('rejects requests when this instance is not the leader', async () => {
    mocks.leaderElection.isLeader = false;
    mocks.lifecycle.getState.mockResolvedValue(makeSleepingState());
    app = await buildTestApp(toDeps(mocks));

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/wake',
      payload: { modelName: 'test-model' },
    });

    expect(res.statusCode).toBe(503);
    expect(res.json<ErrorResponse>().code).toBe('NOT_LEADER');
    // Must not have attempted any state transition or background work
    expect(mocks.lifecycle.transition).not.toHaveBeenCalled();
    expect(mocks.sleepWake.wakeModel).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Atomic CAS transition
  // -------------------------------------------------------------------------

  it('atomically transitions SLEEPING → STARTING before launching background wake', async () => {
    mocks.lifecycle.getState.mockResolvedValue(makeSleepingState());
    app = await buildTestApp(toDeps(mocks));

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/wake',
      payload: { modelName: 'test-model' },
    });

    expect(res.statusCode).toBe(202);

    // The atomic transition must happen BEFORE wakeModel is called
    const transitionOrder = mocks.lifecycle.transition.mock.invocationCallOrder[0];
    const wakeOrder = mocks.sleepWake.wakeModel.mock.invocationCallOrder[0];

    expect(transitionOrder).toBeDefined();
    expect(wakeOrder).toBeDefined();
    expect(transitionOrder).toBeLessThan(wakeOrder);

    expect(mocks.lifecycle.transition).toHaveBeenCalledWith(
      'test-model',
      ModelLifecycleState.STARTING,
    );
  });

  it('does not launch background wake when CAS transition fails (concurrent request lost the race)', async () => {
    mocks.lifecycle.getState.mockResolvedValue(makeSleepingState());
    // Simulate CAS failure: another request already moved the state to STARTING
    mocks.lifecycle.transition.mockRejectedValue(
      ControlPlaneError.invalidState(
        'test-model',
        ModelLifecycleState.STARTING,
        'transition to STARTING',
      ),
    );
    app = await buildTestApp(toDeps(mocks));

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/wake',
      payload: { modelName: 'test-model' },
    });

    // The route should propagate the error (409 INVALID_STATE)
    expect(res.statusCode).toBe(409);
    expect(res.json<ErrorResponse>().code).toBe('INVALID_STATE');

    // Background wake must NOT have been started
    expect(mocks.sleepWake.wakeModel).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Idempotent responses for non-SLEEPING states
  // -------------------------------------------------------------------------

  it('returns 200 when model is already ACTIVE', async () => {
    mocks.lifecycle.getState.mockResolvedValue(
      makeSleepingState({ state: ModelLifecycleState.ACTIVE }),
    );
    app = await buildTestApp(toDeps(mocks));

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/wake',
      payload: { modelName: 'test-model' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<WakeResponse>().currentState).toBe(ModelLifecycleState.ACTIVE);
    expect(mocks.lifecycle.transition).not.toHaveBeenCalled();
    expect(mocks.sleepWake.wakeModel).not.toHaveBeenCalled();
  });

  it('returns 202 idempotently when model is already STARTING', async () => {
    mocks.lifecycle.getState.mockResolvedValue(
      makeSleepingState({ state: ModelLifecycleState.STARTING }),
    );
    app = await buildTestApp(toDeps(mocks));

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/wake',
      payload: { modelName: 'test-model' },
    });

    expect(res.statusCode).toBe(202);
    expect(res.json<WakeResponse>().currentState).toBe(ModelLifecycleState.STARTING);
    expect(mocks.lifecycle.transition).not.toHaveBeenCalled();
    expect(mocks.sleepWake.wakeModel).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Happy path
  // -------------------------------------------------------------------------

  it('returns 202 with STARTING state on successful wake initiation', async () => {
    mocks.lifecycle.getState.mockResolvedValue(makeSleepingState());
    app = await buildTestApp(toDeps(mocks));

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/wake',
      payload: { modelName: 'test-model' },
    });

    expect(res.statusCode).toBe(202);
    const body = res.json<WakeResponse>();
    expect(body.accepted).toBe(true);
    expect(body.modelName).toBe('test-model');
    expect(body.currentState).toBe(ModelLifecycleState.STARTING);
    expect(body.message).toBe('Wake initiated');
  });

  it('creates a runner client and calls wakeModel with it', async () => {
    const mockRunnerClient = { wake: vi.fn(), getHealth: vi.fn() };
    mocks.createRunnerClient.mockReturnValue(mockRunnerClient);
    mocks.lifecycle.getState.mockResolvedValue(makeSleepingState());
    app = await buildTestApp(toDeps(mocks));

    await app.inject({
      method: 'POST',
      url: '/api/v1/wake',
      payload: { modelName: 'test-model' },
    });

    expect(mocks.createRunnerClient).toHaveBeenCalledWith('10.0.0.1', 5001);
    expect(mocks.sleepWake.wakeModel).toHaveBeenCalledWith('test-model', mockRunnerClient);
  });

  // -------------------------------------------------------------------------
  // Validation
  // -------------------------------------------------------------------------

  it('rejects request with missing modelName', async () => {
    app = await buildTestApp(toDeps(mocks));

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/wake',
      payload: {},
    });

    expect(res.statusCode).toBe(400);
  });

  it('returns 404 for unknown model', async () => {
    mocks.lifecycle.getState.mockResolvedValue(null);
    app = await buildTestApp(toDeps(mocks));

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/wake',
      payload: { modelName: 'nonexistent' },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json<ErrorResponse>().code).toBe('MODEL_NOT_FOUND');
  });

  it('returns 500 when model has no runner endpoint', async () => {
    mocks.lifecycle.getState.mockResolvedValue(
      makeSleepingState({ runnerHost: null, runnerPort: null }),
    );
    app = await buildTestApp(toDeps(mocks));

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/wake',
      payload: { modelName: 'test-model' },
    });

    expect(res.statusCode).toBe(500);
  });
});
