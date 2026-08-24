import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ModelLifecycleState, ModelState, RunnerState, WorkerStatus } from '@sardeenz/types';

import { DeployOrchestrationService } from '../deploy-orchestration.js';
import type { DeployModelParams } from '../deploy-orchestration.js';
import type { ModelLifecycleService, InstanceState } from '../model-lifecycle.js';
import type { RoutingMapService } from '../routing-map.js';
import type { WorkerPoolService, WorkerRecord } from '../worker-pool.js';
import type { MemoryBudgetService } from '../memory-budget.js';
import type { RunnerClient } from '../../clients/runner.js';
import type { WorkerClient, StartRunnerResponse } from '../../clients/worker.js';

const INSTANCE_ID = 'test-instance';

function makeWorker(overrides: Partial<WorkerRecord> = {}): WorkerRecord {
  return {
    workerId: 'worker-1',
    status: WorkerStatus.ONLINE,
    capabilities: [],
    devices: [],
    lastHeartbeatAt: new Date().toISOString(),
    joinedAt: new Date().toISOString(),
    managementUrl: 'http://worker-1:8080',
    ...overrides,
  };
}

function makeParams(overrides: Partial<DeployModelParams> = {}): DeployModelParams {
  return {
    modelName: 'test-model',
    instanceId: INSTANCE_ID,
    workerId: 'worker-1',
    runnerType: 'vllm',
    modelPath: '/models/test',
    requiredMemory: 1_000_000,
    tensorParallel: 1,
    devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
    ...overrides,
  };
}

function makeRunnerResponse(overrides: Partial<StartRunnerResponse> = {}): StartRunnerResponse {
  return {
    runnerId: 'runner-abc',
    host: '10.0.0.1',
    port: 5001,
    ...overrides,
  };
}

interface MockDeps {
  lifecycle: {
    transition: ReturnType<typeof vi.fn>;
    getInstancesForModel: ReturnType<typeof vi.fn>;
    setRunnerEndpoint: ReturnType<typeof vi.fn>;
  };
  routingMap: {
    setModelState: ReturnType<typeof vi.fn>;
    addEndpoint: ReturnType<typeof vi.fn>;
    removeModel: ReturnType<typeof vi.fn>;
  };
  workerPool: {
    getWorker: ReturnType<typeof vi.fn>;
  };
  memoryBudget: {
    releaseInstanceReservations: ReturnType<typeof vi.fn>;
  };
  workerClient: {
    startRunner: ReturnType<typeof vi.fn>;
    stopRunner: ReturnType<typeof vi.fn>;
  };
  runnerClient: {
    getHealth: ReturnType<typeof vi.fn>;
  };
}

function createMocks(): MockDeps {
  // The route handler creates this instance's Redis record (STARTING) before calling
  // deployModel() — mirror that here so refreshModelRoutingState (called at the top of
  // deployModel, after the ACTIVE transition, and from transitionToError) derives the aggregate
  // routing state from this single instance's current tracked state, exactly like the real
  // ModelLifecycleService would.
  const trackedInstance = { state: ModelLifecycleState.STARTING as ModelLifecycleState };

  return {
    lifecycle: {
      transition: vi.fn((_modelName: string, _instanceId: string, to: ModelLifecycleState) => {
        trackedInstance.state = to;
        return Promise.resolve({});
      }),
      getInstancesForModel: vi.fn((): InstanceState[] => [
        {
          instanceId: INSTANCE_ID,
          modelName: 'test-model',
          state: trackedInstance.state,
          workerId: 'worker-1',
          runnerHost: null,
          runnerPort: null,
          runnerId: null,
          deviceIndices: null,
          lastInferenceAt: null,
          stateChangedAt: new Date().toISOString(),
          errorMessage: null,
        },
      ]),
      setRunnerEndpoint: vi.fn().mockResolvedValue(undefined),
    },
    routingMap: {
      setModelState: vi.fn().mockResolvedValue(undefined),
      addEndpoint: vi.fn().mockResolvedValue(undefined),
      removeModel: vi.fn().mockResolvedValue(undefined),
    },
    workerPool: {
      getWorker: vi.fn().mockReturnValue(makeWorker()),
    },
    memoryBudget: {
      releaseInstanceReservations: vi.fn(),
    },
    workerClient: {
      startRunner: vi.fn().mockResolvedValue(makeRunnerResponse()),
      stopRunner: vi.fn().mockResolvedValue(undefined),
    },
    runnerClient: {
      getHealth: vi.fn().mockResolvedValue({
        state: RunnerState.READY,
        activeRequests: 0,
      }),
    },
  };
}

