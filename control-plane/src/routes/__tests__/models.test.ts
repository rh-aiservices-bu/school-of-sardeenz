// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { ModelLifecycleState, Protocol } from '@sardeenz/types';
import { registerModelRoutes } from '../models.js';
import type { RouteDeps } from '../deps.js';
import type { InstanceState, MoveOperation } from '../../services/model-lifecycle.js';
import { WorkerHttpError } from '../../clients/worker.js';

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

const DURABLE_MOVE: MoveOperation = {
  operationId: 'move-existing',
  modelName: 'm1',
  sourceInstanceId: INSTANCE_ID,
  replacementInstanceId: 'inst-replacement',
  targetWorkerId: 'worker-2',
  targetDeviceIndices: [1],
  phase: 'REPLACEMENT_STARTING',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

interface Overrides {
  stopModel?: ReturnType<typeof vi.fn>;
  sleepModel?: ReturnType<typeof vi.fn>;
  wakeModel?: ReturnType<typeof vi.fn>;
  removeInstance?: ReturnType<typeof vi.fn>;
  deleteModel?: ReturnType<typeof vi.fn>;
  updateModel?: ReturnType<typeof vi.fn>;
  deleteInstance?: ReturnType<typeof vi.fn>;
  findByName?: ReturnType<typeof vi.fn>;
  getInstance?: ReturnType<typeof vi.fn>;
  getInstancesForModel?: ReturnType<typeof vi.fn>;
  transition?: ReturnType<typeof vi.fn>;
  getWorker?: ReturnType<typeof vi.fn>;
  stopRunner?: ReturnType<typeof vi.fn>;
  getMoveOperation?: ReturnType<typeof vi.fn>;
  removeModel?: ReturnType<typeof vi.fn>;
  releaseInstanceReservations?: ReturnType<typeof vi.fn>;
}

function buildApp(over: Overrides = {}): {
  app: FastifyInstance;
  logInfo: ReturnType<typeof vi.fn>;
  logError: ReturnType<typeof vi.fn>;
  logWarn: ReturnType<typeof vi.fn>;
  stopRunner: ReturnType<typeof vi.fn>;
  createWorkerClient: ReturnType<typeof vi.fn>;
} {
  const logInfo = vi.fn();
  const logError = vi.fn();
  const logWarn = vi.fn();

  const getInstance = over.getInstance ?? vi.fn(() => Promise.resolve(ACTIVE_STATE));
  const getInstancesForModel =
    over.getInstancesForModel ??
    vi.fn(async () => {
      const state = (await getInstance()) as InstanceState | null;
      return state ? [state] : [];
    });

  // #157: teardownInstance now reaps the runner process via workerPool.getWorker +
  // createWorkerClient(...).stopRunner(). Default mirrors ACTIVE_STATE (workerId 'worker-1',
  // runnerId 'runner-1') so every pre-existing teardown test still exercises (and succeeds
  // through) the new reap step without having to opt in.
  const stopRunner = over.stopRunner ?? vi.fn(() => Promise.resolve());
  const createWorkerClient = vi.fn(() => ({ stopRunner }));

  const deps = {
    config: { weightsDir: '/weights' },
    leaderElection: { isLeader: true },
    lifecycle: {
      getInstance,
      getInstancesForModel,
      getAllInstances: vi.fn(() => Promise.resolve([])),
      removeInstance: over.removeInstance ?? vi.fn(() => Promise.resolve()),
      transition: over.transition ?? vi.fn(() => Promise.resolve()),
      getMoveOperation: over.getMoveOperation ?? vi.fn(() => Promise.resolve(null)),
    },
    sleepWake: {
      stopModel: over.stopModel ?? vi.fn(() => Promise.resolve()),
      sleepModel: over.sleepModel ?? vi.fn(() => Promise.resolve()),
      wakeModel: over.wakeModel ?? vi.fn(() => Promise.resolve()),
    },
    routingMap: {
      setModelState: vi.fn(() => Promise.resolve()),
      removeModel: over.removeModel ?? vi.fn(() => Promise.resolve()),
    },
    modelRepository: {
      delete: over.deleteModel ?? vi.fn(() => Promise.resolve()),
      update: over.updateModel ?? vi.fn(() => Promise.resolve({ name: 'm1' })),
      findByName: over.findByName ?? vi.fn(() => Promise.resolve({ name: 'm1' })),
    },
    instanceRepository: {
      delete: over.deleteInstance ?? vi.fn(() => Promise.resolve(true)),
    },
    notifications: {
      createNotification: vi.fn(() => Promise.resolve()),
    },
    workerPool: {
      getWorker:
        over.getWorker ??
        vi.fn(() => ({ workerId: 'worker-1', managementUrl: 'http://worker-1:9000' })),
    },
    createRunnerClient: vi.fn(() => ({})),
    createWorkerClient,
    memoryBudget: {
      releaseInstanceReservations: over.releaseInstanceReservations ?? vi.fn(() => undefined),
    },
  } as unknown as RouteDeps;

  const app = Fastify({ logger: false });
  app.log.info = logInfo;
  app.log.error = logError;
  app.log.warn = logWarn;
  app.setErrorHandler(
    (
      error: Error & { statusCode?: number; code?: string; details?: Record<string, unknown> },
      _req,
      reply,
    ) => {
      return reply
        .code(error.statusCode ?? 500)
        .send({ error: error.message, code: error.code, details: error.details });
    },
  );
  registerModelRoutes(app, deps);
  return { app, logInfo, logError, logWarn, stopRunner, createWorkerClient };
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
  sleepModel?: ReturnType<typeof vi.fn>;
  refreshAll?: ReturnType<typeof vi.fn>;
  deployModel?: ReturnType<typeof vi.fn>;
  findAll?: ReturnType<typeof vi.fn>;
  findByName?: ReturnType<typeof vi.fn>;
  createModelRecord?: ReturnType<typeof vi.fn>;
  setModelState?: ReturnType<typeof vi.fn>;
  createInstanceRecord?: ReturnType<typeof vi.fn>;
  resolveRunnerMetadata?: ReturnType<typeof vi.fn>;
  getMeasuredByInstance?: ReturnType<typeof vi.fn>;
  placeFixed?: ReturnType<typeof vi.fn>;
  getInstance?: ReturnType<typeof vi.fn>;
  getWorker?: ReturnType<typeof vi.fn>;
  updateEndpointWeight?: ReturnType<typeof vi.fn>;
  createMoveOperation?: ReturnType<typeof vi.fn>;
  getMoveOperation?: ReturnType<typeof vi.fn>;
  updateMoveOperation?: ReturnType<typeof vi.fn>;
  resumeMove?: ReturnType<typeof vi.fn>;
  getEntry?: ReturnType<typeof vi.fn>;
}

function buildDeployApp(over: DeployOverrides = {}): {
  app: FastifyInstance;
  deps: Record<string, unknown>;
  logError: ReturnType<typeof vi.fn>;
} {
  const logError = vi.fn();
  let currentMoveOperation: MoveOperation | null = null;
  const createMoveOperation = vi.fn((operation: MoveOperation) => {
    if (currentMoveOperation) return false;
    currentMoveOperation = operation;
    return true;
  });
  const getMoveOperation = vi.fn(() => Promise.resolve(currentMoveOperation));
  const updateMoveOperation = vi.fn(
    (_modelName: string, operationId: string, updates: Partial<MoveOperation>) => {
      if (currentMoveOperation?.operationId !== operationId) return Promise.resolve(null);
      currentMoveOperation = { ...currentMoveOperation, ...updates };
      return Promise.resolve(currentMoveOperation);
    },
  );
  const removeMoveOperation = vi.fn((_modelName: string, operationId: string) => {
    if (currentMoveOperation?.operationId !== operationId) return Promise.resolve(false);
    currentMoveOperation = null;
    return Promise.resolve(true);
  });

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
            engineArgs: (params.engineArgs as string[] | undefined) ?? null,
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
      getInstance: over.getInstance ?? vi.fn(() => Promise.resolve(null)),
      transition: over.transition ?? vi.fn(() => Promise.resolve()),
      removeInstance: over.removeInstance ?? vi.fn(() => Promise.resolve()),
      getMoveOperation: over.getMoveOperation ?? getMoveOperation,
      createMoveOperation: over.createMoveOperation ?? createMoveOperation,
      updateMoveOperation: over.updateMoveOperation ?? updateMoveOperation,
      removeMoveOperation,
    },
    workerPool: {
      getAllWorkers: vi.fn(() => []),
      getWorker: over.getWorker ?? vi.fn(() => null),
    },
    memoryBudget: {
      getAllBudgets: vi.fn(() => []),
      reserveCapacity: vi.fn(),
      releaseInstanceReservations: vi.fn(),
      refreshAll: over.refreshAll ?? vi.fn(() => Promise.resolve()),
      getMeasuredByInstance: over.getMeasuredByInstance ?? vi.fn(() => new Map()),
    },
    placement: {
      place: over.place ?? vi.fn(() => null),
      placeFixed: over.placeFixed ?? vi.fn(() => null),
      eligibleWorkerIds: over.eligibleWorkerIds ?? vi.fn(() => new Set(['w1'])),
    },
    eviction: {
      selectVictims: over.selectVictims ?? vi.fn(() => []),
      startTimer: vi.fn(() => vi.fn()),
      recordEviction: vi.fn(),
    },
    sleepWake: {
      stopModel: over.stopModel ?? vi.fn(() => Promise.resolve()),
      sleepModel: over.sleepModel ?? vi.fn(() => Promise.resolve()),
      wakeModel: vi.fn(() => Promise.resolve()),
    },
    deployOrchestration: {
      deployModel: over.deployModel ?? vi.fn(() => Promise.resolve()),
    },
    moveOrchestration: {
      resume: over.resumeMove ?? vi.fn(() => Promise.resolve()),
    },
    routingMap: {
      setModelState: over.setModelState ?? vi.fn(() => Promise.resolve()),
      removeModel: vi.fn(() => Promise.resolve()),
      updateEndpointWeight: over.updateEndpointWeight ?? vi.fn(() => Promise.resolve(true)),
      getEntry: over.getEntry ?? vi.fn(() => Promise.resolve(null)),
    },
    notifications: {
      createNotification: vi.fn(() => Promise.resolve()),
    },
    catalogService: {
      resolveRunnerMetadata:
        over.resolveRunnerMetadata ?? vi.fn(() => Promise.resolve({ protocol: Protocol.openai })),
    },
    createRunnerClient: vi.fn(() => ({})),
    createWorkerClient: vi.fn(() => ({ stopRunner: vi.fn(() => Promise.resolve()) })),
  } as unknown as RouteDeps;

  const app = Fastify({ logger: false });
  app.log.error = logError;
  app.setErrorHandler(
    (
      error: Error & { statusCode?: number; code?: string; details?: Record<string, unknown> },
      _req,
      reply,
    ) => {
      return reply
        .code(error.statusCode ?? 500)
        .send({ error: error.message, code: error.code, details: error.details });
    },
  );
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

