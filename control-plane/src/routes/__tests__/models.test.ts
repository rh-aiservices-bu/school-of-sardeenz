// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { ModelLifecycleState } from '@sardeenz/types';
import { registerModelRoutes } from '../models.js';
import type { RouteDeps } from '../deps.js';
import type { InstanceState } from '../../services/model-lifecycle.js';

const INSTANCE_ID = 'inst-000000000001';

const ACTIVE_STATE: InstanceState = {
  instanceId: INSTANCE_ID,
  modelName: 'm1',
  state: ModelLifecycleState.ACTIVE,
  workerId: 'worker-1',
  runnerHost: 'localhost',
  runnerPort: 8000,
  runnerId: 'runner-1',
  deviceIndices: [0],
  lastInferenceAt: null,
  stateChangedAt: '2026-01-01T00:00:00Z',
  errorMessage: null,
};

interface Overrides {
  stopModel?: ReturnType<typeof vi.fn>;
  sleepModel?: ReturnType<typeof vi.fn>;
  wakeModel?: ReturnType<typeof vi.fn>;
  removeInstance?: ReturnType<typeof vi.fn>;
  deleteModel?: ReturnType<typeof vi.fn>;
  deleteInstance?: ReturnType<typeof vi.fn>;
  findByName?: ReturnType<typeof vi.fn>;
  getInstance?: ReturnType<typeof vi.fn>;
  getInstancesForModel?: ReturnType<typeof vi.fn>;
  transition?: ReturnType<typeof vi.fn>;
}

function buildApp(over: Overrides = {}): {
  app: FastifyInstance;
  logInfo: ReturnType<typeof vi.fn>;
  logError: ReturnType<typeof vi.fn>;
} {
  const logInfo = vi.fn();
  const logError = vi.fn();

  const getInstance = over.getInstance ?? vi.fn(() => Promise.resolve(ACTIVE_STATE));
  const getInstancesForModel =
    over.getInstancesForModel ??
    vi.fn(async () => {
      const state = (await getInstance()) as InstanceState | null;
      return state ? [state] : [];
    });

  const deps = {
    leaderElection: { isLeader: true },
    lifecycle: {
      getInstance,
      getInstancesForModel,
      getAllInstances: vi.fn(() => Promise.resolve([])),
      removeInstance: over.removeInstance ?? vi.fn(() => Promise.resolve()),
      transition: over.transition ?? vi.fn(() => Promise.resolve()),
    },
    sleepWake: {
      stopModel: over.stopModel ?? vi.fn(() => Promise.resolve()),
      sleepModel: over.sleepModel ?? vi.fn(() => Promise.resolve()),
      wakeModel: over.wakeModel ?? vi.fn(() => Promise.resolve()),
    },
    routingMap: {
      setModelState: vi.fn(() => Promise.resolve()),
      removeModel: vi.fn(() => Promise.resolve()),
    },
    modelRepository: {
      delete: over.deleteModel ?? vi.fn(() => Promise.resolve()),
      findByName: over.findByName ?? vi.fn(() => Promise.resolve({ name: 'm1' })),
    },
    instanceRepository: {
      delete: over.deleteInstance ?? vi.fn(() => Promise.resolve(true)),
    },
    notifications: {
      createNotification: vi.fn(() => Promise.resolve()),
    },
    createRunnerClient: vi.fn(() => ({})),
  } as unknown as RouteDeps;

  const app = Fastify({ logger: false });
  app.log.info = logInfo;
  app.log.error = logError;
  app.setErrorHandler((error: Error & { statusCode?: number; code?: string }, _req, reply) => {
    return reply.code(error.statusCode ?? 500).send({ error: error.message, code: error.code });
  });
  registerModelRoutes(app, deps);
  return { app, logInfo, logError };
}

interface DeployOverrides {
  place?: ReturnType<typeof vi.fn>;
  eligibleWorkerIds?: ReturnType<typeof vi.fn>;
  selectVictims?: ReturnType<typeof vi.fn>;
  createInstance?: ReturnType<typeof vi.fn>;
  transition?: ReturnType<typeof vi.fn>;
  getAllInstances?: ReturnType<typeof vi.fn>;
  getInstancesForModel?: ReturnType<typeof vi.fn>;
  removeInstance?: ReturnType<typeof vi.fn>;
  stopModel?: ReturnType<typeof vi.fn>;
  refreshAll?: ReturnType<typeof vi.fn>;
  deployModel?: ReturnType<typeof vi.fn>;
  findAll?: ReturnType<typeof vi.fn>;
  findByName?: ReturnType<typeof vi.fn>;
  createModelRecord?: ReturnType<typeof vi.fn>;
  setModelState?: ReturnType<typeof vi.fn>;
  createInstanceRecord?: ReturnType<typeof vi.fn>;
}

