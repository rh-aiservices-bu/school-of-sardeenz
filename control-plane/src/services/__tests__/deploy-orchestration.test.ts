import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ModelLifecycleState, ModelState, RunnerState, WorkerStatus } from '@sardeenz/types';

import { DeployOrchestrationService } from '../deploy-orchestration.js';
import type { DeployModelParams } from '../deploy-orchestration.js';
import type { ModelLifecycleService } from '../model-lifecycle.js';
import type { RoutingMapService } from '../routing-map.js';
import type { WorkerPoolService, WorkerRecord } from '../worker-pool.js';
import type { MemoryBudgetService } from '../memory-budget.js';
import type { RunnerClient } from '../../clients/runner.js';
import type { WorkerClient, StartRunnerResponse } from '../../clients/worker.js';

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
    getState: ReturnType<typeof vi.fn>;
  };
  routingMap: {
    setModelState: ReturnType<typeof vi.fn>;
    addEndpoint: ReturnType<typeof vi.fn>;
  };
  workerPool: {
    getWorker: ReturnType<typeof vi.fn>;
  };
  memoryBudget: {
    releaseCapacity: ReturnType<typeof vi.fn>;
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
  return {
    lifecycle: {
      transition: vi.fn().mockResolvedValue({}),
      getState: vi.fn(),
    },
    routingMap: {
      setModelState: vi.fn().mockResolvedValue(undefined),
      addEndpoint: vi.fn().mockResolvedValue(undefined),
    },
    workerPool: {
      getWorker: vi.fn().mockReturnValue(makeWorker()),
    },
    memoryBudget: {
      releaseCapacity: vi.fn(),
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
        ModelLifecycleState.ACTIVE,
        { runnerHost: '10.0.0.1', runnerPort: 5001, runnerId: 'runner-abc' },
      );
      expect(mocks.routingMap.setModelState).toHaveBeenCalledWith('test-model', ModelState.ACTIVE);
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
        runnerType: 'vllm',
        modelPath: '/models/test',
        requiredMemory: 1_000_000,
        deviceType: 'CUDA',
        tensorParallel: 2,
        engineConfig: { maxModelLen: 4096 },
        devices: [
          { deviceIndex: 0, deviceType: 'CUDA' },
          { deviceIndex: 1, deviceType: 'CUDA' },
        ],
      });
    });
  });

  describe('deployModel — worker errors', () => {
    it('transitions to ERROR when worker is not found', async () => {
      mocks.workerPool.getWorker.mockReturnValue(null);

      await expect(service.deployModel(makeParams())).rejects.toThrow('Worker not found');

      expect(mocks.lifecycle.transition).toHaveBeenCalledWith(
        'test-model',
        ModelLifecycleState.ERROR,
        expect.objectContaining({
          errorMessage: expect.stringContaining('Worker not found') as string,
        }),
      );
    });

    it('transitions to ERROR when worker has no managementUrl', async () => {
      mocks.workerPool.getWorker.mockReturnValue(makeWorker({ managementUrl: null }));

      await expect(service.deployModel(makeParams())).rejects.toThrow('no management URL');

      expect(mocks.lifecycle.transition).toHaveBeenCalledWith(
        'test-model',
        ModelLifecycleState.ERROR,
        expect.objectContaining({
          errorMessage: expect.stringContaining('no management URL') as string,
        }),
      );
    });

    it('releases capacity when worker is not found', async () => {
      mocks.workerPool.getWorker.mockReturnValue(null);

      await expect(service.deployModel(makeParams())).rejects.toThrow();

      expect(mocks.memoryBudget.releaseCapacity).toHaveBeenCalledWith('worker-1', 0, 1_000_000);
    });
  });

  describe('deployModel — startRunner failure', () => {
    it('transitions to ERROR and releases capacity', async () => {
      mocks.workerClient.startRunner.mockRejectedValue(new Error('connection refused'));

      await expect(service.deployModel(makeParams())).rejects.toThrow('connection refused');

      expect(mocks.lifecycle.transition).toHaveBeenCalledWith(
        'test-model',
        ModelLifecycleState.ERROR,
        expect.objectContaining({ errorMessage: 'connection refused' }),
      );
      expect(mocks.memoryBudget.releaseCapacity).toHaveBeenCalledWith('worker-1', 0, 1_000_000);
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
        ModelLifecycleState.ERROR,
        expect.objectContaining({ errorMessage: expect.stringContaining('OOM killed') as string }),
      );
      expect(mocks.memoryBudget.releaseCapacity).toHaveBeenCalled();
    });

    it('transitions to ERROR on deploy timeout', async () => {
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

      await expect(shortTimeoutService.deployModel(makeParams())).rejects.toThrow();

      expect(mocks.lifecycle.transition).toHaveBeenCalledWith(
        'test-model',
        ModelLifecycleState.ERROR,
        expect.objectContaining({ errorMessage: expect.any(String) as string }),
      );
      expect(mocks.memoryBudget.releaseCapacity).toHaveBeenCalled();
    });
  });

  describe('deployModel — capacity release', () => {
    it('releases per-device capacity for multi-device deployments', async () => {
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

      expect(mocks.memoryBudget.releaseCapacity).toHaveBeenCalledWith('worker-1', 0, 1_000_000);
      expect(mocks.memoryBudget.releaseCapacity).toHaveBeenCalledWith('worker-1', 1, 1_000_000);
    });
  });

  describe('transitionToError resilience', () => {
    it('swallows errors from lifecycle.transition during error handling', async () => {
      mocks.workerPool.getWorker.mockReturnValue(null);
      mocks.lifecycle.transition.mockRejectedValue(new Error('Redis down'));

      await expect(service.deployModel(makeParams())).rejects.toThrow('Worker not found');

      expect(mocks.memoryBudget.releaseCapacity).toHaveBeenCalled();
    });
  });
});
