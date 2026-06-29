import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ClusterEventType, ModelLifecycleState, WorkerStatus } from '@sardeenz/types';
import type { ControlPlaneComponents } from '@sardeenz/types';

import { ReconciliationService } from '../reconciliation.js';
import type { ReconciliationConfig } from '../reconciliation.js';
import type { ModelLifecycleService, ModelState } from '../model-lifecycle.js';
import type { WorkerPoolService, WorkerRecord } from '../worker-pool.js';
import type { MemoryBudgetService } from '../memory-budget.js';
import type { RoutingMapService } from '../routing-map.js';
import type { Redis } from '../../clients/redis.js';

type ClusterEvent = ControlPlaneComponents['schemas']['ClusterEvent'];

function makeModelState(overrides: Partial<ModelState> & { modelName: string }): ModelState {
  return {
    state: ModelLifecycleState.ACTIVE,
    workerId: 'w1',
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
    workerId: 'dead-worker',
    status: WorkerStatus.OFFLINE,
    capabilities: [],
    devices: [],
    lastHeartbeatAt: null,
    joinedAt: new Date().toISOString(),
    managementUrl: null,
    ...overrides,
  };
}

interface MockDeps {
  lifecycle: {
    getAllStates: ReturnType<typeof vi.fn>;
    transition: ReturnType<typeof vi.fn>;
  };
  workerPool: {
    discoverWorkers: ReturnType<typeof vi.fn>;
    checkHeartbeats: ReturnType<typeof vi.fn>;
    getDeadWorkers: ReturnType<typeof vi.fn>;
    getAllWorkers: ReturnType<typeof vi.fn>;
    removeWorker: ReturnType<typeof vi.fn>;
  };
  memoryBudget: {
    refreshAll: ReturnType<typeof vi.fn>;
    getAllBudgets: ReturnType<typeof vi.fn>;
  };
  routingMap: {
    removeModel: ReturnType<typeof vi.fn>;
  };
  leaderElection: {
    isLeader: boolean;
  };
  logger: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
  redis: {
    publish: ReturnType<typeof vi.fn>;
  };
}

const DEFAULT_CONFIG: ReconciliationConfig = {
  reconciliationIntervalSecs: 30,
  deployTimeoutSecs: 600,
  sleepTimeoutSecs: 300,
};

const KEY_PREFIX = 'sardeenz';