function buildDeployApp(over: DeployOverrides = {}): {
  app: FastifyInstance;
  deps: Record<string, unknown>;
  logError: ReturnType<typeof vi.fn>;
} {
  const logError = vi.fn();

  const deps = {
    config: { weightsDir: '/weights' },
    leaderElection: { isLeader: true },
    modelRepository: {
      // Default mirrors ModelRepository.create: echoes params back as a ModelRecord, filling in
      // column defaults for anything the caller didn't set. deployFromRecord (shared by deploy and
      // start) reads every one of these fields off the returned record.
      create:
        over.createModelRecord ??
        vi.fn((params: Record<string, unknown>) =>
          Promise.resolve({
            id: 'rec-1',
            name: params.name,
            runnerType: params.runnerType,
            modelPath: params.modelPath,
            requiredMemory: (params.requiredMemory as number | undefined) ?? null,
            deviceType: (params.deviceType as string | undefined) ?? null,
            tensorParallel: (params.tensorParallel as number | undefined) ?? 1,
            engineConfig: (params.engineConfig as Record<string, unknown> | undefined) ?? null,
            runtimeModule: (params.runtimeModule as string | undefined) ?? null,
            pinned: (params.pinned as boolean | undefined) ?? false,
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        ),
      findAll: over.findAll ?? vi.fn(() => Promise.resolve([])),
      findByName: over.findByName ?? vi.fn(() => Promise.resolve(null)),
      delete: vi.fn(() => Promise.resolve()),
    },
    instanceRepository: {
      create: over.createInstanceRecord ?? vi.fn(() => Promise.resolve({})),
      delete: vi.fn(() => Promise.resolve(true)),
      findByModel: vi.fn(() => Promise.resolve([])),
    },
    lifecycle: {
      createInstance: over.createInstance ?? vi.fn(() => Promise.resolve()),
      getAllInstances: over.getAllInstances ?? vi.fn(() => Promise.resolve([])),
      getInstancesForModel: over.getInstancesForModel ?? vi.fn(() => Promise.resolve([])),
      getLastInferenceTimestamps: vi.fn(() => Promise.resolve(new Map())),
      getInstance: vi.fn(() => Promise.resolve(null)),
      transition: over.transition ?? vi.fn(() => Promise.resolve()),
      removeInstance: over.removeInstance ?? vi.fn(() => Promise.resolve()),
    },
    workerPool: { getAllWorkers: vi.fn(() => []) },
    memoryBudget: {
      getAllBudgets: vi.fn(() => []),
      reserveCapacity: vi.fn(),
      releaseInstanceReservations: vi.fn(),
      refreshAll: over.refreshAll ?? vi.fn(() => Promise.resolve()),
    },
    placement: {
      place: over.place ?? vi.fn(() => null),
      eligibleWorkerIds: over.eligibleWorkerIds ?? vi.fn(() => new Set(['w1'])),
    },
    eviction: {
      selectVictims: over.selectVictims ?? vi.fn(() => []),
      startTimer: vi.fn(() => vi.fn()),
      recordEviction: vi.fn(),
    },
    sleepWake: {
      stopModel: over.stopModel ?? vi.fn(() => Promise.resolve()),
    },
    deployOrchestration: {
      deployModel: over.deployModel ?? vi.fn(() => Promise.resolve()),
    },
    routingMap: {
      setModelState: over.setModelState ?? vi.fn(() => Promise.resolve()),
      removeModel: vi.fn(() => Promise.resolve()),
    },
    notifications: {
      createNotification: vi.fn(() => Promise.resolve()),
    },
    createRunnerClient: vi.fn(() => ({})),
  } as unknown as RouteDeps;

  const app = Fastify({ logger: false });
  app.log.error = logError;
  app.setErrorHandler((error: Error & { statusCode?: number; code?: string }, _req, reply) => {
    return reply.code(error.statusCode ?? 500).send({ error: error.message, code: error.code });
  });
  registerModelRoutes(app, deps);
  return { app, deps: deps as unknown as Record<string, unknown>, logError };
}

const DEPLOY_BODY = {
  modelName: 'm1',
  runnerType: 'vllm',
  modelPath: '/weights/m1',
  requiredMemory: 8e9,
};

describe('POST /api/v1/models deploy-path eviction', () => {
  it('returns 202 with capacity reclamation message when eviction is needed', async () => {
    const victim = {
      instanceId: 'inst-old',
      modelName: 'old-model',
      state: ModelLifecycleState.ACTIVE,
      workerId: 'w1',
      memoryBytes: 8e9,
      lastInferenceAt: null,
      pinned: false,
    };
    const { app, deps } = buildDeployApp({
      selectVictims: vi.fn(() => [victim]),
    });

    const res = await app.inject({ method: 'POST', url: '/api/v1/models', payload: DEPLOY_BODY });

    expect(res.statusCode).toBe(202);
    expect(res.json<{ state: string; message: string; instanceId: string }>()).toMatchObject({
      modelName: 'm1',
      state: ModelLifecycleState.PENDING,
      message: 'Capacity reclamation in progress',
      instanceId: expect.stringMatching(/^inst-/) as string,
    });

    const placement = deps.placement as { eligibleWorkerIds: ReturnType<typeof vi.fn> };
    expect(placement.eligibleWorkerIds).toHaveBeenCalledOnce();
  });

  it('transitions to ERROR and notifies when background reclamation fails', async () => {
    const victim = {
      instanceId: 'inst-old',
      modelName: 'old-model',
      state: ModelLifecycleState.ACTIVE,
      workerId: 'w1',
      memoryBytes: 8e9,
      lastInferenceAt: null,
      pinned: false,
    };
    // place() returns null both on the initial attempt and after reclamation,
    // forcing the background block into its failure path.
    const { app, deps } = buildDeployApp({
      selectVictims: vi.fn(() => [victim]),
      place: vi.fn(() => null),
    });

    const res = await app.inject({ method: 'POST', url: '/api/v1/models', payload: DEPLOY_BODY });
    expect(res.statusCode).toBe(202);

    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const lifecycle = deps.lifecycle as { transition: ReturnType<typeof vi.fn> };
    const routingMap = deps.routingMap as {
      setModelState: ReturnType<typeof vi.fn>;
      removeModel: ReturnType<typeof vi.fn>;
    };
    const notifications = deps.notifications as { createNotification: ReturnType<typeof vi.fn> };

    expect(lifecycle.transition).toHaveBeenCalledWith(
      'm1',
      expect.stringMatching(/^inst-/) as string,
      ModelLifecycleState.ERROR,
      expect.objectContaining({ errorMessage: expect.any(String) as string }),
    );
    // refreshModelRoutingState resolves the aggregate from getInstancesForModel — which defaults
    // to [] in buildDeployApp, so the failed-and-error'd instance has no live sibling and the
    // model is removed from the routing map entirely rather than set to ERROR.
    expect(routingMap.removeModel).toHaveBeenCalledWith('m1');
    void routingMap.setModelState;
    expect(notifications.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ variant: 'danger' }),
    );
  });

  it('throws PLACEMENT_FAILED when no worker is eligible', async () => {
    const { app } = buildDeployApp({
      eligibleWorkerIds: vi.fn(() => new Set()),
    });

    const res = await app.inject({ method: 'POST', url: '/api/v1/models', payload: DEPLOY_BODY });

    expect(res.statusCode).toBe(503);
    expect(res.json<{ code: string }>().code).toBe('PLACEMENT_FAILED');
  });

  it('throws PLACEMENT_FAILED when eligible workers exist but no victims are found', async () => {
    const { app } = buildDeployApp({
      selectVictims: vi.fn(() => []),
    });

    const res = await app.inject({ method: 'POST', url: '/api/v1/models', payload: DEPLOY_BODY });

    expect(res.statusCode).toBe(503);
    expect(res.json<{ code: string }>().code).toBe('PLACEMENT_FAILED');
  });
});