describe('POST /api/v1/models/:modelName/instances/:instanceId/move', () => {
  it('persists a fixed-target replacement before returning 202', async () => {
    const source = { ...ACTIVE_STATE, deviceIndices: [0] };
    const createInstanceRecord = vi.fn(() => Promise.resolve({}));
    const { app, deps } = buildDeployApp({
      findByName: vi.fn(() =>
        Promise.resolve({
          name: 'm1',
          runnerType: 'vllm',
          modelPath: '/weights/m1',
          requiredMemory: 8e9,
          deviceType: null,
          tensorParallel: 1,
          engineConfig: null,
          engineArgs: null,
          runtimeModule: null,
          servedModelName: null,
          pinned: false,
        }),
      ),
      getInstance: vi.fn(() => Promise.resolve(source)),
      getWorker: vi.fn(() => ({
        workerId: 'worker-2',
        managementUrl: 'http://worker-2',
        devices: [{ deviceIndex: 1 }],
      })),
      placeFixed: vi.fn(() => ({
        workerId: 'worker-2',
        runnerType: 'vllm',
        devices: [{ deviceIndex: 1, deviceType: 'CUDA' }],
      })),
      createInstanceRecord,
    });
    (deps.workerPool as { getAllWorkers: ReturnType<typeof vi.fn> }).getAllWorkers.mockReturnValue([
      { workerId: 'worker-2', devices: [{ deviceIndex: 1 }], capabilities: [], status: 'ONLINE' },
    ]);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/models/m1/instances/${INSTANCE_ID}/move`,
      payload: { targetWorkerId: 'worker-2', targetDeviceIndices: [1] },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({
      modelName: 'm1',
      sourceInstanceId: INSTANCE_ID,
      replacementInstanceId: expect.stringMatching(/^inst-/) as string,
    });
    expect(createInstanceRecord).toHaveBeenCalledOnce();
    await app.close();
  });

  it('persists replacement cleanup and invokes the resumable executor when deployment fails', async () => {
    const source = { ...ACTIVE_STATE, deviceIndices: [0], runnerEnginePort: 8001 };
    const deployModel = vi.fn(() => Promise.reject(new Error('runner start failed')));
    const updateMoveOperation = vi.fn(() => Promise.resolve({}));
    const resumeMove = vi.fn(() => Promise.resolve());
    const { app, deps } = buildDeployApp({
      findByName: vi.fn(() =>
        Promise.resolve({
          name: 'm1',
          runnerType: 'vllm',
          modelPath: '/weights/m1',
          requiredMemory: 8e9,
          deviceType: null,
          tensorParallel: 1,
          engineConfig: null,
          engineArgs: null,
          runtimeModule: null,
          servedModelName: null,
          pinned: false,
        }),
      ),
      getInstance: vi.fn(() => Promise.resolve(source)),
      getWorker: vi.fn(() => ({
        workerId: 'worker-2',
        managementUrl: 'http://worker-2',
        devices: [{ deviceIndex: 1 }],
      })),
      placeFixed: vi.fn(() => ({
        workerId: 'worker-2',
        runnerType: 'vllm',
        devices: [{ deviceIndex: 1, deviceType: 'CUDA' }],
      })),
      deployModel,
      updateMoveOperation,
      resumeMove,
    });
    (deps.workerPool as { getAllWorkers: ReturnType<typeof vi.fn> }).getAllWorkers.mockReturnValue([
      { workerId: 'worker-2', devices: [{ deviceIndex: 1 }], capabilities: [], status: 'ONLINE' },
    ]);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/models/m1/instances/${INSTANCE_ID}/move`,
      payload: { targetWorkerId: 'worker-2', targetDeviceIndices: [1] },
    });
    expect(res.statusCode).toBe(202);
    await vi.waitFor(() =>
      expect(updateMoveOperation).toHaveBeenCalledWith(
        'm1',
        expect.any(String),
        expect.objectContaining({
          phase: 'REPLACEMENT_CLEANUP',
          errorMessage: 'runner start failed',
        }),
      ),
    );
    expect(resumeMove).toHaveBeenCalledWith('m1');
    await app.close();
  });

  it('does not dispatch a replacement after losing durable move ownership during placement', async () => {
    const source = { ...ACTIVE_STATE, deviceIndices: [0], runnerEnginePort: 8001 };
    const getMoveOperation = vi.fn(() => Promise.resolve(null));
    const deployModel = vi.fn(() => Promise.resolve());
    const removeInstance = vi.fn(() => Promise.resolve());
    const { app } = buildDeployApp({
      findByName: vi.fn(() =>
        Promise.resolve({
          name: 'm1',
          runnerType: 'vllm',
          modelPath: '/weights/m1',
          requiredMemory: 8e9,
          deviceType: null,
          tensorParallel: 1,
          engineConfig: null,
          engineArgs: null,
          runtimeModule: null,
          servedModelName: null,
          pinned: false,
        }),
      ),
      getInstance: vi.fn(() => Promise.resolve(source)),
      getWorker: vi.fn(() => ({
        workerId: 'worker-2',
        managementUrl: 'http://worker-2',
        devices: [{ deviceIndex: 1 }],
      })),
      placeFixed: vi.fn(() => ({
        workerId: 'worker-2',
        runnerType: 'vllm',
        devices: [{ deviceIndex: 1, deviceType: 'CUDA' }],
      })),
      getMoveOperation,
      createMoveOperation: vi.fn(() => Promise.resolve(true)),
      deployModel,
      removeInstance,
    });

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/models/m1/instances/${INSTANCE_ID}/move`,
      payload: { targetWorkerId: 'worker-2', targetDeviceIndices: [1] },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json<{ details: { reason: string } }>().details.reason).toBe(
      'move-ownership-lost',
    );
    expect(deployModel).not.toHaveBeenCalled();
    expect(removeInstance).toHaveBeenCalled();
    await app.close();
  });

  it('rejects move admission while any instance operation on the model is claimed', async () => {
    let finishSleep!: () => void;
    const sleepModel = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishSleep = resolve;
        }),
    );
    const source = { ...ACTIVE_STATE, deviceIndices: [0] };
    const { app } = buildDeployApp({
      findByName: vi.fn(() =>
        Promise.resolve({
          name: 'm1',
          runnerType: 'vllm',
          modelPath: '/weights/m1',
          requiredMemory: 8e9,
          deviceType: null,
          tensorParallel: 1,
          engineConfig: null,
          engineArgs: null,
          runtimeModule: null,
          servedModelName: null,
          pinned: false,
        }),
      ),
      getInstance: vi.fn(() => Promise.resolve(source)),
      sleepModel,
    });
    const sleep = await app.inject({
      method: 'POST',
      url: `/api/v1/models/m1/instances/${INSTANCE_ID}/sleep`,
    });
    expect(sleep.statusCode).toBe(202);
    const move = await app.inject({
      method: 'POST',
      url: `/api/v1/models/m1/instances/${INSTANCE_ID}/move`,
      payload: { targetWorkerId: 'worker-2', targetDeviceIndices: [1] },
    });
    expect(move.statusCode).toBe(409);
    expect(move.json<{ details: { reason: string } }>().details.reason).toBe(
      'operation-in-progress',
    );
    finishSleep();
    await app.close();
  });

  it('rejects move admission while a model-wide sleep is draining', async () => {
    let releaseSleep!: () => void;
    const source = { ...ACTIVE_STATE, deviceIndices: [0] };
    const sleepModel = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseSleep = resolve;
        }),
    );
    const { app } = buildDeployApp({
      findByName: vi.fn(() =>
        Promise.resolve({
          name: 'm1',
          runnerType: 'vllm',
          modelPath: '/weights/m1',
          requiredMemory: 8e9,
          deviceType: null,
          tensorParallel: 1,
          engineConfig: null,
          engineArgs: null,
          runtimeModule: null,
          servedModelName: null,
          pinned: false,
        }),
      ),
      getInstancesForModel: vi.fn(() => Promise.resolve([source])),
      getInstance: vi.fn(() => Promise.resolve(source)),
      sleepModel,
    });

    const sleeping = await app.inject({ method: 'POST', url: '/api/v1/models/m1/sleep' });
    expect(sleeping.statusCode).toBe(202);
    const move = await app.inject({
      method: 'POST',
      url: `/api/v1/models/m1/instances/${INSTANCE_ID}/move`,
      payload: { targetWorkerId: 'worker-2', targetDeviceIndices: [1] },
    });
    expect(move.statusCode).toBe(409);
    releaseSleep();
    await app.close();
  });

  it('rejects a move on a new leader when Redis already holds the transaction fence', async () => {
    const source = { ...ACTIVE_STATE, deviceIndices: [0] };
    const { app } = buildDeployApp({
      findByName: vi.fn(() => Promise.resolve({ name: 'm1' })),
      getInstance: vi.fn(() => Promise.resolve(source)),
      getMoveOperation: vi.fn(() => Promise.resolve(DURABLE_MOVE)),
    });

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/models/m1/instances/${INSTANCE_ID}/move`,
      payload: { targetWorkerId: 'worker-2', targetDeviceIndices: [1] },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json<{ details: { reason: string } }>().details.reason).toBe(
      'move-in-progress',
    );
    await app.close();
  });

  it('keeps move admission fenced through asynchronous capacity reclamation', async () => {
    let releaseVictim!: () => void;
    const victimStopped = new Promise<void>((resolve) => {
      releaseVictim = resolve;
    });
    const source = { ...ACTIVE_STATE, deviceIndices: [0], runnerEnginePort: 8001 };
    const victim = {
      instanceId: 'inst-victim',
      modelName: 'victim-model',
      state: ModelLifecycleState.ACTIVE,
      workerId: 'worker-1',
      runnerHost: 'localhost',
      runnerPort: 8100,
      runnerId: 'runner-victim',
      deviceIndices: [0],
      lastInferenceAt: null,
      stateChangedAt: '2026-01-01T00:00:00Z',
      errorMessage: null,
    };
    const record = {
      name: 'm1',
      runnerType: 'vllm',
      modelPath: '/weights/m1',
      requiredMemory: 8e9,
      deviceType: null,
      tensorParallel: 1,
      engineConfig: null,
      engineArgs: null,
      runtimeModule: null,
      servedModelName: null,
      pinned: false,
    };
    const deployModel = vi.fn(() => Promise.resolve());
    const { app } = buildDeployApp({
      findByName: vi.fn(() => Promise.resolve(record)),
      getInstance: vi.fn((_modelName: string, instanceId: string) =>
        Promise.resolve(instanceId === INSTANCE_ID ? source : victim),
      ),
      getAllInstances: vi.fn(() => Promise.resolve([victim])),
      place: vi
        .fn()
        .mockReturnValueOnce(null)
        .mockReturnValue({ workerId: 'worker-1', devices: [{ deviceIndex: 0 }] }),
      selectVictims: vi.fn(() => [victim]),
      stopModel: vi.fn((modelName: string) =>
        modelName === victim.modelName ? victimStopped : Promise.resolve(),
      ),
      deployModel,
    });

    const adding = await app.inject({ method: 'POST', url: '/api/v1/models/m1/instances' });
    expect(adding.statusCode).toBe(202);

    const moving = await app.inject({
      method: 'POST',
      url: `/api/v1/models/m1/instances/${INSTANCE_ID}/move`,
      payload: { targetWorkerId: 'worker-2', targetDeviceIndices: [1] },
    });
    expect(moving.statusCode).toBe(409);
    expect(moving.json<{ details: { reason: string } }>().details.reason).toBe(
      'operation-in-progress',
    );

    releaseVictim();
    await vi.waitFor(() => expect(deployModel).toHaveBeenCalledOnce());
    await app.close();
  });
});