function createMocks(): MockDeps {
  return {
    lifecycle: {
      getAllStates: vi.fn().mockResolvedValue([]),
      transition: vi.fn().mockResolvedValue({}),
    },
    workerPool: {
      discoverWorkers: vi.fn().mockResolvedValue(undefined),
      checkHeartbeats: vi.fn().mockResolvedValue(undefined),
      getDeadWorkers: vi.fn().mockReturnValue([]),
      getAllWorkers: vi.fn().mockReturnValue([]),
      removeWorker: vi.fn(),
    },
    memoryBudget: {
      refreshAll: vi.fn().mockResolvedValue(undefined),
      getAllBudgets: vi.fn().mockReturnValue([]),
    },
    routingMap: {
      removeModel: vi.fn().mockResolvedValue(undefined),
    },
    leaderElection: {
      isLeader: true,
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    redis: {
      publish: vi.fn().mockResolvedValue(1),
    },
  };
}

function createService(mocks: MockDeps): ReconciliationService {
  return new ReconciliationService(
    mocks.lifecycle as unknown as ModelLifecycleService,
    mocks.workerPool as unknown as WorkerPoolService,
    mocks.memoryBudget as unknown as MemoryBudgetService,
    mocks.routingMap as unknown as RoutingMapService,
    mocks.leaderElection,
    DEFAULT_CONFIG,
    mocks.logger,
    mocks.redis as unknown as Redis,
    KEY_PREFIX,
  );
}

describe('ReconciliationService', () => {
  let mocks: MockDeps;
  let service: ReconciliationService;

  beforeEach(() => {
    mocks = createMocks();
    service = createService(mocks);
  });

  describe('tick — leader guard', () => {
    it('skips all work when not leader', async () => {
      mocks.leaderElection.isLeader = false;

      await service.tick();

      expect(mocks.workerPool.discoverWorkers).not.toHaveBeenCalled();
      expect(mocks.workerPool.checkHeartbeats).not.toHaveBeenCalled();
      expect(mocks.memoryBudget.refreshAll).not.toHaveBeenCalled();
      expect(mocks.lifecycle.getAllStates).not.toHaveBeenCalled();
    });

    it('runs all steps when leader', async () => {
      await service.tick();

      expect(mocks.workerPool.discoverWorkers).toHaveBeenCalledOnce();
      expect(mocks.workerPool.checkHeartbeats).toHaveBeenCalledOnce();
      expect(mocks.workerPool.getDeadWorkers).toHaveBeenCalledOnce();
      expect(mocks.memoryBudget.refreshAll).toHaveBeenCalledOnce();
      expect(mocks.lifecycle.getAllStates).toHaveBeenCalled();
    });
  });

  describe('tick — leader promotion', () => {
    it('logs on first tick after becoming leader', async () => {
      await service.tick();

      expect(mocks.logger.info).toHaveBeenCalledWith(
        {},
        'Leader promotion detected — running full state rebuild',
      );
    });

    it('does not log promotion on subsequent ticks', async () => {
      await service.tick();
      mocks.logger.info.mockClear();

      await service.tick();

      expect(mocks.logger.info).not.toHaveBeenCalledWith(
        {},
        'Leader promotion detected — running full state rebuild',
      );
    });

    it('re-detects promotion after losing and regaining leadership', async () => {
      await service.tick();
      mocks.logger.info.mockClear();

      mocks.leaderElection.isLeader = false;
      await service.tick();

      mocks.leaderElection.isLeader = true;
      await service.tick();

      expect(mocks.logger.info).toHaveBeenCalledWith(
        {},
        'Leader promotion detected — running full state rebuild',
      );
    });
  });

  describe('tick — dead worker handling', () => {
    it('transitions models on dead workers to ERROR', async () => {
      mocks.workerPool.getDeadWorkers.mockReturnValue([makeWorker({ workerId: 'w1' })]);
      mocks.lifecycle.getAllStates.mockResolvedValue([
        makeModelState({
          modelName: 'model-a',
          workerId: 'w1',
          state: ModelLifecycleState.ACTIVE,
        }),
      ]);

      await service.tick();

      expect(mocks.lifecycle.transition).toHaveBeenCalledWith(
        'model-a',
        ModelLifecycleState.ERROR,
        { errorMessage: 'Worker w1 is dead' },
      );
    });

    it('removes routing for dead worker models', async () => {
      mocks.workerPool.getDeadWorkers.mockReturnValue([makeWorker({ workerId: 'w1' })]);
      mocks.lifecycle.getAllStates.mockResolvedValue([
        makeModelState({
          modelName: 'model-a',
          workerId: 'w1',
          state: ModelLifecycleState.ACTIVE,
        }),
      ]);

      await service.tick();

      expect(mocks.routingMap.removeModel).toHaveBeenCalledWith('model-a');
    });

    it('removes dead workers from the pool', async () => {
      mocks.workerPool.getDeadWorkers.mockReturnValue([makeWorker({ workerId: 'w1' })]);
      mocks.lifecycle.getAllStates.mockResolvedValue([]);

      await service.tick();

      expect(mocks.workerPool.removeWorker).toHaveBeenCalledWith('w1');
    });

    it('skips models in STOPPED or ERROR state on dead workers', async () => {
      mocks.workerPool.getDeadWorkers.mockReturnValue([makeWorker({ workerId: 'w1' })]);
      mocks.lifecycle.getAllStates.mockResolvedValue([
        makeModelState({
          modelName: 'stopped-model',
          workerId: 'w1',
          state: ModelLifecycleState.STOPPED,
        }),
        makeModelState({
          modelName: 'errored-model',
          workerId: 'w1',
          state: ModelLifecycleState.ERROR,
        }),
      ]);

      await service.tick();

      expect(mocks.lifecycle.transition).not.toHaveBeenCalled();
    });

    it('continues processing if one model transition fails', async () => {
      mocks.workerPool.getDeadWorkers.mockReturnValue([makeWorker({ workerId: 'w1' })]);
      mocks.lifecycle.getAllStates.mockResolvedValue([
        makeModelState({
          modelName: 'model-a',
          workerId: 'w1',
          state: ModelLifecycleState.ACTIVE,
        }),
        makeModelState({
          modelName: 'model-b',
          workerId: 'w1',
          state: ModelLifecycleState.ACTIVE,
        }),
      ]);
      mocks.lifecycle.transition
        .mockRejectedValueOnce(new Error('transition failed'))
        .mockResolvedValueOnce({});

      await service.tick();

      expect(mocks.lifecycle.transition).toHaveBeenCalledTimes(2);
      expect(mocks.routingMap.removeModel).toHaveBeenCalledWith('model-b');
    });
  });

  describe('tick — stuck model recovery', () => {
    it('transitions STARTING models stuck past deployTimeoutSecs to ERROR', async () => {
      mocks.lifecycle.getAllStates.mockResolvedValue([
        makeModelState({
          modelName: 'stuck-starting',
          state: ModelLifecycleState.STARTING,
          stateChangedAt: new Date(Date.now() - 700_000).toISOString(),
        }),
      ]);

      await service.tick();

      expect(mocks.lifecycle.transition).toHaveBeenCalledWith(
        'stuck-starting',
        ModelLifecycleState.ERROR,
        expect.objectContaining({
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          errorMessage: expect.stringContaining('Stuck in STARTING'),
        }),
      );
      expect(mocks.routingMap.removeModel).toHaveBeenCalledWith('stuck-starting');
    });

    it('transitions DRAINING models stuck past sleepTimeoutSecs to ERROR', async () => {
      mocks.lifecycle.getAllStates.mockResolvedValue([
        makeModelState({
          modelName: 'stuck-draining',
          state: ModelLifecycleState.DRAINING,
          stateChangedAt: new Date(Date.now() - 400_000).toISOString(),
        }),
      ]);

      await service.tick();

      expect(mocks.lifecycle.transition).toHaveBeenCalledWith(
        'stuck-draining',
        ModelLifecycleState.ERROR,
        expect.objectContaining({
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          errorMessage: expect.stringContaining('Stuck in DRAINING'),
        }),
      );
    });

    it('transitions STOPPING models stuck past sleepTimeoutSecs to ERROR', async () => {
      mocks.lifecycle.getAllStates.mockResolvedValue([
        makeModelState({
          modelName: 'stuck-stopping',
          state: ModelLifecycleState.STOPPING,
          stateChangedAt: new Date(Date.now() - 400_000).toISOString(),
        }),
      ]);

      await service.tick();

      expect(mocks.lifecycle.transition).toHaveBeenCalledWith(
        'stuck-stopping',
        ModelLifecycleState.ERROR,
        expect.objectContaining({
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          errorMessage: expect.stringContaining('Stuck in STOPPING'),
        }),
      );
    });

    it('does not touch models within their timeout window', async () => {
      mocks.lifecycle.getAllStates.mockResolvedValue([
        makeModelState({
          modelName: 'recent-starting',
          state: ModelLifecycleState.STARTING,
          stateChangedAt: new Date(Date.now() - 60_000).toISOString(),
        }),
        makeModelState({
          modelName: 'recent-draining',
          state: ModelLifecycleState.DRAINING,
          stateChangedAt: new Date(Date.now() - 60_000).toISOString(),
        }),
      ]);

      await service.tick();

      expect(mocks.lifecycle.transition).not.toHaveBeenCalled();
    });

    it('does not touch non-transitional states', async () => {
      mocks.lifecycle.getAllStates.mockResolvedValue([
        makeModelState({
          modelName: 'active',
          state: ModelLifecycleState.ACTIVE,
          stateChangedAt: new Date(Date.now() - 999_999).toISOString(),
        }),
        makeModelState({
          modelName: 'sleeping',
          state: ModelLifecycleState.SLEEPING,
          stateChangedAt: new Date(Date.now() - 999_999).toISOString(),
        }),
        makeModelState({
          modelName: 'pending',
          state: ModelLifecycleState.PENDING,
          stateChangedAt: new Date(Date.now() - 999_999).toISOString(),
        }),
      ]);

      await service.tick();

      expect(mocks.lifecycle.transition).not.toHaveBeenCalled();
    });
  });

  describe('tick — error isolation', () => {
    it('continues to subsequent steps when discoverWorkers throws', async () => {
      mocks.workerPool.discoverWorkers.mockRejectedValue(new Error('redis down'));

      await service.tick();

      expect(mocks.workerPool.checkHeartbeats).toHaveBeenCalledOnce();
      expect(mocks.memoryBudget.refreshAll).toHaveBeenCalledOnce();
    });

    it('continues to subsequent steps when checkHeartbeats throws', async () => {
      mocks.workerPool.checkHeartbeats.mockRejectedValue(new Error('redis down'));

      await service.tick();

      expect(mocks.workerPool.getDeadWorkers).toHaveBeenCalledOnce();
      expect(mocks.memoryBudget.refreshAll).toHaveBeenCalledOnce();
    });

    it('continues to subsequent steps when refreshAll throws', async () => {
      mocks.memoryBudget.refreshAll.mockRejectedValue(new Error('redis down'));

      await service.tick();

      expect(mocks.lifecycle.getAllStates).toHaveBeenCalled();
    });

    it('logs errors for failed steps', async () => {
      mocks.workerPool.discoverWorkers.mockRejectedValue(new Error('connection lost'));

      await service.tick();

      expect(mocks.logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ step: 'discoverWorkers', err: 'connection lost' }),
        'Reconciliation step failed',
      );
    });
  });

  describe('tick — cluster event publishing', () => {
    const CHANNEL = `${KEY_PREFIX}:cluster-events`;

    it('publishes WORKER_JOINED when a new worker is discovered', async () => {
      mocks.workerPool.getAllWorkers
        .mockReturnValueOnce([])
        .mockReturnValue([makeWorker({ workerId: 'new-w1', status: WorkerStatus.ONLINE })]);

      await service.tick();

      expect(mocks.redis.publish).toHaveBeenCalledWith(
        CHANNEL,
        expect.stringContaining(ClusterEventType.WORKER_JOINED),
      );
      const call = mocks.redis.publish.mock.calls.find((c: string[]) =>
        c[1].includes(ClusterEventType.WORKER_JOINED),
      )!;
      const event = JSON.parse(call[1] as string) as ClusterEvent;
      expect(event.workerId).toBe('new-w1');
    });

    it('does not publish WORKER_JOINED when the same workers are rediscovered', async () => {
      const existingWorker = makeWorker({ workerId: 'w1', status: WorkerStatus.ONLINE });
      mocks.workerPool.getAllWorkers.mockReturnValue([existingWorker]);

      await service.tick();

      const joinCalls = mocks.redis.publish.mock.calls.filter((c: string[]) =>
        c[1].includes(ClusterEventType.WORKER_JOINED),
      );
      expect(joinCalls).toHaveLength(0);
    });

    it('publishes WORKER_LEFT before removing a dead worker', async () => {
      mocks.workerPool.getAllWorkers.mockReturnValue([]);
      mocks.workerPool.getDeadWorkers.mockReturnValue([makeWorker({ workerId: 'dead-w1' })]);
      mocks.lifecycle.getAllStates.mockResolvedValue([]);

      await service.tick();

      expect(mocks.redis.publish).toHaveBeenCalledWith(
        CHANNEL,
        expect.stringContaining(ClusterEventType.WORKER_LEFT),
      );
      const call = mocks.redis.publish.mock.calls.find((c: string[]) =>
        c[1].includes(ClusterEventType.WORKER_LEFT),
      )!;
      const event = JSON.parse(call[1] as string) as ClusterEvent;
      expect(event.workerId).toBe('dead-w1');

      expect(mocks.workerPool.removeWorker).toHaveBeenCalledWith('dead-w1');
    });

    it('publishes WORKER_MEMORY_UPDATED after refreshing budgets', async () => {
      mocks.workerPool.getAllWorkers.mockReturnValue([]);
      mocks.memoryBudget.getAllBudgets.mockReturnValue([
        { workerId: 'w1', devices: [], lastReportAt: new Date().toISOString(), stale: false },
        { workerId: 'w2', devices: [], lastReportAt: new Date().toISOString(), stale: false },
      ]);

      await service.tick();

      expect(mocks.redis.publish).toHaveBeenCalledWith(
        CHANNEL,
        expect.stringContaining(ClusterEventType.WORKER_MEMORY_UPDATED),
      );
      const call = mocks.redis.publish.mock.calls.find((c: string[]) =>
        c[1].includes(ClusterEventType.WORKER_MEMORY_UPDATED),
      )!;
      const event = JSON.parse(call[1] as string) as ClusterEvent;
      expect(event.data!.workerCount).toBe(2);
    });

    it('does not publish WORKER_MEMORY_UPDATED when no budgets exist', async () => {
      mocks.workerPool.getAllWorkers.mockReturnValue([]);
      mocks.memoryBudget.getAllBudgets.mockReturnValue([]);

      await service.tick();

      const memoryCalls = mocks.redis.publish.mock.calls.filter((c: string[]) =>
        c[1].includes(ClusterEventType.WORKER_MEMORY_UPDATED),
      );
      expect(memoryCalls).toHaveLength(0);
    });

    it('continues reconciliation when redis.publish fails', async () => {
      mocks.workerPool.getAllWorkers
        .mockReturnValueOnce([])
        .mockReturnValue([makeWorker({ workerId: 'w1', status: WorkerStatus.ONLINE })]);
      mocks.redis.publish.mockRejectedValue(new Error('publish failed'));

      await service.tick();

      expect(mocks.memoryBudget.refreshAll).toHaveBeenCalledOnce();
      expect(mocks.lifecycle.getAllStates).toHaveBeenCalled();
    });
  });

  describe('start / stop', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      service.stop();
      vi.useRealTimers();
    });

    it('start creates an interval that fires tick', async () => {
      service.start();
      expect(mocks.workerPool.discoverWorkers).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(30_000);
      expect(mocks.workerPool.discoverWorkers).toHaveBeenCalledOnce();
    });

    it('stop clears the interval', async () => {
      service.start();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(mocks.workerPool.discoverWorkers).toHaveBeenCalledOnce();

      service.stop();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(mocks.workerPool.discoverWorkers).toHaveBeenCalledOnce();
    });

    it('start is idempotent', () => {
      service.start();
      service.start();

      expect(mocks.logger.info).toHaveBeenCalledTimes(1);
    });
  });
});