describe('POST /api/v1/models modelName validation', () => {
  it('accepts a modelName with the org/model-name shape', async () => {
    const { app } = buildDeployApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/models',
      payload: { ...DEPLOY_BODY, modelName: 'meta-llama/Llama-3.1-8B-Instruct' },
    });

    expect(res.statusCode).not.toBe(400);
  });

  it.each([
    ['contains a space', 'my model'],
    ['contains a colon', 'model:tag'],
    ['exceeds 200 characters', 'a'.repeat(201)],
    ['is empty', ''],
  ])('rejects modelName that %s', async (_desc, modelName) => {
    const { app } = buildDeployApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/models',
      payload: { ...DEPLOY_BODY, modelName },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ code: string }>().code).toBe('INVALID_REQUEST');
  });
});

describe('POST /api/v1/models modelPath containment', () => {
  it.each([
    ['is outside the weights root', '/etc/passwd'],
    ['is relative', 'weights/m1'],
    ['traverses out of the weights root', '/weights/../etc/passwd'],
  ])('rejects modelPath that %s', async (_desc, modelPath) => {
    const { app } = buildDeployApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/models',
      payload: { ...DEPLOY_BODY, modelPath },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ code: string }>().code).toBe('INVALID_REQUEST');
  });
});

describe('deployFromRecord synchronous-failure reservation release (security L1)', () => {
  it('releases the instance reservation when a post-reserve step throws synchronously', async () => {
    const { app, deps } = buildDeployApp({
      place: vi.fn(() => ({ workerId: 'w1', devices: [{ deviceIndex: 0, deviceType: 'CUDA' }] })),
      transition: vi.fn(() => Promise.reject(new Error('transition failed'))),
    });

    const res = await app.inject({ method: 'POST', url: '/api/v1/models', payload: DEPLOY_BODY });

    // Synchronous placement failure surfaces as a 500 to the caller (the DB row is rolled back).
    expect(res.statusCode).toBe(500);

    const memoryBudget = deps.memoryBudget as { releaseInstanceReservations: ReturnType<typeof vi.fn> };
    expect(memoryBudget.releaseInstanceReservations).toHaveBeenCalledWith(
      expect.stringMatching(/^inst-/) as string,
    );
  });
});

