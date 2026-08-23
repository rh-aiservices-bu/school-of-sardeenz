// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { ModelLifecycleState } from '@sardeenz/types';
import { registerModelRoutes } from '../models.js';
import type { RouteDeps } from '../deps.js';
import type { ModelState } from '../../services/model-lifecycle.js';

const ACTIVE_STATE: ModelState = {
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
  removeModel?: ReturnType<typeof vi.fn>;
  deleteModel?: ReturnType<typeof vi.fn>;
  findByName?: ReturnType<typeof vi.fn>;
  getState?: ReturnType<typeof vi.fn>;
}

function buildApp(over: Overrides = {}): {
  app: FastifyInstance;
  logInfo: ReturnType<typeof vi.fn>;
  logError: ReturnType<typeof vi.fn>;
} {
  const logInfo = vi.fn();
  const logError = vi.fn();

  const deps = {
    leaderElection: { isLeader: true },
    lifecycle: {
      getState: over.getState ?? vi.fn(() => Promise.resolve(ACTIVE_STATE)),
      removeModel: over.removeModel ?? vi.fn(() => Promise.resolve()),
    },
    sleepWake: {
      stopModel: over.stopModel ?? vi.fn(() => Promise.resolve()),
    },
    modelRepository: {
      delete: over.deleteModel ?? vi.fn(() => Promise.resolve()),
      findByName: over.findByName ?? vi.fn(() => Promise.resolve({ name: 'm1' })),
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
  createModel?: ReturnType<typeof vi.fn>;
  transition?: ReturnType<typeof vi.fn>;
  getAllStates?: ReturnType<typeof vi.fn>;
  getState?: ReturnType<typeof vi.fn>;
  removeModel?: ReturnType<typeof vi.fn>;
  stopModel?: ReturnType<typeof vi.fn>;
  refreshAll?: ReturnType<typeof vi.fn>;
  deployModel?: ReturnType<typeof vi.fn>;
  findAll?: ReturnType<typeof vi.fn>;
  findByName?: ReturnType<typeof vi.fn>;
  createModelRecord?: ReturnType<typeof vi.fn>;
  setModelState?: ReturnType<typeof vi.fn>;
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
    lifecycle: {
      createModel: over.createModel ?? vi.fn(() => Promise.resolve()),
      getAllStates: over.getAllStates ?? vi.fn(() => Promise.resolve([])),
      getLastInferenceTimestamps: vi.fn(() => Promise.resolve(new Map())),
      getState: over.getState ?? vi.fn(() => Promise.resolve(null)),
      transition: over.transition ?? vi.fn(() => Promise.resolve()),
      removeModel: over.removeModel ?? vi.fn(() => Promise.resolve()),
    },
    workerPool: { getAllWorkers: vi.fn(() => []) },
    memoryBudget: {
      getAllBudgets: vi.fn(() => []),
      reserveCapacity: vi.fn(),
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
    expect(res.json<{ state: string; message: string }>()).toMatchObject({
      modelName: 'm1',
      state: ModelLifecycleState.PENDING,
      message: 'Capacity reclamation in progress',
    });

    const placement = deps.placement as { eligibleWorkerIds: ReturnType<typeof vi.fn> };
    expect(placement.eligibleWorkerIds).toHaveBeenCalledOnce();
  });

  it('transitions to ERROR and notifies when background reclamation fails', async () => {
    const victim = {
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
    const routingMap = deps.routingMap as { setModelState: ReturnType<typeof vi.fn> };
    const notifications = deps.notifications as { createNotification: ReturnType<typeof vi.fn> };

    expect(lifecycle.transition).toHaveBeenCalledWith(
      'm1',
      ModelLifecycleState.ERROR,
      expect.objectContaining({ errorMessage: expect.any(String) as string }),
    );
    expect(routingMap.setModelState).toHaveBeenCalledWith('m1', 'ERROR');
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

  it('background delete survives lifecycle.removeModel rejection', async () => {
    const { app: a, logError: err } = buildApp({
      removeModel: vi.fn(() => Promise.reject(new Error('lifecycle failure'))),
    });

    const res = await a.inject({ method: 'DELETE', url: '/api/v1/models/m1' });
    expect(res.statusCode).toBe(202);

    await new Promise((resolve) => setImmediate(resolve));

    expect(err).toHaveBeenCalledWith(
      { err: expect.any(Error) as Error, modelName: 'm1' },
      'Background model deletion failed',
    );
  });
});

describe('DELETE /api/v1/models/:modelName tombstone and state guards', () => {
  it('returns 202 and removes DB row for evicted model (no Redis state)', async () => {
    const deleteModel = vi.fn(() => Promise.resolve());
    const { app } = buildApp({
      getState: vi.fn(() => Promise.resolve(null)),
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

  it('returns 404 when model has neither Redis state nor DB record', async () => {
    const { app } = buildApp({
      getState: vi.fn(() => Promise.resolve(null)),
      findByName: vi.fn(() => Promise.resolve(null)),
    });

    const res = await app.inject({ method: 'DELETE', url: '/api/v1/models/m1' });

    expect(res.statusCode).toBe(404);
    expect(res.json<{ code: string }>().code).toBe('MODEL_NOT_FOUND');
  });

  it('allows delete when model is in STOPPED state', async () => {
    const { app } = buildApp({
      getState: vi.fn(() =>
        Promise.resolve({ ...ACTIVE_STATE, state: ModelLifecycleState.STOPPED }),
      ),
    });

    const res = await app.inject({ method: 'DELETE', url: '/api/v1/models/m1' });

    expect(res.statusCode).toBe(202);
  });

  it('returns 409 when model is in STOPPING state', async () => {
    const { app } = buildApp({
      getState: vi.fn(() =>
        Promise.resolve({ ...ACTIVE_STATE, state: ModelLifecycleState.STOPPING }),
      ),
    });

    const res = await app.inject({ method: 'DELETE', url: '/api/v1/models/m1' });

    expect(res.statusCode).toBe(409);
    expect(res.json<{ code: string }>().code).toBe('INVALID_STATE');
  });
});

describe('POST /api/v1/models/:modelName/stop', () => {
  it('stop on an ACTIVE model returns 202 and keeps the record', async () => {
    const deleteModel = vi.fn(() => Promise.resolve());
    const removeModel = vi.fn(() => Promise.resolve());
    const stopModel = vi.fn(() => Promise.resolve());
    const { app } = buildApp({ deleteModel, removeModel, stopModel });

    const res = await app.inject({ method: 'POST', url: '/api/v1/models/m1/stop' });

    expect(res.statusCode).toBe(202);
    expect(res.json<{ state: string; previousState: string }>()).toMatchObject({
      modelName: 'm1',
      state: ModelLifecycleState.STOPPING,
      previousState: ModelLifecycleState.ACTIVE,
    });

    await new Promise((resolve) => setImmediate(resolve));

    expect(stopModel).toHaveBeenCalledWith('m1', expect.anything());
    expect(removeModel).toHaveBeenCalledWith('m1');
    expect(deleteModel).not.toHaveBeenCalled();
  });

  it('returns 404 when the model has no runtime state', async () => {
    const { app } = buildApp({ getState: vi.fn(() => Promise.resolve(null)) });

    const res = await app.inject({ method: 'POST', url: '/api/v1/models/m1/stop' });

    expect(res.statusCode).toBe(404);
    expect(res.json<{ code: string }>().code).toBe('MODEL_NOT_FOUND');
  });

  it.each([
    ModelLifecycleState.PENDING,
    ModelLifecycleState.STARTING,
    ModelLifecycleState.DRAINING,
    ModelLifecycleState.STOPPING,
  ])('returns 409 when the model is %s (transient state)', async (state) => {
    const { app } = buildApp({
      getState: vi.fn(() => Promise.resolve({ ...ACTIVE_STATE, state })),
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

  it('survives a background stopModel rejection', async () => {
    const { app, logError } = buildApp({
      stopModel: vi.fn(() => Promise.reject(new Error('runner gone'))),
    });

    const res = await app.inject({ method: 'POST', url: '/api/v1/models/m1/stop' });
    expect(res.statusCode).toBe(202);

    await new Promise((resolve) => setImmediate(resolve));

    expect(logError).toHaveBeenCalledWith(
      { err: expect.any(Error) as Error, modelName: 'm1' },
      'Background model stop failed',
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
      getState: vi.fn(() => Promise.resolve(null)),
      findByName: vi.fn(() => Promise.resolve(STOPPED_RECORD)),
      place: vi.fn(() => ({ workerId: 'w1', devices: [{ deviceIndex: 0, deviceType: 'CUDA' }] })),
      deployModel,
    });

    const res = await app.inject({ method: 'POST', url: '/api/v1/models/m1/start' });

    expect(res.statusCode).toBe(202);
    expect(res.json<{ state: string; previousState: string }>()).toMatchObject({
      modelName: 'm1',
      state: ModelLifecycleState.STARTING,
      previousState: ModelLifecycleState.STOPPED,
    });

    await new Promise((resolve) => setImmediate(resolve));

    // Params come from the stored record, not a request body — start takes no body.
    expect(deployModel).toHaveBeenCalledWith(
      expect.objectContaining({
        modelName: 'm1',
        modelPath: '/weights/m1',
        requiredMemory: 8e9,
        runtimeModule: 'vllm-0.21',
      }),
    );
  });

  it('returns 409 when the model already has runtime state', async () => {
    const deployModel = vi.fn(() => Promise.resolve());
    const { app } = buildDeployApp({
      getState: vi.fn(() => Promise.resolve(ACTIVE_STATE)),
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
      getState: vi.fn(() => Promise.resolve(null)),
      findByName: vi.fn(() => Promise.resolve(null)),
    });

    const res = await app.inject({ method: 'POST', url: '/api/v1/models/m1/start' });

    expect(res.statusCode).toBe(404);
    expect(res.json<{ code: string }>().code).toBe('MODEL_NOT_FOUND');
  });

  it('rejects Start when the stored modelPath escapes the weights directory', async () => {
    const { app } = buildDeployApp({
      getState: vi.fn(() => Promise.resolve(null)),
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
      modelName: 'old-model',
      state: ModelLifecycleState.ACTIVE,
      workerId: 'w1',
      memoryBytes: 8e9,
      lastInferenceAt: null,
      pinned: false,
    };
    const { app } = buildDeployApp({
      getState: vi.fn(() => Promise.resolve(null)),
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