function createService(mocks: MockDeps): DeployOrchestrationService {
  return new DeployOrchestrationService(
    mocks.lifecycle as unknown as ModelLifecycleService,
    mocks.routingMap as unknown as RoutingMapService,
    mocks.workerPool as unknown as WorkerPoolService,
    mocks.memoryBudget as unknown as MemoryBudgetService,
    () => mocks.workerClient as unknown as WorkerClient,
    () => mocks.runnerClient as unknown as RunnerClient,
    5_000,
    100,
  );
}

describe('DeployOrchestrationService', () => {
  let mocks: MockDeps;
  let service: DeployOrchestrationService;

  beforeEach(() => {
    mocks = createMocks();
    service = createService(mocks);
  });

  describe('deployModel — happy path', () => {
    it('transitions model to ACTIVE with runner details', async () => {
      await service.deployModel(makeParams());

      expect(mocks.routingMap.setModelState).toHaveBeenCalledWith(
        'test-model',
        ModelState.STARTING,
      );
      expect(mocks.workerClient.startRunner).toHaveBeenCalledOnce();
      // No distinct engine port reported → inference falls back to the management port.
      expect(mocks.lifecycle.setRunnerEndpoint).toHaveBeenCalledWith('test-model', INSTANCE_ID, {
        runnerId: 'runner-abc',
        host: '10.0.0.1',
        port: 5001,
        enginePort: 5001,
      });
      expect(mocks.runnerClient.getHealth).toHaveBeenCalledOnce();
      expect(mocks.routingMap.addEndpoint).toHaveBeenCalledWith('test-model', {
        host: '10.0.0.1',
        port: 5001,
        weight: 1,
        healthy: true,
        runnerId: 'runner-abc',
      });
      expect(mocks.lifecycle.transition).toHaveBeenCalledWith(
        'test-model',
        INSTANCE_ID,
        ModelLifecycleState.ACTIVE,
        {
          runnerHost: '10.0.0.1',
          runnerPort: 5001,
          runnerEnginePort: 5001,
          runnerId: 'runner-abc',
        },
      );
      expect(mocks.routingMap.setModelState).toHaveBeenCalledWith('test-model', ModelState.ACTIVE);
    });

    it('releases the model reservation after transitioning to ACTIVE (#87)', async () => {
      await service.deployModel(makeParams());

      expect(mocks.memoryBudget.releaseInstanceReservations).toHaveBeenCalledWith(INSTANCE_ID);
    });

    it('routes inference to the engine port while keeping management on the runner port', async () => {
      // vLLM-style runner: management shim on 5001, OpenAI server on 5002.
      mocks.workerClient.startRunner.mockResolvedValue(
        makeRunnerResponse({ port: 5001, enginePort: 5002 }),
      );

      await service.deployModel(makeParams());

      // Health polling targets the management port (the runner client is created from host+port).
      expect(mocks.lifecycle.setRunnerEndpoint).toHaveBeenCalledWith('test-model', INSTANCE_ID, {
        runnerId: 'runner-abc',
        host: '10.0.0.1',
        port: 5001,
        enginePort: 5002,
      });
      // The proxy-facing routing endpoint targets the engine port.
      expect(mocks.routingMap.addEndpoint).toHaveBeenCalledWith('test-model', {
        host: '10.0.0.1',
        port: 5002,
        weight: 1,
        healthy: true,
        runnerId: 'runner-abc',
      });
      expect(mocks.lifecycle.transition).toHaveBeenCalledWith(
        'test-model',
        INSTANCE_ID,
        ModelLifecycleState.ACTIVE,
        {
          runnerHost: '10.0.0.1',
          runnerPort: 5001,
          runnerEnginePort: 5002,
          runnerId: 'runner-abc',
        },
      );
    });

    it('passes full start request to worker client', async () => {
      const params = makeParams({
        engineConfig: { maxModelLen: 4096 },
        deviceType: 'CUDA',
        devices: [
          { deviceIndex: 0, deviceType: 'CUDA' },
          { deviceIndex: 1, deviceType: 'CUDA' },
        ],
        tensorParallel: 2,
      });

      await service.deployModel(params);

      expect(mocks.workerClient.startRunner).toHaveBeenCalledWith({
        modelName: 'test-model',
        instanceId: INSTANCE_ID,
        runnerType: 'vllm',
        modelPath: '/models/test',
        requiredMemory: 1_000_000,
        deviceType: 'CUDA',
        tensorParallel: 2,
        engineConfig: { maxModelLen: 4096 },
        engineArgs: undefined,
        runtimeModule: undefined,
        devices: [
          { deviceIndex: 0, deviceType: 'CUDA' },
          { deviceIndex: 1, deviceType: 'CUDA' },
        ],
      });
    });

    it('forwards engineArgs to the worker client (#126)', async () => {
      const params = makeParams({ engineArgs: ['--a', 'b'] });

      await service.deployModel(params);

      expect(mocks.workerClient.startRunner).toHaveBeenCalledWith(
        expect.objectContaining({ engineArgs: ['--a', 'b'] }),
      );
    });

    it('forwards servedModelName to the worker client (ADR-020, #154)', async () => {
      const params = makeParams({ servedModelName: 'meta-llama/Llama-3.1-8B-Instruct' });

      await service.deployModel(params);

      expect(mocks.workerClient.startRunner).toHaveBeenCalledWith(
        expect.objectContaining({ servedModelName: 'meta-llama/Llama-3.1-8B-Instruct' }),
      );
    });

    it('sends servedModelName: undefined to the worker client when unset (ADR-020, #154)', async () => {
      const params = makeParams();

      await service.deployModel(params);

      expect(mocks.workerClient.startRunner).toHaveBeenCalledWith(
        expect.objectContaining({ servedModelName: undefined }),
      );
    });
  });

  describe('deployModel — runner placement persistence', () => {
    it('persists the runner endpoint before waiting for readiness', async () => {
      const order: string[] = [];
      mocks.lifecycle.setRunnerEndpoint.mockImplementation(() => {
        order.push('setRunnerEndpoint');
        return Promise.resolve();
      });
      mocks.runnerClient.getHealth.mockImplementation(() => {
        order.push('getHealth');
        return Promise.resolve({ state: RunnerState.READY, activeRequests: 0 });
      });

      await service.deployModel(makeParams());

      expect(order).toEqual(['setRunnerEndpoint', 'getHealth']);
    });

    it('does not persist the endpoint when startRunner fails', async () => {
      mocks.workerClient.startRunner.mockRejectedValue(new Error('connection refused'));

      await expect(service.deployModel(makeParams())).rejects.toThrow('connection refused');

      expect(mocks.lifecycle.setRunnerEndpoint).not.toHaveBeenCalled();
    });
  });

  describe('deployModel — worker errors', () => {
    it('transitions to ERROR when worker is not found', async () => {
      mocks.workerPool.getWorker.mockReturnValue(null);

      await expect(service.deployModel(makeParams())).rejects.toThrow('Worker not found');

      expect(mocks.lifecycle.transition).toHaveBeenCalledWith(
        'test-model',
        INSTANCE_ID,
        ModelLifecycleState.ERROR,
        expect.objectContaining({
          errorMessage: expect.stringContaining('Worker not found') as string,
        }),
      );
    });

    it('releases capacity when worker is not found', async () => {
      mocks.workerPool.getWorker.mockReturnValue(null);

      await expect(service.deployModel(makeParams())).rejects.toThrow();

      expect(mocks.memoryBudget.releaseInstanceReservations).toHaveBeenCalledWith(INSTANCE_ID);
    });
  });

  describe('deployModel — startRunner failure', () => {
    it('transitions to ERROR and releases capacity', async () => {
      mocks.workerClient.startRunner.mockRejectedValue(new Error('connection refused'));

      await expect(service.deployModel(makeParams())).rejects.toThrow('connection refused');

      expect(mocks.lifecycle.transition).toHaveBeenCalledWith(
        'test-model',
        INSTANCE_ID,
        ModelLifecycleState.ERROR,
        expect.objectContaining({ errorMessage: 'connection refused' }),
      );
      expect(mocks.memoryBudget.releaseInstanceReservations).toHaveBeenCalledWith(INSTANCE_ID);
    });
  });

  describe('deployModel — runner health polling', () => {
    it('polls until runner is READY', async () => {
      let callCount = 0;
      mocks.runnerClient.getHealth.mockImplementation(() => {
        callCount++;
        if (callCount < 3) {
          return Promise.resolve({ state: RunnerState.STARTING, activeRequests: 0 });
        }
        return Promise.resolve({ state: RunnerState.READY, activeRequests: 0 });
      });

      await service.deployModel(makeParams());

      expect(mocks.runnerClient.getHealth).toHaveBeenCalledTimes(3);
      expect(mocks.lifecycle.transition).toHaveBeenCalledWith(
        'test-model',
        INSTANCE_ID,
        ModelLifecycleState.ACTIVE,
        expect.any(Object),
      );
    });

    it('accepts BUSY as a ready state', async () => {
      mocks.runnerClient.getHealth.mockResolvedValue({
        state: RunnerState.BUSY,
        activeRequests: 1,
      });

      await service.deployModel(makeParams());

      expect(mocks.lifecycle.transition).toHaveBeenCalledWith(
        'test-model',
        INSTANCE_ID,
        ModelLifecycleState.ACTIVE,
        expect.any(Object),
      );
    });

    it('transitions to ERROR when runner enters ERROR state', async () => {
      mocks.runnerClient.getHealth.mockResolvedValue({
        state: RunnerState.ERROR,
        activeRequests: 0,
        message: 'OOM killed',
      });

      await expect(service.deployModel(makeParams())).rejects.toThrow('ERROR state');

      expect(mocks.lifecycle.transition).toHaveBeenCalledWith(
        'test-model',
        INSTANCE_ID,
        ModelLifecycleState.ERROR,
        expect.objectContaining({ errorMessage: expect.stringContaining('OOM killed') as string }),
      );
      expect(mocks.memoryBudget.releaseInstanceReservations).toHaveBeenCalledWith(INSTANCE_ID);
    });

    it('transitions to ERROR on deploy timeout, surfacing RUNNER_TIMEOUT (not an AbortError) (#96)', async () => {
      mocks.runnerClient.getHealth.mockResolvedValue({
        state: RunnerState.STARTING,
        activeRequests: 0,
      });

      const shortTimeoutService = new DeployOrchestrationService(
        mocks.lifecycle as unknown as ModelLifecycleService,
        mocks.routingMap as unknown as RoutingMapService,
        mocks.workerPool as unknown as WorkerPoolService,
        mocks.memoryBudget as unknown as MemoryBudgetService,
        () => mocks.workerClient as unknown as WorkerClient,
        () => mocks.runnerClient as unknown as RunnerClient,
        200,
        50,
      );

      // Before delaySafe(), delay() rejected with an AbortError as soon as the timeout signal
      // fired, which propagated straight out of waitForReady's polling loop — the RUNNER_TIMEOUT
      // ControlPlaneError below the loop was unreachable.
      await expect(shortTimeoutService.deployModel(makeParams())).rejects.toMatchObject({
        code: 'RUNNER_TIMEOUT',
      });

      expect(mocks.lifecycle.transition).toHaveBeenCalledWith(
        'test-model',
        INSTANCE_ID,
        ModelLifecycleState.ERROR,
        expect.objectContaining({ errorMessage: expect.any(String) as string }),
      );
      expect(mocks.memoryBudget.releaseInstanceReservations).toHaveBeenCalledWith(INSTANCE_ID);
    });
  });

  describe('deployModel — capacity release', () => {
    it('releases the model reservation once, regardless of device count', async () => {
      mocks.workerPool.getWorker.mockReturnValue(null);

      const params = makeParams({
        requiredMemory: 2_000_000,
        tensorParallel: 2,
        devices: [
          { deviceIndex: 0, deviceType: 'CUDA' },
          { deviceIndex: 1, deviceType: 'CUDA' },
        ],
      });

      await expect(service.deployModel(params)).rejects.toThrow();

      expect(mocks.memoryBudget.releaseInstanceReservations).toHaveBeenCalledWith(INSTANCE_ID);
      expect(mocks.memoryBudget.releaseInstanceReservations).toHaveBeenCalledTimes(1);
    });
  });

  describe('transitionToError resilience', () => {
    it('swallows errors from lifecycle.transition during error handling', async () => {
      mocks.workerPool.getWorker.mockReturnValue(null);
      mocks.lifecycle.transition.mockRejectedValue(new Error('Redis down'));

      await expect(service.deployModel(makeParams())).rejects.toThrow('Worker not found');

      expect(mocks.memoryBudget.releaseInstanceReservations).toHaveBeenCalledWith(INSTANCE_ID);
    });
  });
});