describe('POST /api/v1/models/:modelName/instances', () => {
  it('creates an additional instance without 409ing when the model already has one', async () => {
    const deployModel = vi.fn(() => Promise.resolve());
    const { app } = buildDeployApp({
      findByName: vi.fn(() =>
        Promise.resolve({
          name: 'm1',
          runnerType: 'vllm',
          modelPath: '/weights/m1',
          requiredMemory: 8e9,
          tensorParallel: 1,
          pinned: false,
        }),
      ),
      place: vi.fn(() => ({ workerId: 'w2', devices: [{ deviceIndex: 0, deviceType: 'CUDA' }] })),
      deployModel,
    });

    const res = await app.inject({ method: 'POST', url: '/api/v1/models/m1/instances' });

    expect(res.statusCode).toBe(202);
    expect(res.json<{ modelName: string; instanceId: string }>()).toMatchObject({
      modelName: 'm1',
      instanceId: expect.stringMatching(/^inst-/) as string,
    });
  });

  it('returns 404 when no model record exists', async () => {
    const { app } = buildDeployApp({
      findByName: vi.fn(() => Promise.resolve(null)),
    });

    const res = await app.inject({ method: 'POST', url: '/api/v1/models/m1/instances' });

    expect(res.statusCode).toBe(404);
    expect(res.json<{ code: string }>().code).toBe('MODEL_NOT_FOUND');
  });
});

describe('DELETE /api/v1/models/:modelName background deletion', () => {
  let app: FastifyInstance;
  let logInfo: ReturnType<typeof vi.fn>;
  let logError: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    ({ app, logInfo, logError } = buildApp());
  });

  it('background delete succeeds end-to-end', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/v1/models/m1' });
    expect(res.statusCode).toBe(202);

    await new Promise((resolve) => setImmediate(resolve));

    expect(logInfo).toHaveBeenCalledWith({ modelName: 'm1' }, 'Model removed');
    expect(logError).not.toHaveBeenCalled();
  });

  it('background delete survives modelRepository.delete rejection', async () => {
    const { app: a, logError: err } = buildApp({
      deleteModel: vi.fn(() => Promise.reject(new Error('db down'))),
    });

    const res = await a.inject({ method: 'DELETE', url: '/api/v1/models/m1' });
    expect(res.statusCode).toBe(202);

    await new Promise((resolve) => setImmediate(resolve));

    expect(err).toHaveBeenCalledWith(
      { err: expect.any(Error) as Error, modelName: 'm1' },
      'Background model deletion failed',
    );
  });

  it('background delete isolates a failing instance teardown and still removes the record', async () => {
    const deleteModel = vi.fn(() => Promise.resolve());
    const { app: a, logError: err, logInfo: info } = buildApp({
      removeInstance: vi.fn(() => Promise.reject(new Error('lifecycle failure'))),
      deleteModel,
    });

    const res = await a.inject({ method: 'DELETE', url: '/api/v1/models/m1' });
    expect(res.statusCode).toBe(202);

    await new Promise((resolve) => setImmediate(resolve));

    // Per-instance failure is logged by teardownInstance itself...
    expect(err).toHaveBeenCalledWith(
      { err: expect.any(Error) as Error, modelName: 'm1', instanceId: INSTANCE_ID },
      'Delete: instance teardown failed',
    );
    // ...and summarized once for the whole fan-out...
    expect(err).toHaveBeenCalledWith(
      { modelName: 'm1', failures: 1, total: 1 },
      'Some instances failed teardown during model delete',
    );
    // ...but the model row and routing map are still cleaned up (M1: Delete must not abort on a
    // single instance's teardown failure).
    expect(deleteModel).toHaveBeenCalledWith('m1');
    expect(info).toHaveBeenCalledWith({ modelName: 'm1' }, 'Model removed');
  });

  it('isolates teardown across 3 instances — a middle failure does not strand the others or abort the delete', async () => {
    const instances = ['inst-a', 'inst-b', 'inst-c'].map((instanceId) => ({
      ...ACTIVE_STATE,
      instanceId,
    }));
    const removeInstance = vi.fn((_modelName: string, instanceId: string) => {
      if (instanceId === 'inst-b') return Promise.reject(new Error('inst-b teardown failed'));
      return Promise.resolve();
    });
    const deleteModel = vi.fn(() => Promise.resolve());
    const { app: a, logError: err, logInfo: info } = buildApp({
      getInstancesForModel: vi.fn(() => Promise.resolve(instances)),
      removeInstance,
      deleteModel,
    });

    const res = await a.inject({ method: 'DELETE', url: '/api/v1/models/m1' });
    expect(res.statusCode).toBe(202);

    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(removeInstance).toHaveBeenCalledWith('m1', 'inst-a');
    expect(removeInstance).toHaveBeenCalledWith('m1', 'inst-b');
    expect(removeInstance).toHaveBeenCalledWith('m1', 'inst-c');
    expect(err).toHaveBeenCalledWith(
      { modelName: 'm1', failures: 1, total: 3 },
      'Some instances failed teardown during model delete',
    );
    expect(deleteModel).toHaveBeenCalledWith('m1');
    expect(info).toHaveBeenCalledWith({ modelName: 'm1' }, 'Model removed');
  });
});