describe('durable move fence blocks ordinary lifecycle mutations after leader handoff', () => {
  it.each([
    ['POST', '/api/v1/models/m1/stop'],
    ['DELETE', '/api/v1/models/m1'],
    ['POST', `/api/v1/models/m1/instances/${INSTANCE_ID}/sleep`],
  ] as const)('%s %s returns move-in-progress', async (method, url) => {
    const { app } = buildApp({
      getMoveOperation: vi.fn(() => Promise.resolve(DURABLE_MOVE)),
    });

    const response = await app.inject({ method, url });

    expect(response.statusCode).toBe(409);
    expect(response.json<{ details: { reason: string } }>().details.reason).toBe(
      'move-in-progress',
    );
    await app.close();
  });
});

describe('POST /api/v1/models refreshes memory budgets before placement (#163 staleness fix)', () => {
  it('calls memoryBudget.refreshAll() before placement.place() on the initial (non-eviction) path', async () => {
    const order: string[] = [];
    const refreshAll = vi.fn(() => {
      order.push('refreshAll');
      return Promise.resolve();
    });
    const place = vi.fn(() => {
      order.push('place');
      return { workerId: 'w1', devices: [{ deviceIndex: 0, deviceType: 'CUDA' }] };
    });
    const { app } = buildDeployApp({ refreshAll, place });

    const res = await app.inject({ method: 'POST', url: '/api/v1/models', payload: DEPLOY_BODY });

    expect(res.statusCode).toBe(202);
    expect(refreshAll).toHaveBeenCalledOnce();
    expect(place).toHaveBeenCalledOnce();
    expect(order).toEqual(['refreshAll', 'place']);
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

  it('rejects a slashed modelName for an oip-protocol runnerType (#125)', async () => {
    const createModelRecord = vi.fn((params: Record<string, unknown>) =>
      Promise.resolve({
        id: 'rec-1',
        name: params.name,
        runnerType: params.runnerType,
        modelPath: params.modelPath,
        requiredMemory: (params.requiredMemory as number | undefined) ?? null,
        deviceType: (params.deviceType as string | undefined) ?? null,
        tensorParallel: (params.tensorParallel as number | undefined) ?? 1,
        engineConfig: null,
        engineArgs: null,
        runtimeModule: null,
        pinned: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    );
    const { app, deps } = buildDeployApp({
      createModelRecord,
      resolveRunnerMetadata: vi.fn(() => Promise.resolve({ protocol: Protocol.oip })),
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/models',
      payload: { ...DEPLOY_BODY, modelName: 'org/model', runnerType: 'mlserver' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ code: string }>().code).toBe('INVALID_REQUEST');

    // The create-route rollback path: the Postgres row created for this attempt must not survive,
    // and the background deploy pipeline must never have been reached.
    const modelRepository = deps.modelRepository as { delete: ReturnType<typeof vi.fn> };
    expect(modelRepository.delete).toHaveBeenCalledWith('org/model');
    const deployOrchestration = deps.deployOrchestration as {
      deployModel: ReturnType<typeof vi.fn>;
    };
    expect(deployOrchestration.deployModel).not.toHaveBeenCalled();
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

    const memoryBudget = deps.memoryBudget as {
      releaseInstanceReservations: ReturnType<typeof vi.fn>;
    };
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

describe('PUT /api/v1/models/:modelName configuration update', () => {
  const payload = {
    runnerType: 'vllm',
    modelPath: '/weights/new-model',
    requiredMemory: 4_294_967_296,
    deviceType: 'CUDA',
    tensorParallel: 1,
    runtimeModule: 'vllm-0.21',
    engineArgs: ['--max-model-len=4096'],
    servedModelName: 'new-served-name',
    displayName: '  Updated model  ',
    pinned: true,
  };

  it('replaces a stopped configuration and trims the display name', async () => {
    const updateModel = vi.fn(() => Promise.resolve({ name: 'm1' }));
    const { app, logInfo } = buildApp({
      getInstance: vi.fn(() => Promise.resolve(null)),
      getInstancesForModel: vi.fn(() => Promise.resolve([])),
      updateModel,
    });

    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/models/m1',
      payload,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ state: string }>().state).toBe(ModelLifecycleState.STOPPED);
    expect(updateModel).toHaveBeenCalledWith(
      'm1',
      expect.objectContaining({
        modelPath: '/weights/new-model',
        displayName: 'Updated model',
        engineArgs: ['--max-model-len=4096'],
      }),
    );
    expect(logInfo).toHaveBeenCalledWith(
      { modelName: 'm1' },
      'Stopped model configuration updated',
    );
  });

  it('rejects modification while a runtime instance exists', async () => {
    const updateModel = vi.fn();
    const { app } = buildApp({ updateModel });

    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/models/m1',
      payload,
    });

    expect(res.statusCode).toBe(409);
    expect(res.json<{ code: string }>().code).toBe('INVALID_STATE');
    expect(updateModel).not.toHaveBeenCalled();
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
    const {
      app: a,
      logError: err,
      logInfo: info,
    } = buildApp({
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
    const {
      app: a,
      logError: err,
      logInfo: info,
    } = buildApp({
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
  it('force-deletes ambiguous bookkeeping without contacting the worker', async () => {
    const ambiguous = {
      ...ACTIVE_STATE,
      state: ModelLifecycleState.ERROR,
      runnerId: null,
      runnerStartAmbiguous: true,
    };
    const removeInstance = vi.fn(() => Promise.resolve());
    const removeModel = vi.fn(() => Promise.resolve());
    const deleteModel = vi.fn(() => Promise.resolve());
    const releaseInstanceReservations = vi.fn();
    const stopModel = vi.fn(() => Promise.resolve());
    const { app, stopRunner, logWarn } = buildApp({
      getInstance: vi.fn(() => Promise.resolve(ambiguous)),
      getInstancesForModel: vi.fn(() => Promise.resolve([ambiguous])),
      removeInstance,
      removeModel,
      deleteModel,
      releaseInstanceReservations,
      stopModel,
    });

    const res = await app.inject({ method: 'DELETE', url: '/api/v1/models/m1?force=true' });

    expect(res.statusCode).toBe(202);
    expect(removeInstance).toHaveBeenCalledWith('m1', INSTANCE_ID);
    expect(releaseInstanceReservations).toHaveBeenCalledWith(INSTANCE_ID);
    expect(removeModel).toHaveBeenCalledWith('m1');
    expect(deleteModel).toHaveBeenCalledWith('m1');
    expect(stopModel).not.toHaveBeenCalled();
    expect(stopRunner).not.toHaveBeenCalled();
    expect(logWarn).toHaveBeenCalledWith(
      { modelName: 'm1', instanceIds: [INSTANCE_ID] },
      'Model force-deleted without runner teardown',
    );
  });

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

  it.each([
    ModelLifecycleState.PENDING,
    ModelLifecycleState.STARTING,
    ModelLifecycleState.DRAINING,
    ModelLifecycleState.STOPPING,
  ])('returns 409 when an instance is in %s (transient state, #140)', async (state) => {
    const transient = { ...ACTIVE_STATE, state };
    const { app } = buildApp({
      getInstance: vi.fn(() => Promise.resolve(transient)),
      getInstancesForModel: vi.fn(() => Promise.resolve([transient])),
    });

    const res = await app.inject({ method: 'DELETE', url: '/api/v1/models/m1' });

    expect(res.statusCode).toBe(409);
    expect(res.json<{ code: string }>().code).toBe('INVALID_STATE');
  });

  it('returns 202 when an instance is in ERROR (delete is the escape hatch for wedged models, #140)', async () => {
    const errorState = { ...ACTIVE_STATE, state: ModelLifecycleState.ERROR };
    const { app } = buildApp({
      getInstance: vi.fn(() => Promise.resolve(errorState)),
      getInstancesForModel: vi.fn(() => Promise.resolve([errorState])),
    });

    const res = await app.inject({ method: 'DELETE', url: '/api/v1/models/m1' });

    expect(res.statusCode).toBe(202);
  });

  it('returns 409 when ANY instance is transient, even if the aggregate is settled (mixed ACTIVE + STARTING, #140)', async () => {
    const starting = {
      ...ACTIVE_STATE,
      instanceId: 'inst-000000000002',
      state: ModelLifecycleState.STARTING,
    };
    const { app } = buildApp({
      getInstance: vi.fn(() => Promise.resolve(ACTIVE_STATE)),
      getInstancesForModel: vi.fn(() => Promise.resolve([ACTIVE_STATE, starting])),
    });

    const res = await app.inject({ method: 'DELETE', url: '/api/v1/models/m1' });

    expect(res.statusCode).toBe(409);
    const body = res.json<{ code: string; error: string; details?: { currentState?: string } }>();
    expect(body.code).toBe('INVALID_STATE');
    // #174: the body must name the offending transient instance's state (STARTING), not the
    // settled aggregate (ACTIVE) that would misleadingly read as deletable.
    expect(body.error).toContain('STARTING');
    expect(body.error).not.toContain('ACTIVE');
    expect(body.error).toContain('inst-000000000002');
  });

  it('names the transient instance state and id in the 409 body, not the aggregate (#174)', async () => {
    const starting = {
      ...ACTIVE_STATE,
      instanceId: 'inst-000000000002',
      state: ModelLifecycleState.STARTING,
    };
    const { app } = buildApp({
      getInstance: vi.fn(() => Promise.resolve(ACTIVE_STATE)),
      getInstancesForModel: vi.fn(() => Promise.resolve([ACTIVE_STATE, starting])),
    });

    const res = await app.inject({ method: 'DELETE', url: '/api/v1/models/m1' });

    expect(res.statusCode).toBe(409);
    const body = res.json<{ details: { instanceId: string; currentState: string } }>();
    expect(body.details.instanceId).toBe('inst-000000000002');
    expect(body.details.currentState).toBe(ModelLifecycleState.STARTING);
  });

  it('rejects a concurrent second model DELETE while the first is still backgrounding (#140)', async () => {
    const { app } = buildApp();

    const [first, second] = await Promise.all([
      app.inject({ method: 'DELETE', url: '/api/v1/models/m1' }),
      app.inject({ method: 'DELETE', url: '/api/v1/models/m1' }),
    ]);

    const statusCodes = [first.statusCode, second.statusCode].sort((a, b) => a - b);
    expect(statusCodes).toEqual([202, 409]);

    const rejected = first.statusCode === 409 ? first : second;
    expect(rejected.json<{ code: string }>().code).toBe('INVALID_STATE');
  });

  it('releases the model-delete claim after background teardown so a retry is not claim-blocked (#140)', async () => {
    const { app } = buildApp();

    const first = await app.inject({ method: 'DELETE', url: '/api/v1/models/m1' });
    expect(first.statusCode).toBe(202);

    await new Promise((resolve) => setImmediate(resolve));

    // The default mocks do not mutate lifecycle state, so the instance is still ACTIVE
    // after the first delete and the retry takes the normal (claim-free) delete path —
    // the assertion is that the deletingInFlight claim was released by the background
    // teardown's finally, not that the model was tombstoned.
    const retry = await app.inject({ method: 'DELETE', url: '/api/v1/models/m1' });
    expect(retry.statusCode).toBe(202);
  });
});

describe('launch/stop/instance paths fenced against an in-flight model DELETE (#173)', () => {
  // A backgrounded model DELETE holds `deletingInFlight` until its teardown's finally runs. Hanging
  // stopModel keeps the teardown (and thus the claim) pending for the duration of the assertion.
  const hangingStop = () => new Promise<void>(() => {});

  it('POST /instances returns 409 (delete-in-progress) while a model DELETE is backgrounding', async () => {
    const { app } = buildApp({ stopModel: vi.fn(hangingStop) });

    const del = await app.inject({ method: 'DELETE', url: '/api/v1/models/m1' });
    expect(del.statusCode).toBe(202);

    const add = await app.inject({ method: 'POST', url: '/api/v1/models/m1/instances' });
    expect(add.statusCode).toBe(409);
    const body = add.json<{ code: string; details: { reason: string } }>();
    expect(body.code).toBe('INVALID_STATE');
    expect(body.details.reason).toBe('delete-in-progress');
  });

  it('POST /start returns 409 (delete-in-progress) while a model DELETE is backgrounding', async () => {
    // The delete snapshots the settled instance; start, landing after teardown cleared it, reads
    // zero instances (so it does not bail on "already has instances") but is caught by the
    // top-of-deployFromRecord delete fence.
    const settled = { ...ACTIVE_STATE };
    const getInstancesForModel = vi
      .fn()
      .mockResolvedValueOnce([settled]) // DELETE snapshot
      .mockResolvedValue([]); // START sees zero instances
    const { app } = buildApp({
      getInstancesForModel,
      getInstance: vi.fn(() => Promise.resolve(settled)),
      stopModel: vi.fn(hangingStop),
    });

    const del = await app.inject({ method: 'DELETE', url: '/api/v1/models/m1' });
    expect(del.statusCode).toBe(202);

    const start = await app.inject({ method: 'POST', url: '/api/v1/models/m1/start' });
    expect(start.statusCode).toBe(409);
    const body = start.json<{ code: string; details: { reason: string } }>();
    expect(body.code).toBe('INVALID_STATE');
    expect(body.details.reason).toBe('delete-in-progress');
  });

  it('DELETE returns 409 (stop-in-progress) while a Stop is claimed but not yet transitioned', async () => {
    const { app } = buildApp({ stopModel: vi.fn(hangingStop) });

    const stop = await app.inject({ method: 'POST', url: '/api/v1/models/m1/stop' });
    expect(stop.statusCode).toBe(202);

    const del = await app.inject({ method: 'DELETE', url: '/api/v1/models/m1' });
    expect(del.statusCode).toBe(409);
    const body = del.json<{ code: string; details: { reason: string } }>();
    expect(body.code).toBe('INVALID_STATE');
    expect(body.details.reason).toBe('stop-in-progress');
  });

  it('DELETE returns 409 (instance-operation-in-progress) while an instance sleep is claimed', async () => {
    const { app } = buildApp({ sleepModel: vi.fn(hangingStop) });

    const sleep = await app.inject({
      method: 'POST',
      url: `/api/v1/models/m1/instances/${INSTANCE_ID}/sleep`,
    });
    expect(sleep.statusCode).toBe(202);

    const del = await app.inject({ method: 'DELETE', url: '/api/v1/models/m1' });
    expect(del.statusCode).toBe(409);
    const body = del.json<{ code: string; details: { reason: string } }>();
    expect(body.code).toBe('INVALID_STATE');
    expect(body.details.reason).toBe('instance-operation-in-progress');
    expect(body.details).toMatchObject({ modelName: 'm1' });
    expect(del.json<{ error: string }>().error).toContain(INSTANCE_ID);
  });

  it('capacity-reclamation skips the deployModel dispatch when a delete claims the model mid-flight', async () => {
    // The deploy path fails direct placement (place → null), evicts a victim, then re-places
    // successfully. Between instanceRepository.create and the fire-and-forget dispatch, we land a
    // model DELETE (via createInstanceRecord) that claims deletingInFlight; the reclamation re-check
    // must then release the reservation, error the instance, and NOT dispatch.
    const settled = {
      ...ACTIVE_STATE,
      instanceId: 'inst-000000000009',
    };
    const victim = {
      instanceId: 'inst-old',
      modelName: 'old-model',
      state: ModelLifecycleState.ACTIVE,
      workerId: 'w1',
      memoryBytes: 8e9,
      lastInferenceAt: null,
      pinned: false,
    };

    // Holder so the createInstanceRecord closure (defined before buildDeployApp returns) can reach
    // the app once it exists, without a reassigned `let`.
    const appHolder: { app?: FastifyInstance } = {};
    let resolveErrored: () => void = () => {};
    const errored = new Promise<void>((r) => {
      resolveErrored = r;
    });

    // Only the DELETE's own instance ('m1') hangs, so the claim stays held past the re-check;
    // the victim ('old-model') tears down normally so reclamation can proceed to re-placement.
    const stopModel = vi.fn((modelName: string) =>
      modelName === 'm1' ? new Promise<void>(() => {}) : Promise.resolve(),
    );

    const createInstanceRecord = vi.fn(async () => {
      // Simulate a model DELETE arriving mid-reclamation, which claims deletingInFlight.
      await appHolder.app!.inject({ method: 'DELETE', url: '/api/v1/models/m1' });
      return {};
    });

    const transition = vi.fn((_m: string, _i: string, state: ModelLifecycleState) => {
      if (state === ModelLifecycleState.ERROR) resolveErrored();
      return Promise.resolve();
    });

    const deployModel = vi.fn(() => Promise.resolve());

    const { app, deps } = buildDeployApp({
      place: vi
        .fn()
        .mockReturnValueOnce(null) // direct placement fails → reclamation
        .mockReturnValue({ workerId: 'w1', devices: [{ deviceIndex: 0 }] }), // re-placement succeeds
      selectVictims: vi.fn(() => [victim]),
      createInstanceRecord,
      transition,
      deployModel,
      stopModel,
      findByName: vi.fn(() => Promise.resolve({ name: 'm1' })),
      getInstancesForModel: vi.fn(() => Promise.resolve([settled])),
    });
    appHolder.app = app;

    const res = await app.inject({ method: 'POST', url: '/api/v1/models', payload: DEPLOY_BODY });
    expect(res.statusCode).toBe(202);

    await errored;
    // Give any (erroneously) scheduled dispatch a tick to have fired.
    await new Promise((resolve) => setImmediate(resolve));

    expect(deployModel).not.toHaveBeenCalled();
    expect(transition).toHaveBeenCalledWith(
      'm1',
      expect.stringMatching(/^inst-/) as string,
      ModelLifecycleState.ERROR,
      expect.objectContaining({ errorMessage: expect.stringContaining('delete') as string }),
    );
    const budget = deps.memoryBudget as { releaseInstanceReservations: ReturnType<typeof vi.fn> };
    expect(budget.releaseInstanceReservations).toHaveBeenCalled();
  });

  it('direct placement refuses (409 delete-in-progress) and cleans up when a delete claims the model mid-flight', async () => {
    // Direct placement succeeds, but a model DELETE lands between instanceRepository.create and
    // the fire-and-forget dispatch (the same window as the reclamation case, minus the eviction).
    // The pre-dispatch re-check must throw: the caller gets 409, deployModel is never called, and
    // the Redis key / reservation / Postgres row created so far are all rolled back.
    const settled = { ...ACTIVE_STATE, instanceId: 'inst-000000000009' };
    const appHolder: { app?: FastifyInstance } = {};
    const stopModel = vi.fn(() => new Promise<void>(() => {}));
    const createInstanceRecord = vi.fn(async () => {
      await appHolder.app!.inject({ method: 'DELETE', url: '/api/v1/models/m1' });
      return {};
    });
    const deployModel = vi.fn(() => Promise.resolve());
    const removeInstance = vi.fn(() => Promise.resolve());

    const { app, deps } = buildDeployApp({
      place: vi.fn(() => ({ workerId: 'w1', devices: [{ deviceIndex: 0 }] })),
      createInstanceRecord,
      deployModel,
      stopModel,
      removeInstance,
      findByName: vi.fn(() => Promise.resolve({ name: 'm1' })),
      getInstancesForModel: vi.fn(() => Promise.resolve([settled])),
    });
    appHolder.app = app;

    const res = await app.inject({ method: 'POST', url: '/api/v1/models', payload: DEPLOY_BODY });
    expect(res.statusCode).toBe(409);
    const body = res.json<{ code: string; details: { reason: string } }>();
    expect(body.code).toBe('INVALID_STATE');
    expect(body.details.reason).toBe('delete-in-progress');

    await new Promise((resolve) => setImmediate(resolve));
    expect(deployModel).not.toHaveBeenCalled();
    expect(removeInstance).toHaveBeenCalledWith('m1', expect.stringMatching(/^inst-/) as string);
    const budget = deps.memoryBudget as { releaseInstanceReservations: ReturnType<typeof vi.fn> };
    expect(budget.releaseInstanceReservations).toHaveBeenCalled();
    const instanceRepo = deps.instanceRepository as { delete: ReturnType<typeof vi.fn> };
    expect(instanceRepo.delete).toHaveBeenCalled();
  });
});

describe('teardownInstance reaps the runner process (#157)', () => {
  it('retains lifecycle and SQL bookkeeping when a runner start reply was ambiguous', async () => {
    const ambiguous = {
      ...ACTIVE_STATE,
      state: ModelLifecycleState.ERROR,
      runnerStartAmbiguous: true,
    };
    const removeInstance = vi.fn(() => Promise.resolve());
    const deleteInstance = vi.fn(() => Promise.resolve(true));
    const stopModel = vi.fn(() => Promise.resolve());
    const { app } = buildApp({
      getInstance: vi.fn(() => Promise.resolve(ambiguous)),
      removeInstance,
      deleteInstance,
      stopModel,
    });

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/v1/models/m1/instances/${INSTANCE_ID}`,
    });
    expect(response.statusCode).toBe(202);
    await new Promise((resolve) => setImmediate(resolve));
    expect(stopModel).not.toHaveBeenCalled();
    expect(removeInstance).not.toHaveBeenCalled();
    expect(deleteInstance).not.toHaveBeenCalled();
    await app.close();
  });

  it('does not CASCADE a model row when one of its runner starts has an ambiguous reply', async () => {
    const ambiguous = {
      ...ACTIVE_STATE,
      state: ModelLifecycleState.ERROR,
      runnerStartAmbiguous: true,
    };
    const deleteModel = vi.fn(() => Promise.resolve());
    const { app } = buildApp({ getInstance: vi.fn(() => Promise.resolve(ambiguous)), deleteModel });

    const response = await app.inject({ method: 'DELETE', url: '/api/v1/models/m1' });
    expect(response.statusCode).toBe(202);
    await new Promise((resolve) => setImmediate(resolve));
    expect(deleteModel).not.toHaveBeenCalled();
    await app.close();
  });

  it('DELETE /api/v1/models/:modelName calls stopRunner with the instance runnerId, then still cleans up state', async () => {
    const removeInstance = vi.fn(() => Promise.resolve());
    const deleteInstance = vi.fn(() => Promise.resolve(true));
    const { app, stopRunner, createWorkerClient } = buildApp({ removeInstance, deleteInstance });

    const res = await app.inject({ method: 'DELETE', url: '/api/v1/models/m1' });
    expect(res.statusCode).toBe(202);

    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    // ACTIVE_STATE carries workerId 'worker-1' / runnerId 'runner-1' — resolved via
    // workerPool.getWorker('worker-1') to the worker's managementUrl, then stopRunner is called
    // with the instance's runnerId.
    expect(createWorkerClient).toHaveBeenCalledWith('http://worker-1:9000');
    expect(stopRunner).toHaveBeenCalledWith('runner-1');
    expect(removeInstance).toHaveBeenCalledWith('m1', INSTANCE_ID);
    expect(deleteInstance).toHaveBeenCalledWith(INSTANCE_ID);
  });

  it('POST /api/v1/models/:modelName/stop calls stopRunner with the instance runnerId (shared teardownInstance path)', async () => {
    const removeInstance = vi.fn(() => Promise.resolve());
    const { app, stopRunner } = buildApp({ removeInstance });

    const res = await app.inject({ method: 'POST', url: '/api/v1/models/m1/stop' });
    expect(res.statusCode).toBe(202);

    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(stopRunner).toHaveBeenCalledWith('runner-1');
    expect(removeInstance).toHaveBeenCalledWith('m1', INSTANCE_ID);
  });

  it('tolerates a 404 from stopRunner (runner already exited and reaped) — teardown still succeeds', async () => {
    const removeInstance = vi.fn(() => Promise.resolve());
    const stopRunner = vi.fn(() =>
      Promise.reject(
        new WorkerHttpError('Worker DELETE /runners/runner-1 returned 404: gone', 404),
      ),
    );
    const { app, logError } = buildApp({ removeInstance, stopRunner });

    const res = await app.inject({ method: 'DELETE', url: '/api/v1/models/m1' });
    expect(res.statusCode).toBe(202);

    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(stopRunner).toHaveBeenCalledWith('runner-1');
    // Not treated as a teardown failure — cleanup proceeds and nothing is logged as an error.
    expect(removeInstance).toHaveBeenCalledWith('m1', INSTANCE_ID);
    expect(logError).not.toHaveBeenCalled();
  });

  it('does NOT tolerate a plain Error whose message merely contains "returned 404" (round-3 review, Low 1: typed status check, not substring match)', async () => {
    const removeInstance = vi.fn(() => Promise.resolve());
    // A genuine failure (e.g. a 500 whose body happens to echo the string "returned 404") must
    // not be misclassified as the tolerated 404 case just because the message contains that text.
    const stopRunner = vi.fn(() =>
      Promise.reject(
        new Error('Worker DELETE /runners/runner-1 returned 500: body says returned 404'),
      ),
    );
    const { app, logError } = buildApp({ removeInstance, stopRunner });

    const res = await app.inject({ method: 'DELETE', url: '/api/v1/models/m1' });
    expect(res.statusCode).toBe(202);

    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(stopRunner).toHaveBeenCalledWith('runner-1');
    // Falls through to the ordinary failure contract — not the 404 tolerance path.
    expect(removeInstance).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledWith(
      { err: expect.any(Error) as Error, modelName: 'm1', instanceId: INSTANCE_ID },
      'Delete: instance teardown failed',
    );
  });

  it('propagates a non-404 stopRunner failure through the existing teardown-failure contract', async () => {
    const removeInstance = vi.fn(() => Promise.resolve());
    const stopRunner = vi.fn(() => Promise.reject(new Error('connect ECONNREFUSED')));
    const { app, logError } = buildApp({ removeInstance, stopRunner });

    const res = await app.inject({ method: 'DELETE', url: '/api/v1/models/m1' });
    expect(res.statusCode).toBe(202);

    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(stopRunner).toHaveBeenCalledWith('runner-1');
    // Same failure contract as any other teardown error: logged, Redis record retained. Not
    // stranded forever — ReconciliationService.reapOrphanedInstances best-effort re-attempts the
    // reap on a later tick before it eventually drops the orphaned record (round-3 review).
    expect(logError).toHaveBeenCalledWith(
      { err: expect.any(Error) as Error, modelName: 'm1', instanceId: INSTANCE_ID },
      'Delete: instance teardown failed',
    );
    expect(removeInstance).not.toHaveBeenCalled();
  });

  it('skips the reap step (and never constructs a worker client) when the instance state has no runnerId', async () => {
    const noRunner = { ...ACTIVE_STATE, runnerId: null };
    const removeInstance = vi.fn(() => Promise.resolve());
    const { app, stopRunner, createWorkerClient, logWarn } = buildApp({
      getInstance: vi.fn(() => Promise.resolve(noRunner)),
      getInstancesForModel: vi.fn(() => Promise.resolve([noRunner])),
      removeInstance,
    });

    const res = await app.inject({ method: 'DELETE', url: '/api/v1/models/m1' });
    expect(res.statusCode).toBe(202);

    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(stopRunner).not.toHaveBeenCalled();
    expect(createWorkerClient).not.toHaveBeenCalled();
    expect(removeInstance).toHaveBeenCalledWith('m1', INSTANCE_ID);
    expect(logWarn).toHaveBeenCalledWith(
      { modelName: 'm1', instanceId: INSTANCE_ID },
      expect.stringContaining('cannot reap runner process; no runnerId') as string,
    );
  });

  it('retains bookkeeping when the worker is not found in the pool', async () => {
    const removeInstance = vi.fn(() => Promise.resolve());
    const { app, stopRunner, logWarn } = buildApp({
      getWorker: vi.fn(() => null),
      removeInstance,
    });

    const res = await app.inject({ method: 'DELETE', url: '/api/v1/models/m1' });
    expect(res.statusCode).toBe(202);

    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(stopRunner).not.toHaveBeenCalled();
    expect(removeInstance).not.toHaveBeenCalled();
    expect(logWarn).toHaveBeenCalledWith(
      { modelName: 'm1', instanceId: INSTANCE_ID, workerId: 'worker-1' },
      expect.stringContaining('cannot reap runner process; worker unknown') as string,
    );
  });
});

describe('POST /api/v1/models/:modelName/stop', () => {
  it('force-stops an ambiguous ERROR instance without contacting the worker and keeps the record', async () => {
    const ambiguous = {
      ...ACTIVE_STATE,
      state: ModelLifecycleState.ERROR,
      runnerId: null,
      runnerStartAmbiguous: true,
    };
    const removeInstance = vi.fn(() => Promise.resolve());
    const deleteInstance = vi.fn(() => Promise.resolve(true));
    const deleteModel = vi.fn();
    const releaseInstanceReservations = vi.fn();
    const removeModel = vi.fn(() => Promise.resolve());
    const { app, stopRunner, logWarn } = buildApp({
      getInstance: vi.fn(() => Promise.resolve(ambiguous)),
      getInstancesForModel: vi.fn(() => Promise.resolve([ambiguous])),
      removeInstance,
      deleteInstance,
      deleteModel,
      releaseInstanceReservations,
      removeModel,
    });

    const res = await app.inject({ method: 'POST', url: '/api/v1/models/m1/stop?force=true' });

    expect(res.statusCode).toBe(202);
    expect(res.json<{ state: string }>().state).toBe(ModelLifecycleState.STOPPED);
    expect(removeInstance).toHaveBeenCalledWith('m1', INSTANCE_ID);
    expect(deleteInstance).toHaveBeenCalledWith(INSTANCE_ID);
    expect(releaseInstanceReservations).toHaveBeenCalledWith(INSTANCE_ID);
    expect(removeModel).toHaveBeenCalledWith('m1');
    expect(stopRunner).not.toHaveBeenCalled();
    expect(deleteModel).not.toHaveBeenCalled();
    expect(logWarn).toHaveBeenCalledWith(
      { modelName: 'm1', instanceIds: [INSTANCE_ID] },
      'Model force-stopped without runner teardown',
    );
  });

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
    engineArgs: null,
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
    expect(res.json<{ state: string; previousState: string; instanceId: string }>()).toMatchObject({
      modelName: 'm1',
      state: ModelLifecycleState.STARTING,
      previousState: ModelLifecycleState.STOPPED,
      instanceId: expect.stringMatching(/^inst-/) as string,
    });

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
      findByName: vi.fn(() => Promise.resolve({ ...STOPPED_RECORD, modelPath: '/etc/passwd' })),
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

describe('engineArgs (#126)', () => {
  it('POST /api/v1/models with engineArgs persists it and forwards it to deployOrchestration', async () => {
    const createModelRecord = vi.fn((params: Record<string, unknown>) =>
      Promise.resolve({
        id: 'rec-1',
        name: params.name,
        runnerType: params.runnerType,
        modelPath: params.modelPath,
        requiredMemory: (params.requiredMemory as number | undefined) ?? null,
        deviceType: (params.deviceType as string | undefined) ?? null,
        tensorParallel: (params.tensorParallel as number | undefined) ?? 1,
        engineConfig: (params.engineConfig as Record<string, unknown> | undefined) ?? null,
        engineArgs: (params.engineArgs as string[] | undefined) ?? null,
        runtimeModule: (params.runtimeModule as string | undefined) ?? null,
        pinned: (params.pinned as boolean | undefined) ?? false,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    );
    const deployModel = vi.fn(() => Promise.resolve());
    const { app } = buildDeployApp({
      createModelRecord,
      place: vi.fn(() => ({ workerId: 'w1', devices: [{ deviceIndex: 0, deviceType: 'CUDA' }] })),
      deployModel,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/models',
      payload: { ...DEPLOY_BODY, engineArgs: ['--max-model-len=8192'] },
    });

    expect(res.statusCode).toBe(202);
    expect(createModelRecord).toHaveBeenCalledWith(
      expect.objectContaining({ engineArgs: ['--max-model-len=8192'] }),
    );

    await new Promise((resolve) => setImmediate(resolve));
    expect(deployModel).toHaveBeenCalledWith(
      expect.objectContaining({ engineArgs: ['--max-model-len=8192'] }),
    );
  });

  it('POST /api/v1/models rejects a non-array engineArgs with 400', async () => {
    const { app } = buildDeployApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/models',
      payload: { ...DEPLOY_BODY, engineArgs: 'not-an-array' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toContain('engineArgs must be an array of strings');
  });

  it('POST /api/v1/models rejects engineArgs with non-string elements with 400', async () => {
    const { app } = buildDeployApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/models',
      payload: { ...DEPLOY_BODY, engineArgs: ['--ok', 42] },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toContain('engineArgs must be an array of strings');
  });

  it('POST /api/v1/models rejects engineArgs with more than 128 elements with 400 (#126 review)', async () => {
    const { app } = buildDeployApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/models',
      payload: { ...DEPLOY_BODY, engineArgs: Array.from({ length: 129 }, (_, i) => `--x${i}`) },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toContain('at most 128 elements');
  });

  it('POST /api/v1/models rejects an engineArgs element longer than 512 characters with 400 (#126 review)', async () => {
    const { app } = buildDeployApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/models',
      payload: { ...DEPLOY_BODY, engineArgs: [`--x=${'a'.repeat(509)}`] },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toContain('at most 512 characters');
  });

  it('POST /api/v1/models accepts engineArgs at the 128-element / 512-char caps (#126 review)', async () => {
    const { app } = buildDeployApp({
      place: vi.fn(() => ({ workerId: 'w1', devices: [{ deviceIndex: 0, deviceType: 'CUDA' }] })),
      deployModel: vi.fn(() => Promise.resolve()),
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/models',
      payload: {
        ...DEPLOY_BODY,
        engineArgs: [...Array.from({ length: 127 }, (_, i) => `--x${i}`), `--y=${'a'.repeat(508)}`],
      },
    });

    expect(res.statusCode).toBe(202);
  });

  it('GET /api/v1/models/:modelName round-trips a stored engineArgs value', async () => {
    const { app } = buildDeployApp({
      findByName: vi.fn(() =>
        Promise.resolve({
          name: 'm1',
          runnerType: 'vllm',
          modelPath: '/weights/m1',
          requiredMemory: 8e9,
          deviceType: 'CUDA',
          tensorParallel: 1,
          engineConfig: null,
          engineArgs: ['--foo=1'],
          runtimeModule: 'vllm-0.21',
          pinned: false,
        }),
      ),
      getInstancesForModel: vi.fn(() => Promise.resolve([])),
    });

    const res = await app.inject({ method: 'GET', url: '/api/v1/models/m1' });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ engineArgs?: string[] }>().engineArgs).toEqual(['--foo=1']);
  });
});

describe('servedModelName (ADR-020, #154)', () => {
  it('POST /api/v1/models rejects a servedModelName with spaces/invalid characters with 400', async () => {
    const { app } = buildDeployApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/models',
      payload: { ...DEPLOY_BODY, servedModelName: 'invalid name!' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toContain('servedModelName');
  });

  it('POST /api/v1/models accepts a valid servedModelName and forwards it to the repository and deployOrchestration', async () => {
    const createModelRecord = vi.fn((params: Record<string, unknown>) =>
      Promise.resolve({
        id: 'rec-1',
        name: params.name,
        runnerType: params.runnerType,
        modelPath: params.modelPath,
        requiredMemory: (params.requiredMemory as number | undefined) ?? null,
        deviceType: (params.deviceType as string | undefined) ?? null,
        tensorParallel: (params.tensorParallel as number | undefined) ?? 1,
        engineConfig: (params.engineConfig as Record<string, unknown> | undefined) ?? null,
        engineArgs: (params.engineArgs as string[] | undefined) ?? null,
        runtimeModule: (params.runtimeModule as string | undefined) ?? null,
        servedModelName: (params.servedModelName as string | undefined) ?? null,
        pinned: (params.pinned as boolean | undefined) ?? false,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    );
    const deployModel = vi.fn(() => Promise.resolve());
    const { app } = buildDeployApp({
      createModelRecord,
      place: vi.fn(() => ({ workerId: 'w1', devices: [{ deviceIndex: 0, deviceType: 'CUDA' }] })),
      deployModel,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/models',
      payload: { ...DEPLOY_BODY, servedModelName: 'meta-llama/Llama-3.1-8B-Instruct' },
    });

    // Same 202 the equivalent request without servedModelName would get (engineArgs test above).
    expect(res.statusCode).toBe(202);
    expect(createModelRecord).toHaveBeenCalledWith(
      expect.objectContaining({ servedModelName: 'meta-llama/Llama-3.1-8B-Instruct' }),
    );

    await new Promise((resolve) => setImmediate(resolve));
    expect(deployModel).toHaveBeenCalledWith(
      expect.objectContaining({ servedModelName: 'meta-llama/Llama-3.1-8B-Instruct' }),
    );
  });

  it('GET /api/v1/models/:modelName round-trips a stored servedModelName value', async () => {
    const { app } = buildDeployApp({
      findByName: vi.fn(() =>
        Promise.resolve({
          name: 'm1',
          runnerType: 'vllm',
          modelPath: '/weights/m1',
          requiredMemory: 8e9,
          deviceType: 'CUDA',
          tensorParallel: 1,
          engineConfig: null,
          engineArgs: null,
          runtimeModule: 'vllm-0.21',
          servedModelName: 'meta-llama/Llama-3.1-8B-Instruct',
          pinned: false,
        }),
      ),
      getInstancesForModel: vi.fn(() => Promise.resolve([])),
    });

    const res = await app.inject({ method: 'GET', url: '/api/v1/models/m1' });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ servedModelName?: string }>().servedModelName).toBe(
      'meta-llama/Llama-3.1-8B-Instruct',
    );
  });
});

describe('displayName (presentation-only label)', () => {
  it('POST /api/v1/models rejects a whitespace-only displayName with 400', async () => {
    const { app } = buildDeployApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/models',
      payload: { ...DEPLOY_BODY, displayName: '   ' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toContain('displayName');
  });

  it('POST /api/v1/models rejects a displayName longer than 200 characters with 400', async () => {
    const { app } = buildDeployApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/models',
      payload: { ...DEPLOY_BODY, displayName: 'a'.repeat(201) },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toContain('displayName');
  });

  it('POST /api/v1/models rejects a non-string displayName with 400', async () => {
    const { app } = buildDeployApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/models',
      payload: { ...DEPLOY_BODY, displayName: 42 },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toContain('displayName');
  });

  it('POST /api/v1/models trims displayName, forwards the trimmed value to the repository, and never forwards it to deployOrchestration (presentation-only)', async () => {
    const createModelRecord = vi.fn((params: Record<string, unknown>) =>
      Promise.resolve({
        id: 'rec-1',
        name: params.name,
        runnerType: params.runnerType,
        modelPath: params.modelPath,
        requiredMemory: (params.requiredMemory as number | undefined) ?? null,
        deviceType: (params.deviceType as string | undefined) ?? null,
        tensorParallel: (params.tensorParallel as number | undefined) ?? 1,
        engineConfig: (params.engineConfig as Record<string, unknown> | undefined) ?? null,
        engineArgs: (params.engineArgs as string[] | undefined) ?? null,
        runtimeModule: (params.runtimeModule as string | undefined) ?? null,
        servedModelName: (params.servedModelName as string | undefined) ?? null,
        displayName: (params.displayName as string | undefined) ?? null,
        pinned: (params.pinned as boolean | undefined) ?? false,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    );
    const deployModel = vi.fn<(params: Record<string, unknown>) => Promise<void>>(() =>
      Promise.resolve(),
    );
    const { app } = buildDeployApp({
      createModelRecord,
      place: vi.fn(() => ({ workerId: 'w1', devices: [{ deviceIndex: 0, deviceType: 'CUDA' }] })),
      deployModel,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/models',
      payload: { ...DEPLOY_BODY, displayName: '  Qwen test 1  ' },
    });

    expect(res.statusCode).toBe(202);
    expect(createModelRecord).toHaveBeenCalledWith(
      expect.objectContaining({ displayName: 'Qwen test 1' }),
    );

    await new Promise((resolve) => setImmediate(resolve));
    expect(deployModel).toHaveBeenCalledOnce();
    const forwardedParams = deployModel.mock.calls[0][0];
    expect('displayName' in forwardedParams).toBe(false);
    expect(forwardedParams.displayName).toBeUndefined();
  });

  it('GET /api/v1/models includes displayName in the list view when the record has one', async () => {
    const { app } = buildDeployApp({
      findAll: vi.fn(() =>
        Promise.resolve([
          {
            name: 'm1',
            runnerType: 'vllm',
            modelPath: '/weights/m1',
            requiredMemory: 8e9,
            deviceType: 'CUDA',
            tensorParallel: 1,
            engineConfig: null,
            engineArgs: null,
            runtimeModule: null,
            servedModelName: null,
            displayName: 'Qwen test 1',
            pinned: false,
            createdAt: new Date('2026-01-01T00:00:00Z'),
          },
        ]),
      ),
      getAllInstances: vi.fn(() => Promise.resolve([])),
    });

    const res = await app.inject({ method: 'GET', url: '/api/v1/models' });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ models: Array<{ modelName: string; displayName?: string }> }>();
    expect(body.models).toEqual([
      expect.objectContaining({ modelName: 'm1', displayName: 'Qwen test 1' }),
    ]);
  });

  it('GET /api/v1/models/:modelName round-trips a stored displayName value', async () => {
    const { app } = buildDeployApp({
      findByName: vi.fn(() =>
        Promise.resolve({
          name: 'm1',
          runnerType: 'vllm',
          modelPath: '/weights/m1',
          requiredMemory: 8e9,
          deviceType: 'CUDA',
          tensorParallel: 1,
          engineConfig: null,
          engineArgs: null,
          runtimeModule: null,
          servedModelName: null,
          displayName: 'Qwen test 1',
          pinned: false,
        }),
      ),
      getInstancesForModel: vi.fn(() => Promise.resolve([])),
    });

    const res = await app.inject({ method: 'GET', url: '/api/v1/models/m1' });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ displayName?: string }>().displayName).toBe('Qwen test 1');
  });
});

describe('currentMemory (#163 measured telemetry)', () => {
  const RECORD_M1 = {
    name: 'm1',
    runnerType: 'vllm',
    modelPath: '/weights/m1',
    requiredMemory: 8e9,
    deviceType: 'CUDA',
    tensorParallel: 1,
    engineConfig: null,
    engineArgs: null,
    runtimeModule: null,
    servedModelName: null,
    displayName: null,
    pinned: false,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  };

  it('GET /api/v1/models sums currentMemory across a model with two instances', async () => {
    const instances = [
      { ...ACTIVE_STATE, instanceId: 'inst-a' },
      { ...ACTIVE_STATE, instanceId: 'inst-b' },
    ];
    const getMeasuredByInstance = vi.fn(
      () =>
        new Map([
          ['inst-a', 3e9],
          ['inst-b', 2e9],
        ]),
    );
    const { app } = buildDeployApp({
      findAll: vi.fn(() => Promise.resolve([RECORD_M1])),
      getAllInstances: vi.fn(() => Promise.resolve(instances)),
      getMeasuredByInstance,
    });

    const res = await app.inject({ method: 'GET', url: '/api/v1/models' });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ models: Array<{ modelName: string; currentMemory?: number }> }>();
    expect(body.models.find((m) => m.modelName === 'm1')?.currentMemory).toBe(5e9);
  });

  it('GET /api/v1/models omits currentMemory when no instance of the model has a measurement', async () => {
    const instances = [{ ...ACTIVE_STATE, instanceId: 'inst-a' }];
    const { app } = buildDeployApp({
      findAll: vi.fn(() => Promise.resolve([RECORD_M1])),
      getAllInstances: vi.fn(() => Promise.resolve(instances)),
      getMeasuredByInstance: vi.fn(() => new Map()),
    });

    const res = await app.inject({ method: 'GET', url: '/api/v1/models' });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ models: Array<Record<string, unknown>> }>();
    const model = body.models.find((m) => m['modelName'] === 'm1');
    expect(model).toBeDefined();
    expect('currentMemory' in (model as Record<string, unknown>)).toBe(false);
  });

  it('GET /api/v1/models/:modelName includes currentMemory on the InstanceDetail entries that have a measurement', async () => {
    const instances = [
      { ...ACTIVE_STATE, instanceId: 'inst-a' },
      { ...ACTIVE_STATE, instanceId: 'inst-b' },
    ];
    const getMeasuredByInstance = vi.fn(() => new Map([['inst-a', 4e9]]));
    const { app } = buildDeployApp({
      findByName: vi.fn(() => Promise.resolve(RECORD_M1)),
      getInstancesForModel: vi.fn(() => Promise.resolve(instances)),
      getMeasuredByInstance,
    });

    const res = await app.inject({ method: 'GET', url: '/api/v1/models/m1' });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ instances: Array<{ instanceId: string; currentMemory?: number }> }>();
    const instA = body.instances.find((i) => i.instanceId === 'inst-a');
    const instB = body.instances.find((i) => i.instanceId === 'inst-b');
    expect(instA?.currentMemory).toBe(4e9);
    expect(instB && 'currentMemory' in instB).toBe(false);
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

  it.each([
    ModelLifecycleState.PENDING,
    ModelLifecycleState.STARTING,
    ModelLifecycleState.DRAINING,
    ModelLifecycleState.STOPPING,
  ])('DELETE of an instance in %s returns 409 (transient state, #140)', async (state) => {
    const { app } = buildApp({
      getInstance: vi.fn(() => Promise.resolve({ ...ACTIVE_STATE, state })),
    });

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/models/m1/instances/${INSTANCE_ID}`,
    });

    expect(res.statusCode).toBe(409);
    expect(res.json<{ code: string }>().code).toBe('INVALID_STATE');
  });

  it('DELETE of an ACTIVE instance returns 202 (settled state, #140)', async () => {
    const { app } = buildApp();

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/models/m1/instances/${INSTANCE_ID}`,
    });

    expect(res.statusCode).toBe(202);
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