describe('DELETE /api/v1/models/:modelName tombstone and state guards', () => {
  it('returns 202 and removes DB row for evicted model (no instances)', async () => {
    const deleteModel = vi.fn(() => Promise.resolve());
    const { app } = buildApp({
      getInstance: vi.fn(() => Promise.resolve(null)),
      getInstancesForModel: vi.fn(() => Promise.resolve([])),
      findByName: vi.fn(() => Promise.resolve({ name: 'm1' })),
      deleteModel,
    });

    const res = await app.inject({ method: 'DELETE', url: '/api/v1/models/m1' });

    expect(res.statusCode).toBe(202);
    expect(res.json<{ state: string }>()).toMatchObject({
      modelName: 'm1',
      state: ModelLifecycleState.STOPPED,
      previousState: ModelLifecycleState.STOPPED,
    });
    expect(deleteModel).toHaveBeenCalledWith('m1');
  });

  it('returns 404 when model has neither instances nor DB record', async () => {
    const { app } = buildApp({
      getInstance: vi.fn(() => Promise.resolve(null)),
      getInstancesForModel: vi.fn(() => Promise.resolve([])),
      findByName: vi.fn(() => Promise.resolve(null)),
    });

    const res = await app.inject({ method: 'DELETE', url: '/api/v1/models/m1' });

    expect(res.statusCode).toBe(404);
    expect(res.json<{ code: string }>().code).toBe('MODEL_NOT_FOUND');
  });

  it('allows delete when the (only) instance is in STOPPED state', async () => {
    const stopped = { ...ACTIVE_STATE, state: ModelLifecycleState.STOPPED };
    const { app } = buildApp({
      getInstance: vi.fn(() => Promise.resolve(stopped)),
      getInstancesForModel: vi.fn(() => Promise.resolve([stopped])),
    });

    const res = await app.inject({ method: 'DELETE', url: '/api/v1/models/m1' });

    expect(res.statusCode).toBe(202);
  });

  it('returns 409 when an instance is in STOPPING state', async () => {
    const stopping = { ...ACTIVE_STATE, state: ModelLifecycleState.STOPPING };
    const { app } = buildApp({
      getInstance: vi.fn(() => Promise.resolve(stopping)),
      getInstancesForModel: vi.fn(() => Promise.resolve([stopping])),
    });

    const res = await app.inject({ method: 'DELETE', url: '/api/v1/models/m1' });

    expect(res.statusCode).toBe(409);
    expect(res.json<{ code: string }>().code).toBe('INVALID_STATE');
  });
});

describe('POST /api/v1/models/:modelName/stop', () => {
  it('stop on an ACTIVE model returns 202 and keeps the record', async () => {
    const deleteModel = vi.fn(() => Promise.resolve());
    const removeInstance = vi.fn(() => Promise.resolve());
    const stopModel = vi.fn(() => Promise.resolve());
    const { app } = buildApp({ deleteModel, removeInstance, stopModel });

    const res = await app.inject({ method: 'POST', url: '/api/v1/models/m1/stop' });

    expect(res.statusCode).toBe(202);
    expect(res.json<{ state: string; previousState: string }>()).toMatchObject({
      modelName: 'm1',
      state: ModelLifecycleState.STOPPING,
      previousState: ModelLifecycleState.ACTIVE,
    });

    await new Promise((resolve) => setImmediate(resolve));

    expect(stopModel).toHaveBeenCalledWith('m1', INSTANCE_ID, expect.anything());
    expect(removeInstance).toHaveBeenCalledWith('m1', INSTANCE_ID);
    expect(deleteModel).not.toHaveBeenCalled();
  });

  it('returns 404 when the model has no instances', async () => {
    const { app } = buildApp({
      getInstance: vi.fn(() => Promise.resolve(null)),
      getInstancesForModel: vi.fn(() => Promise.resolve([])),
    });

    const res = await app.inject({ method: 'POST', url: '/api/v1/models/m1/stop' });

    expect(res.statusCode).toBe(404);
    expect(res.json<{ code: string }>().code).toBe('MODEL_NOT_FOUND');
  });

  it.each([
    ModelLifecycleState.PENDING,
    ModelLifecycleState.STARTING,
    ModelLifecycleState.DRAINING,
    ModelLifecycleState.STOPPING,
  ])('returns 409 when the (only) instance is %s (transient state)', async (state) => {
    const transient = { ...ACTIVE_STATE, state };
    const { app } = buildApp({
      getInstance: vi.fn(() => Promise.resolve(transient)),
      getInstancesForModel: vi.fn(() => Promise.resolve([transient])),
    });

    const res = await app.inject({ method: 'POST', url: '/api/v1/models/m1/stop' });

    expect(res.statusCode).toBe(409);
    expect(res.json<{ code: string }>().code).toBe('INVALID_STATE');
  });

  it('rejects a concurrent second Stop while the first is still backgrounding', async () => {
    const { app } = buildApp();

    const [first, second] = await Promise.all([
      app.inject({ method: 'POST', url: '/api/v1/models/m1/stop' }),
      app.inject({ method: 'POST', url: '/api/v1/models/m1/stop' }),
    ]);

    const statusCodes = [first.statusCode, second.statusCode].sort((a, b) => a - b);
    expect(statusCodes).toEqual([202, 409]);

    const rejected = first.statusCode === 409 ? first : second;
    expect(rejected.json<{ code: string }>().code).toBe('INVALID_STATE');
  });

  it('isolates a failing instance teardown and still clears the in-flight claim', async () => {
    const { app, logError } = buildApp({
      stopModel: vi.fn(() => Promise.reject(new Error('runner gone'))),
    });

    const res = await app.inject({ method: 'POST', url: '/api/v1/models/m1/stop' });
    expect(res.statusCode).toBe(202);

    await new Promise((resolve) => setImmediate(resolve));

    expect(logError).toHaveBeenCalledWith(
      { err: expect.any(Error) as Error, modelName: 'm1', instanceId: INSTANCE_ID },
      'Stop: instance teardown failed',
    );
    expect(logError).toHaveBeenCalledWith(
      { modelName: 'm1', failures: 1, total: 1 },
      'Some instances failed teardown during model stop',
    );

    // The in-flight claim was released despite the failure — a retry is possible.
    const retry = await app.inject({ method: 'POST', url: '/api/v1/models/m1/stop' });
    expect(retry.statusCode).toBe(202);
  });

  it('isolates teardown across 3 instances — a middle failure does not strand the others', async () => {
    const instances = ['inst-a', 'inst-b', 'inst-c'].map((instanceId) => ({
      ...ACTIVE_STATE,
      instanceId,
    }));
    const stopModel = vi.fn((_modelName: string, instanceId: string) => {
      if (instanceId === 'inst-b') return Promise.reject(new Error('inst-b runner gone'));
      return Promise.resolve();
    });
    const removeInstance = vi.fn(() => Promise.resolve());
    const { app, logInfo, logError } = buildApp({
      getInstancesForModel: vi.fn(() => Promise.resolve(instances)),
      stopModel,
      removeInstance,
    });

    const res = await app.inject({ method: 'POST', url: '/api/v1/models/m1/stop' });
    expect(res.statusCode).toBe(202);

    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(stopModel).toHaveBeenCalledWith('m1', 'inst-a', expect.anything());
    expect(stopModel).toHaveBeenCalledWith('m1', 'inst-b', expect.anything());
    expect(stopModel).toHaveBeenCalledWith('m1', 'inst-c', expect.anything());
    expect(removeInstance).toHaveBeenCalledWith('m1', 'inst-a');
    expect(removeInstance).not.toHaveBeenCalledWith('m1', 'inst-b');
    expect(removeInstance).toHaveBeenCalledWith('m1', 'inst-c');
    expect(logError).toHaveBeenCalledWith(
      { modelName: 'm1', failures: 1, total: 3 },
      'Some instances failed teardown during model stop',
    );
    expect(logInfo).not.toHaveBeenCalledWith(
      { modelName: 'm1', count: 3 },
      'Model instances stopped',
    );
  });
});

describe('POST /api/v1/models/:modelName/start', () => {
  const STOPPED_RECORD = {
    name: 'm1',
    runnerType: 'vllm',
    modelPath: '/weights/m1',
    requiredMemory: 8e9,
    deviceType: 'CUDA',
    tensorParallel: 1,
    engineConfig: null,
    runtimeModule: 'vllm-0.21',
    pinned: false,
  };

  it('deploys from the stored record', async () => {
    const deployModel = vi.fn(() => Promise.resolve());
    const { app } = buildDeployApp({
      getInstancesForModel: vi.fn(() => Promise.resolve([])),
      findByName: vi.fn(() => Promise.resolve(STOPPED_RECORD)),
      place: vi.fn(() => ({ workerId: 'w1', devices: [{ deviceIndex: 0, deviceType: 'CUDA' }] })),
      deployModel,
    });

    const res = await app.inject({ method: 'POST', url: '/api/v1/models/m1/start' });

    expect(res.statusCode).toBe(202);
    expect(res.json<{ state: string; previousState: string; instanceId: string }>()).toMatchObject(
      {
        modelName: 'm1',
        state: ModelLifecycleState.STARTING,
        previousState: ModelLifecycleState.STOPPED,
        instanceId: expect.stringMatching(/^inst-/) as string,
      },
    );

    await new Promise((resolve) => setImmediate(resolve));

    // Params come from the stored record, not a request body — start takes no body.
    expect(deployModel).toHaveBeenCalledWith(
      expect.objectContaining({
        modelName: 'm1',
        instanceId: expect.stringMatching(/^inst-/) as string,
        modelPath: '/weights/m1',
        requiredMemory: 8e9,
        runtimeModule: 'vllm-0.21',
      }),
    );
  });

  it('returns 409 when the model already has an instance', async () => {
    const deployModel = vi.fn(() => Promise.resolve());
    const { app } = buildDeployApp({
      getInstancesForModel: vi.fn(() => Promise.resolve([ACTIVE_STATE])),
      findByName: vi.fn(() => Promise.resolve(STOPPED_RECORD)),
      deployModel,
    });

    const res = await app.inject({ method: 'POST', url: '/api/v1/models/m1/start' });

    expect(res.statusCode).toBe(409);
    expect(res.json<{ code: string }>().code).toBe('INVALID_STATE');
    expect(deployModel).not.toHaveBeenCalled();
  });

  it('returns 404 when no record exists', async () => {
    const { app } = buildDeployApp({
      getInstancesForModel: vi.fn(() => Promise.resolve([])),
      findByName: vi.fn(() => Promise.resolve(null)),
    });

    const res = await app.inject({ method: 'POST', url: '/api/v1/models/m1/start' });

    expect(res.statusCode).toBe(404);
    expect(res.json<{ code: string }>().code).toBe('MODEL_NOT_FOUND');
  });

  it('rejects Start when the stored modelPath escapes the weights directory', async () => {
    const { app } = buildDeployApp({
      getInstancesForModel: vi.fn(() => Promise.resolve([])),
      findByName: vi.fn(() =>
        Promise.resolve({ ...STOPPED_RECORD, modelPath: '/etc/passwd' }),
      ),
    });

    const res = await app.inject({ method: 'POST', url: '/api/v1/models/m1/start' });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ code: string }>().code).toBe('INVALID_REQUEST');
  });

  it('reclaims capacity via eviction when no worker has room', async () => {
    const victim = {
      instanceId: 'inst-old',
      modelName: 'old-model',
      state: ModelLifecycleState.ACTIVE,
      workerId: 'w1',
      memoryBytes: 8e9,
      lastInferenceAt: null,
      pinned: false,
    };
    const { app } = buildDeployApp({
      getInstancesForModel: vi.fn(() => Promise.resolve([])),
      findByName: vi.fn(() => Promise.resolve(STOPPED_RECORD)),
      place: vi.fn(() => null),
      selectVictims: vi.fn(() => [victim]),
    });

    const res = await app.inject({ method: 'POST', url: '/api/v1/models/m1/start' });

    expect(res.statusCode).toBe(202);
    expect(res.json<{ state: string }>()).toMatchObject({
      modelName: 'm1',
      state: ModelLifecycleState.PENDING,
    });
  });
});

describe('modelName glob rejection (security M1: SCAN-glob boundary validation)', () => {
  it('DELETE /api/v1/models/* is rejected with 400 and nothing is deleted', async () => {
    const removeInstance = vi.fn(() => Promise.resolve());
    const deleteModel = vi.fn(() => Promise.resolve());
    const { app } = buildApp({ removeInstance, deleteModel });

    const res = await app.inject({ method: 'DELETE', url: '/api/v1/models/*' });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ code: string }>().code).toBe('INVALID_REQUEST');
    await new Promise((resolve) => setImmediate(resolve));
    expect(removeInstance).not.toHaveBeenCalled();
    expect(deleteModel).not.toHaveBeenCalled();
  });

  it.each<['GET' | 'POST' | 'DELETE', string]>([
    ['GET', '/api/v1/models/*'],
    ['POST', '/api/v1/models/*/sleep'],
    ['POST', '/api/v1/models/*/wake'],
    ['POST', '/api/v1/models/*/stop'],
    ['POST', '/api/v1/models/*/start'],
    ['POST', '/api/v1/models/*/instances'],
    ['DELETE', '/api/v1/models/*/instances/inst-x'],
    ['POST', '/api/v1/models/*/instances/inst-x/sleep'],
    ['POST', '/api/v1/models/*/instances/inst-x/wake'],
  ])('%s %s is rejected with 400 before touching Redis/DB', async (method, url) => {
    const { app } = buildApp();

    const res = await app.inject({ method, url });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ code: string }>().code).toBe('INVALID_REQUEST');
  });
});

describe('instance-scoped op dedup (quality L4 / security L2)', () => {
  it('rejects a concurrent second DELETE on the same instance', async () => {
    const { app } = buildApp();

    const [first, second] = await Promise.all([
      app.inject({ method: 'DELETE', url: `/api/v1/models/m1/instances/${INSTANCE_ID}` }),
      app.inject({ method: 'DELETE', url: `/api/v1/models/m1/instances/${INSTANCE_ID}` }),
    ]);

    const statusCodes = [first.statusCode, second.statusCode].sort((a, b) => a - b);
    expect(statusCodes).toEqual([202, 409]);
  });

  it('releases the claim after background teardown so a retry succeeds', async () => {
    const { app } = buildApp();

    const first = await app.inject({
      method: 'DELETE',
      url: `/api/v1/models/m1/instances/${INSTANCE_ID}`,
    });
    expect(first.statusCode).toBe(202);

    await new Promise((resolve) => setImmediate(resolve));

    const retry = await app.inject({
      method: 'DELETE',
      url: `/api/v1/models/m1/instances/${INSTANCE_ID}`,
    });
    expect(retry.statusCode).toBe(202);
  });

  it('rejects a concurrent second sleep on the same instance', async () => {
    const { app } = buildApp();

    const [first, second] = await Promise.all([
      app.inject({ method: 'POST', url: `/api/v1/models/m1/instances/${INSTANCE_ID}/sleep` }),
      app.inject({ method: 'POST', url: `/api/v1/models/m1/instances/${INSTANCE_ID}/sleep` }),
    ]);

    const statusCodes = [first.statusCode, second.statusCode].sort((a, b) => a - b);
    expect(statusCodes).toEqual([202, 409]);
  });

  it('rejects a concurrent second wake on the same instance', async () => {
    const sleepingState = { ...ACTIVE_STATE, state: ModelLifecycleState.SLEEPING };
    const { app } = buildApp({
      getInstance: vi.fn(() => Promise.resolve(sleepingState)),
      getInstancesForModel: vi.fn(() => Promise.resolve([sleepingState])),
    });

    const [first, second] = await Promise.all([
      app.inject({ method: 'POST', url: `/api/v1/models/m1/instances/${INSTANCE_ID}/wake` }),
      app.inject({ method: 'POST', url: `/api/v1/models/m1/instances/${INSTANCE_ID}/wake` }),
    ]);

    const statusCodes = [first.statusCode, second.statusCode].sort((a, b) => a - b);
    expect(statusCodes).toEqual([202, 409]);
  });

  it('releases the sleep claim when transition throws after the claim so a retry succeeds', async () => {
    const transition = vi.fn<() => Promise<void>>(() =>
      Promise.reject(new Error('INVALID_TRANSITION')),
    );
    const { app } = buildApp({ transition });

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/models/m1/instances/${INSTANCE_ID}/sleep`,
    });
    expect(res.statusCode).toBe(500);

    transition.mockImplementationOnce(() => Promise.resolve());
    const retry = await app.inject({
      method: 'POST',
      url: `/api/v1/models/m1/instances/${INSTANCE_ID}/sleep`,
    });
    expect(retry.statusCode).toBe(202);
  });

  it('releases the wake claim when transition throws after the claim so a retry succeeds', async () => {
    const sleepingState = { ...ACTIVE_STATE, state: ModelLifecycleState.SLEEPING };
    const transition = vi.fn<() => Promise<void>>(() =>
      Promise.reject(new Error('INVALID_TRANSITION')),
    );
    const { app } = buildApp({
      getInstance: vi.fn(() => Promise.resolve(sleepingState)),
      getInstancesForModel: vi.fn(() => Promise.resolve([sleepingState])),
      transition,
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/models/m1/instances/${INSTANCE_ID}/wake`,
    });
    expect(res.statusCode).toBe(500);

    transition.mockImplementationOnce(() => Promise.resolve());
    const retry = await app.inject({
      method: 'POST',
      url: `/api/v1/models/m1/instances/${INSTANCE_ID}/wake`,
    });
    expect(retry.statusCode).toBe(202);
  });
});
