import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ClusterEventType, ModelLifecycleState, WorkerStatus } from '@sardeenz/types';
import type { ControlPlaneComponents } from '@sardeenz/types';

import { ReconciliationService } from '../reconciliation.js';
import type { ReconciliationConfig } from '../reconciliation.js';
import type { ModelLifecycleService, InstanceState } from '../model-lifecycle.js';
import type { WorkerPoolService, WorkerRecord } from '../worker-pool.js';
import type { MemoryBudgetService } from '../memory-budget.js';
import type { RoutingMapService } from '../routing-map.js';
import type { ModelRepository, ModelRecord } from '../model-repository.js';
import type { Redis } from '../../clients/redis.js';
import { deviceMemoryBytes } from '../../health/metrics.js';
import { WorkerHttpError, type WorkerClient } from '../../clients/worker.js';

type ClusterEvent = ControlPlaneComponents['schemas']['ClusterEvent'];

function makeModelState(overrides: Partial<InstanceState> & { modelName: string }): InstanceState {
  return {
    instanceId: `inst-${overrides.modelName}`,
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
    managementUrl: 'http://dead-worker:9100',
    ...overrides,
  };
}

interface MockDeps {
  lifecycle: {
    getAllInstances: ReturnType<typeof vi.fn>;
    getInstancesForModel: ReturnType<typeof vi.fn>;
    removeInstance: ReturnType<typeof vi.fn>;
    transition: ReturnType<typeof vi.fn>;
    pruneLegacyInstanceKeys: ReturnType<typeof vi.fn>;
  };
  workerPool: {
    discoverWorkers: ReturnType<typeof vi.fn>;
    checkHeartbeats: ReturnType<typeof vi.fn>;
    getDeadWorkers: ReturnType<typeof vi.fn>;
    getAllWorkers: ReturnType<typeof vi.fn>;
    removeWorker: ReturnType<typeof vi.fn>;
    getWorker: ReturnType<typeof vi.fn>;
  };
  memoryBudget: {
    refreshAll: ReturnType<typeof vi.fn>;
    getAllBudgets: ReturnType<typeof vi.fn>;
    clearWorkerReservations: ReturnType<typeof vi.fn>;
    releaseInstanceReservations: ReturnType<typeof vi.fn>;
  };
  routingMap: {
    removeModel: ReturnType<typeof vi.fn>;
    removeEndpoint: ReturnType<typeof vi.fn>;
    setModelState: ReturnType<typeof vi.fn>;
  };
  leaderElection: {
    isLeader: boolean;
  };
  logger: {
    debug: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
  redis: {
    publish: ReturnType<typeof vi.fn>;
  };
  modelRepository: {
    findAll: ReturnType<typeof vi.fn>;
    findByName: ReturnType<typeof vi.fn>;
  };
  workerClient: {
    stopRunner: ReturnType<typeof vi.fn>;
    getRunner: ReturnType<typeof vi.fn>;
    getRunnerByInstance: ReturnType<typeof vi.fn>;
  };
}

function makeModelRecord(overrides: Partial<ModelRecord> & { name: string }): ModelRecord {
  return {
    id: `rec-${overrides.name}`,
    runnerType: 'vllm',
    modelPath: '/weights/x',
    requiredMemory: null,
    deviceType: null,
    tensorParallel: 1,
    engineConfig: null,
    engineArgs: null,
    runtimeModule: null,
    servedModelName: null,
    displayName: null,
    pinned: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

const DEFAULT_CONFIG: ReconciliationConfig = {
  reconciliationIntervalSecs: 30,
  deployTimeoutSecs: 600,
  sleepTimeoutSecs: 300,
  missingRunnerProbeGraceSecs: 600,
};

const KEY_PREFIX = 'sardeenz';

function createMocks(): MockDeps {
  return {
    lifecycle: {
      getAllInstances: vi.fn().mockResolvedValue([]),
      // refreshModelRoutingState (called by handleDeadWorkers/recoverStuckInstances after
      // removing the affected instance's endpoint) resolves the model-level routing aggregate
      // from this. Default: no other instances remain, so it drives routingMap.removeModel —
      // matching the pre-#120 single-instance-per-model behavior these tests assert on.
      getInstancesForModel: vi.fn().mockResolvedValue([]),
      removeInstance: vi.fn().mockResolvedValue(undefined),
      transition: vi.fn().mockResolvedValue({}),
      pruneLegacyInstanceKeys: vi.fn().mockResolvedValue([]),
    },
    workerPool: {
      discoverWorkers: vi.fn().mockResolvedValue(undefined),
      checkHeartbeats: vi.fn().mockResolvedValue(undefined),
      getDeadWorkers: vi.fn().mockReturnValue([]),
      getAllWorkers: vi.fn().mockReturnValue([]),
      removeWorker: vi.fn(),
      // Defaults to "no worker" — matches the pre-#157-round-3 orphan-reap tests, none of which
      // set a runnerId on their fixtures (see makeModelState's default `runnerId: null` below),
      // so the new reap-attempt branch never engages unless a test opts in explicitly.
      getWorker: vi.fn().mockReturnValue(null),
    },
    memoryBudget: {
      refreshAll: vi.fn().mockResolvedValue(undefined),
      getAllBudgets: vi.fn().mockReturnValue([]),
      clearWorkerReservations: vi.fn(),
      releaseInstanceReservations: vi.fn(),
    },
    routingMap: {
      removeModel: vi.fn().mockResolvedValue(undefined),
      removeEndpoint: vi.fn().mockResolvedValue(undefined),
      setModelState: vi.fn().mockResolvedValue(undefined),
    },
    leaderElection: {
      isLeader: true,
    },
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    redis: {
      publish: vi.fn().mockResolvedValue(1),
    },
    modelRepository: {
      findAll: vi.fn().mockResolvedValue([]),
      // Defaults to "no row" so existing reap-path tests (which only set up findAll) still reap;
      // tests exercising the race set this explicitly.
      findByName: vi.fn().mockResolvedValue(null),
    },
    workerClient: {
      stopRunner: vi.fn().mockResolvedValue(undefined),
      // Default "runner present" — the missing-runner step is a no-op for existing tests that
      // never wire createWorkerClient, and safe for the new tests that don't set it explicitly.
      getRunner: vi.fn().mockResolvedValue(true),
      getRunnerByInstance: vi.fn().mockResolvedValue({ status: 'absent' }),
    },
  };
}

function createService(
  mocks: MockDeps,
  options: {
    withModelRepository?: boolean;
    withWorkerClient?: boolean;
    config?: ReconciliationConfig;
  } = {},
): ReconciliationService {
  return new ReconciliationService(
    mocks.lifecycle as unknown as ModelLifecycleService,
    mocks.workerPool as unknown as WorkerPoolService,
    mocks.memoryBudget as unknown as MemoryBudgetService,
    mocks.routingMap as unknown as RoutingMapService,
    mocks.leaderElection,
    options.config ?? DEFAULT_CONFIG,
    mocks.logger,
    mocks.redis as unknown as Redis,
    KEY_PREFIX,
    undefined,
    undefined,
    // Left undefined by default (matching notifications/instanceRepository's optionality above)
    // so the many pre-existing tests in this file — which populate getAllInstances with
    // instances but never set up modelRepository — aren't affected by the new orphan-reap step.
    // Only the dedicated describe block below opts in.
    options.withModelRepository ? (mocks.modelRepository as unknown as ModelRepository) : undefined,
    // Same rationale — only the round-3 reap-attempt tests opt in.
    options.withWorkerClient ? () => mocks.workerClient as unknown as WorkerClient : undefined,
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
      expect(mocks.lifecycle.getAllInstances).not.toHaveBeenCalled();
    });

    it('runs all steps when leader', async () => {
      await service.tick();

      expect(mocks.workerPool.discoverWorkers).toHaveBeenCalledOnce();
      expect(mocks.workerPool.checkHeartbeats).toHaveBeenCalledOnce();
      expect(mocks.workerPool.getDeadWorkers).toHaveBeenCalledOnce();
      expect(mocks.memoryBudget.refreshAll).toHaveBeenCalledOnce();
      expect(mocks.lifecycle.getAllInstances).toHaveBeenCalled();
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
      mocks.lifecycle.getAllInstances.mockResolvedValue([
        makeModelState({
          modelName: 'model-a',
          workerId: 'w1',
          state: ModelLifecycleState.ACTIVE,
        }),
      ]);

      await service.tick();

      expect(mocks.lifecycle.transition).toHaveBeenCalledWith(
        'model-a',
        'inst-model-a',
        ModelLifecycleState.ERROR,
        { errorMessage: 'Worker w1 is dead' },
      );
    });

    it('removes routing for dead worker models', async () => {
      mocks.workerPool.getDeadWorkers.mockReturnValue([makeWorker({ workerId: 'w1' })]);
      mocks.lifecycle.getAllInstances.mockResolvedValue([
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
      mocks.lifecycle.getAllInstances.mockResolvedValue([]);

      await service.tick();

      expect(mocks.workerPool.removeWorker).toHaveBeenCalledWith('w1');
    });

    it('clears VRAM reservations for dead workers so their capacity is not leaked (#87)', async () => {
      mocks.workerPool.getDeadWorkers.mockReturnValue([makeWorker({ workerId: 'w1' })]);
      mocks.lifecycle.getAllInstances.mockResolvedValue([]);

      await service.tick();

      expect(mocks.memoryBudget.clearWorkerReservations).toHaveBeenCalledWith('w1');
    });

    it('skips models in STOPPED or ERROR state on dead workers', async () => {
      mocks.workerPool.getDeadWorkers.mockReturnValue([makeWorker({ workerId: 'w1' })]);
      mocks.lifecycle.getAllInstances.mockResolvedValue([
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
      mocks.lifecycle.getAllInstances.mockResolvedValue([
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
      mocks.lifecycle.getAllInstances.mockResolvedValue([
        makeModelState({
          modelName: 'stuck-starting',
          state: ModelLifecycleState.STARTING,
          stateChangedAt: new Date(Date.now() - 700_000).toISOString(),
        }),
      ]);

      await service.tick();

      expect(mocks.lifecycle.transition).toHaveBeenCalledWith(
        'stuck-starting',
        'inst-stuck-starting',
        ModelLifecycleState.ERROR,
        expect.objectContaining({
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          errorMessage: expect.stringContaining('Stuck in STARTING'),
        }),
      );
      expect(mocks.routingMap.removeModel).toHaveBeenCalledWith('stuck-starting');
    });

    it('transitions DRAINING models stuck past sleepTimeoutSecs to ERROR', async () => {
      mocks.lifecycle.getAllInstances.mockResolvedValue([
        makeModelState({
          modelName: 'stuck-draining',
          state: ModelLifecycleState.DRAINING,
          stateChangedAt: new Date(Date.now() - 400_000).toISOString(),
        }),
      ]);

      await service.tick();

      expect(mocks.lifecycle.transition).toHaveBeenCalledWith(
        'stuck-draining',
        'inst-stuck-draining',
        ModelLifecycleState.ERROR,
        expect.objectContaining({
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          errorMessage: expect.stringContaining('Stuck in DRAINING'),
        }),
      );
    });

    it('transitions STOPPING models stuck past sleepTimeoutSecs to ERROR', async () => {
      mocks.lifecycle.getAllInstances.mockResolvedValue([
        makeModelState({
          modelName: 'stuck-stopping',
          state: ModelLifecycleState.STOPPING,
          stateChangedAt: new Date(Date.now() - 400_000).toISOString(),
        }),
      ]);

      await service.tick();

      expect(mocks.lifecycle.transition).toHaveBeenCalledWith(
        'stuck-stopping',
        'inst-stuck-stopping',
        ModelLifecycleState.ERROR,
        expect.objectContaining({
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          errorMessage: expect.stringContaining('Stuck in STOPPING'),
        }),
      );
    });

    it('does not touch models within their timeout window', async () => {
      mocks.lifecycle.getAllInstances.mockResolvedValue([
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
      mocks.lifecycle.getAllInstances.mockResolvedValue([
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

  describe('tick — missing-runner reconciliation (#166)', () => {
    // A live (ONLINE) worker record — this step only probes workers the pool still reports as
    // present; OFFLINE/unknown workers belong to the dead-worker path.
    const liveWorker = makeWorker({
      workerId: 'w1',
      status: WorkerStatus.ONLINE,
      managementUrl: 'http://w1:9000',
    });

    it('is a no-op when createWorkerClient is not wired', async () => {
      const unwired = createService(mocks);
      mocks.lifecycle.getAllInstances.mockResolvedValue([
        makeModelState({
          modelName: 'ghost-model',
          workerId: 'w1',
          runnerId: 'runner-ghost',
        }),
      ]);
      mocks.workerPool.getWorker.mockReturnValue(liveWorker);
      mocks.workerClient.getRunner.mockResolvedValue(false);

      await unwired.tick();

      expect(mocks.workerClient.getRunner).not.toHaveBeenCalled();
      expect(mocks.lifecycle.transition).not.toHaveBeenCalled();
      expect(mocks.lifecycle.removeInstance).not.toHaveBeenCalled();
    });

    it('reaps an ACTIVE instance whose runner the (live) worker no longer hosts', async () => {
      mocks.lifecycle.getAllInstances.mockResolvedValue([
        makeModelState({
          modelName: 'ghost-model',
          workerId: 'w1',
          runnerId: 'runner-ghost',
          runnerHost: 'w1',
          runnerPort: 8000,
        }),
      ]);
      mocks.workerPool.getWorker.mockReturnValue(liveWorker);
      mocks.workerClient.getRunner.mockResolvedValue(false);
      const probeService = createService(mocks, { withWorkerClient: true });

      await probeService.tick();

      expect(mocks.workerClient.getRunner).toHaveBeenCalledWith('runner-ghost');
      expect(mocks.lifecycle.transition).toHaveBeenCalledWith(
        'ghost-model',
        'inst-ghost-model',
        ModelLifecycleState.ERROR,
        expect.objectContaining({
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          errorMessage: expect.stringContaining('runner-ghost'),
        }),
      );
      expect(mocks.routingMap.removeEndpoint).toHaveBeenCalledWith('ghost-model', 'w1', 8000);
      expect(mocks.lifecycle.removeInstance).toHaveBeenCalledWith(
        'ghost-model',
        'inst-ghost-model',
      );
      expect(mocks.memoryBudget.releaseInstanceReservations).toHaveBeenCalledWith(
        'inst-ghost-model',
      );
    });

    it('does not touch an instance whose runner is still present on the worker', async () => {
      mocks.lifecycle.getAllInstances.mockResolvedValue([
        makeModelState({
          modelName: 'healthy-model',
          workerId: 'w1',
          runnerId: 'runner-healthy',
        }),
      ]);
      mocks.workerPool.getWorker.mockReturnValue(liveWorker);
      mocks.workerClient.getRunner.mockResolvedValue(true);
      const probeService = createService(mocks, { withWorkerClient: true });

      await probeService.tick();

      expect(mocks.workerClient.getRunner).toHaveBeenCalledWith('runner-healthy');
      expect(mocks.lifecycle.transition).not.toHaveBeenCalled();
      expect(mocks.lifecycle.removeInstance).not.toHaveBeenCalled();
    });

    it('never probes instances on OFFLINE workers — that is the dead-worker path', async () => {
      mocks.lifecycle.getAllInstances.mockResolvedValue([
        makeModelState({
          modelName: 'offline-model',
          workerId: 'w1',
          runnerId: 'runner-x',
        }),
      ]);
      mocks.workerPool.getWorker.mockReturnValue(
        makeWorker({ workerId: 'w1', status: WorkerStatus.OFFLINE }),
      );
      const probeService = createService(mocks, { withWorkerClient: true });

      await probeService.tick();

      expect(mocks.workerClient.getRunner).not.toHaveBeenCalled();
      expect(mocks.lifecycle.removeInstance).not.toHaveBeenCalled();
    });

    it('skips instances without a runnerId (startRunner not returned yet)', async () => {
      mocks.lifecycle.getAllInstances.mockResolvedValue([
        makeModelState({ modelName: 'no-runner-id', workerId: 'w1', runnerId: null }),
      ]);
      mocks.workerPool.getWorker.mockReturnValue(liveWorker);
      const probeService = createService(mocks, { withWorkerClient: true });

      await probeService.tick();

      expect(mocks.workerClient.getRunner).not.toHaveBeenCalled();
      expect(mocks.lifecycle.removeInstance).not.toHaveBeenCalled();
    });

    it('does not probe a fresh STARTING instance within the probe-grace window', async () => {
      // deployTimeoutSecs (600) > grace (60), so a 30s-old STARTING is NOT reaped by
      // recoverStuckInstances — the only path that could touch it is the probe, which must
      // respect its own grace window (30s <= 60s → skip).
      const probeService = createService(mocks, {
        withWorkerClient: true,
        config: { ...DEFAULT_CONFIG, missingRunnerProbeGraceSecs: 60 },
      });
      mocks.lifecycle.getAllInstances.mockResolvedValue([
        makeModelState({
          modelName: 'cold-start',
          state: ModelLifecycleState.STARTING,
          workerId: 'w1',
          runnerId: 'runner-cold',
          stateChangedAt: new Date(Date.now() - 30_000).toISOString(),
        }),
      ]);
      mocks.workerPool.getWorker.mockReturnValue(liveWorker);
      mocks.workerClient.getRunner.mockResolvedValue(false);

      await probeService.tick();

      expect(mocks.workerClient.getRunner).not.toHaveBeenCalled();
      expect(mocks.lifecycle.transition).not.toHaveBeenCalled();
      expect(mocks.lifecycle.removeInstance).not.toHaveBeenCalled();
    });

    it('probes and reaps a STARTING instance past the grace window when its runner is absent', async () => {
      const probeService = createService(mocks, {
        withWorkerClient: true,
        config: { ...DEFAULT_CONFIG, missingRunnerProbeGraceSecs: 60 },
      });
      mocks.lifecycle.getAllInstances.mockResolvedValue([
        makeModelState({
          modelName: 'stale-starting',
          state: ModelLifecycleState.STARTING,
          workerId: 'w1',
          runnerId: 'runner-stale',
          stateChangedAt: new Date(Date.now() - 120_000).toISOString(),
        }),
      ]);
      mocks.workerPool.getWorker.mockReturnValue(liveWorker);
      mocks.workerClient.getRunner.mockResolvedValue(false);

      await probeService.tick();

      expect(mocks.workerClient.getRunner).toHaveBeenCalledWith('runner-stale');
      expect(mocks.lifecycle.removeInstance).toHaveBeenCalledWith(
        'stale-starting',
        'inst-stale-starting',
      );
    });

    it('treats a failed probe as inconclusive — skips the reap and retries next tick', async () => {
      mocks.lifecycle.getAllInstances.mockResolvedValue([
        makeModelState({
          modelName: 'flaky-model',
          workerId: 'w1',
          runnerId: 'runner-flaky',
        }),
      ]);
      mocks.workerPool.getWorker.mockReturnValue(liveWorker);
      mocks.workerClient.getRunner.mockRejectedValue(new Error('connect ECONNREFUSED'));
      const probeService = createService(mocks, { withWorkerClient: true });

      await probeService.tick();

      expect(mocks.lifecycle.transition).not.toHaveBeenCalled();
      expect(mocks.lifecycle.removeInstance).not.toHaveBeenCalled();
      expect(mocks.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ modelName: 'flaky-model', instanceId: 'inst-flaky-model' }),
        'Runner liveness probe failed — skipping reap, will retry next tick',
      );
    });
  });

  describe('tick — ambiguous runner-start recovery (#146)', () => {
    const liveWorker = makeWorker({
      workerId: 'w1',
      status: WorkerStatus.ONLINE,
      managementUrl: 'http://w1:9000',
    });

    function ambiguous(ageMs: number): InstanceState {
      return makeModelState({
        modelName: 'ambiguous-start',
        state: ModelLifecycleState.ERROR,
        workerId: 'w1',
        runnerId: null,
        runnerStartAmbiguous: true,
        stateChangedAt: new Date(Date.now() - ageMs).toISOString(),
      });
    }

    it('stops a recovered live runner and releases its retained capacity after the grace', async () => {
      mocks.lifecycle.getAllInstances.mockResolvedValue([ambiguous(120_000)]);
      mocks.workerPool.getWorker.mockReturnValue(liveWorker);
      mocks.workerClient.getRunnerByInstance.mockResolvedValue({
        status: 'ready',
        runnerId: 'runner-recovered',
        host: 'w1',
        port: 8000,
        enginePort: 8001,
      });
      const recovering = createService(mocks, {
        withWorkerClient: true,
        config: { ...DEFAULT_CONFIG, missingRunnerProbeGraceSecs: 60 },
      });

      await recovering.tick();

      expect(mocks.workerClient.getRunnerByInstance).toHaveBeenCalledWith('inst-ambiguous-start');
      expect(mocks.workerClient.stopRunner).toHaveBeenCalledWith('runner-recovered');
      expect(mocks.lifecycle.removeInstance).toHaveBeenCalledWith(
        'ambiguous-start',
        'inst-ambiguous-start',
      );
      expect(mocks.memoryBudget.releaseInstanceReservations).toHaveBeenCalledWith(
        'inst-ambiguous-start',
      );
    });

    it('retains an in-flight runner start for a later reconciliation tick', async () => {
      mocks.lifecycle.getAllInstances.mockResolvedValue([ambiguous(120_000)]);
      mocks.workerPool.getWorker.mockReturnValue(liveWorker);
      mocks.workerClient.getRunnerByInstance.mockResolvedValue({
        status: 'starting',
        runnerId: 'runner-starting',
      });
      const recovering = createService(mocks, {
        withWorkerClient: true,
        config: { ...DEFAULT_CONFIG, missingRunnerProbeGraceSecs: 60 },
      });

      await recovering.tick();

      expect(mocks.lifecycle.removeInstance).not.toHaveBeenCalled();
      expect(mocks.memoryBudget.releaseInstanceReservations).not.toHaveBeenCalled();
    });

    it('probes early but does not treat a 404 as proof that a dispatched start cannot still arrive', async () => {
      mocks.lifecycle.getAllInstances.mockResolvedValue([ambiguous(30_000)]);
      mocks.workerPool.getWorker.mockReturnValue(liveWorker);
      const recovering = createService(mocks, {
        withWorkerClient: true,
        config: { ...DEFAULT_CONFIG, missingRunnerProbeGraceSecs: 60 },
      });

      await recovering.tick();

      expect(mocks.workerClient.getRunnerByInstance).toHaveBeenCalledWith('inst-ambiguous-start');
      expect(mocks.lifecycle.removeInstance).not.toHaveBeenCalled();
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

      expect(mocks.lifecycle.getAllInstances).toHaveBeenCalled();
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

  describe('tick — legacy Redis key pruning (boundary review MEDIUM-1 / LOW-1)', () => {
    it('calls pruneLegacyInstanceKeys on the first tick', async () => {
      await service.tick();

      expect(mocks.lifecycle.pruneLegacyInstanceKeys).toHaveBeenCalledOnce();
    });

    it('does not call pruneLegacyInstanceKeys again on a second tick (round-2 LOW-1)', async () => {
      await service.tick();
      await service.tick();

      expect(mocks.lifecycle.pruneLegacyInstanceKeys).toHaveBeenCalledOnce();
    });

    it('logs once per legacy key removed', async () => {
      mocks.lifecycle.pruneLegacyInstanceKeys.mockResolvedValue(['legacy-a', 'legacy-b']);

      await service.tick();

      expect(mocks.logger.warn).toHaveBeenCalledWith(
        { modelName: 'legacy-a' },
        'Removed orphaned pre-#120 Redis lifecycle key (single-segment, no instanceId) — see ADR-019',
      );
      expect(mocks.logger.warn).toHaveBeenCalledWith(
        { modelName: 'legacy-b' },
        'Removed orphaned pre-#120 Redis lifecycle key (single-segment, no instanceId) — see ADR-019',
      );
    });

    it('does not log anything when there are no legacy keys', async () => {
      await service.tick();

      expect(mocks.logger.warn).not.toHaveBeenCalledWith(
        expect.objectContaining({ modelName: expect.anything() as string }),
        expect.stringContaining('orphaned') as string,
      );
    });

    it('a pruneLegacyInstanceKeys failure does not abort the rest of the tick', async () => {
      mocks.lifecycle.pruneLegacyInstanceKeys.mockRejectedValue(new Error('scan failed'));

      await service.tick();

      expect(mocks.memoryBudget.refreshAll).toHaveBeenCalledOnce();
      expect(mocks.logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ step: 'pruneLegacyInstanceKeys', err: 'scan failed' }),
        'Reconciliation step failed',
      );
    });
  });

  describe('tick — orphaned instance reaping (boundary review round-2 MEDIUM-2)', () => {
    it('reaps a Redis instance whose model has no Postgres row', async () => {
      mocks.lifecycle.getAllInstances.mockResolvedValue([
        makeModelState({
          modelName: 'deleted-model',
          instanceId: 'inst-orphan',
          state: ModelLifecycleState.ERROR,
          runnerHost: 'worker-1',
          runnerPort: 8000,
        }),
      ]);
      mocks.modelRepository.findAll.mockResolvedValue([]);
      const orphanService = createService(mocks, { withModelRepository: true });

      await orphanService.tick();

      expect(mocks.memoryBudget.releaseInstanceReservations).toHaveBeenCalledWith('inst-orphan');
      expect(mocks.routingMap.removeEndpoint).toHaveBeenCalledWith(
        'deleted-model',
        'worker-1',
        8000,
      );
      expect(mocks.lifecycle.removeInstance).toHaveBeenCalledWith('deleted-model', 'inst-orphan');
      expect(mocks.logger.info).toHaveBeenCalledWith(
        { modelName: 'deleted-model', instanceId: 'inst-orphan' },
        'Reaped orphaned Redis instance with no matching model row',
      );
    });

    it('leaves a Redis instance alone when its model still has a Postgres row', async () => {
      mocks.lifecycle.getAllInstances.mockResolvedValue([
        makeModelState({
          modelName: 'live-model',
          instanceId: 'inst-live',
          state: ModelLifecycleState.ACTIVE,
        }),
      ]);
      mocks.modelRepository.findAll.mockResolvedValue([makeModelRecord({ name: 'live-model' })]);
      const liveService = createService(mocks, { withModelRepository: true });

      await liveService.tick();

      expect(mocks.memoryBudget.releaseInstanceReservations).not.toHaveBeenCalled();
      expect(mocks.lifecycle.removeInstance).not.toHaveBeenCalled();
    });

    it('does not remove an endpoint for an orphan with no runner endpoint', async () => {
      mocks.lifecycle.getAllInstances.mockResolvedValue([
        makeModelState({
          modelName: 'deleted-model',
          instanceId: 'inst-orphan',
          state: ModelLifecycleState.ERROR,
          runnerHost: null,
          runnerPort: null,
        }),
      ]);
      mocks.modelRepository.findAll.mockResolvedValue([]);
      const orphanService = createService(mocks, { withModelRepository: true });

      await orphanService.tick();

      expect(mocks.routingMap.removeEndpoint).not.toHaveBeenCalled();
      expect(mocks.lifecycle.removeInstance).toHaveBeenCalledWith('deleted-model', 'inst-orphan');
    });

    it('is a no-op when modelRepository is not wired', async () => {
      mocks.lifecycle.getAllInstances.mockResolvedValue([
        makeModelState({ modelName: 'deleted-model', instanceId: 'inst-orphan' }),
      ]);
      const unwiredService = createService(mocks);

      await unwiredService.tick();

      expect(mocks.lifecycle.removeInstance).not.toHaveBeenCalled();
      expect(mocks.modelRepository.findAll).not.toHaveBeenCalled();
    });

    it('skips reaping when the model row appears between the initial diff and the per-candidate recheck (round-3 HIGH-1)', async () => {
      mocks.lifecycle.getAllInstances.mockResolvedValue([
        makeModelState({
          modelName: 'racing-model',
          instanceId: 'inst-racing',
          state: ModelLifecycleState.STARTING,
          runnerHost: 'worker-1',
          runnerPort: 8000,
        }),
      ]);
      // Initial diff: findAll() doesn't see the model row yet (it committed after this read's
      // snapshot but before the Redis read observed the instance) — the candidate looks orphaned.
      mocks.modelRepository.findAll.mockResolvedValue([]);
      // But the per-candidate recheck runs later and now sees the row a concurrent deploy created.
      mocks.modelRepository.findByName.mockResolvedValue(makeModelRecord({ name: 'racing-model' }));
      const orphanService = createService(mocks, { withModelRepository: true });

      await orphanService.tick();

      expect(mocks.modelRepository.findByName).toHaveBeenCalledWith('racing-model');
      expect(mocks.memoryBudget.releaseInstanceReservations).not.toHaveBeenCalled();
      expect(mocks.routingMap.removeEndpoint).not.toHaveBeenCalled();
      expect(mocks.lifecycle.removeInstance).not.toHaveBeenCalled();
      expect(mocks.logger.debug).toHaveBeenCalledWith(
        { modelName: 'racing-model', instanceId: 'inst-racing' },
        'Skipping reap: model row now exists (race with concurrent deploy)',
      );
    });

    it('still reaps a genuine orphan when the per-candidate recheck also finds no model row', async () => {
      mocks.lifecycle.getAllInstances.mockResolvedValue([
        makeModelState({
          modelName: 'deleted-model',
          instanceId: 'inst-orphan',
          state: ModelLifecycleState.ERROR,
          runnerHost: 'worker-1',
          runnerPort: 8000,
        }),
      ]);
      mocks.modelRepository.findAll.mockResolvedValue([]);
      mocks.modelRepository.findByName.mockResolvedValue(null);
      const orphanService = createService(mocks, { withModelRepository: true });

      await orphanService.tick();

      expect(mocks.modelRepository.findByName).toHaveBeenCalledWith('deleted-model');
      expect(mocks.lifecycle.removeInstance).toHaveBeenCalledWith('deleted-model', 'inst-orphan');
    });

    it('a reap failure for one orphan does not abort the rest of the tick', async () => {
      mocks.lifecycle.getAllInstances.mockResolvedValue([
        makeModelState({ modelName: 'deleted-model', instanceId: 'inst-orphan' }),
      ]);
      mocks.modelRepository.findAll.mockResolvedValue([]);
      mocks.lifecycle.removeInstance.mockRejectedValueOnce(new Error('redis down'));
      const orphanService = createService(mocks, { withModelRepository: true });

      await orphanService.tick();

      expect(mocks.memoryBudget.refreshAll).toHaveBeenCalledOnce();
      expect(mocks.logger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          modelName: 'deleted-model',
          instanceId: 'inst-orphan',
          err: 'redis down',
        }),
        'Failed to reap orphaned instance',
      );
    });

    describe('reaping the orphan runner process before dropping its record (round-3 review, Medium)', () => {
      it('resolves the worker and calls stopRunner with the runnerId before removing the record', async () => {
        mocks.lifecycle.getAllInstances.mockResolvedValue([
          makeModelState({
            modelName: 'deleted-model',
            instanceId: 'inst-orphan',
            workerId: 'w1',
            runnerId: 'runner-1',
          }),
        ]);
        mocks.modelRepository.findAll.mockResolvedValue([]);
        mocks.workerPool.getWorker.mockReturnValue(
          makeWorker({ workerId: 'w1', managementUrl: 'http://w1:9000' }),
        );
        const orphanService = createService(mocks, {
          withModelRepository: true,
          withWorkerClient: true,
        });

        await orphanService.tick();

        expect(mocks.workerPool.getWorker).toHaveBeenCalledWith('w1');
        expect(mocks.workerClient.stopRunner).toHaveBeenCalledWith('runner-1');
        expect(mocks.lifecycle.removeInstance).toHaveBeenCalledWith('deleted-model', 'inst-orphan');
      });

      it('still removes the record when stopRunner reports 404 (runner already gone)', async () => {
        mocks.lifecycle.getAllInstances.mockResolvedValue([
          makeModelState({
            modelName: 'deleted-model',
            instanceId: 'inst-orphan',
            workerId: 'w1',
            runnerId: 'runner-1',
          }),
        ]);
        mocks.modelRepository.findAll.mockResolvedValue([]);
        mocks.workerPool.getWorker.mockReturnValue(
          makeWorker({ workerId: 'w1', managementUrl: 'http://w1:9000' }),
        );
        mocks.workerClient.stopRunner.mockRejectedValueOnce(
          new WorkerHttpError('Worker DELETE /runners/runner-1 returned 404: gone', 404),
        );
        const orphanService = createService(mocks, {
          withModelRepository: true,
          withWorkerClient: true,
        });

        await orphanService.tick();

        expect(mocks.workerClient.stopRunner).toHaveBeenCalledWith('runner-1');
        expect(mocks.lifecycle.removeInstance).toHaveBeenCalledWith('deleted-model', 'inst-orphan');
      });

      it('retains the record this tick on a non-404 stopRunner failure, without affecting other orphans in the same tick', async () => {
        mocks.lifecycle.getAllInstances.mockResolvedValue([
          makeModelState({
            modelName: 'stuck-orphan',
            instanceId: 'inst-stuck',
            workerId: 'w1',
            runnerId: 'runner-stuck',
          }),
          makeModelState({
            modelName: 'clean-orphan',
            instanceId: 'inst-clean',
            workerId: null,
            runnerId: null,
          }),
        ]);
        mocks.modelRepository.findAll.mockResolvedValue([]);
        mocks.workerPool.getWorker.mockReturnValue(
          makeWorker({ workerId: 'w1', managementUrl: 'http://w1:9000' }),
        );
        mocks.workerClient.stopRunner.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
        const orphanService = createService(mocks, {
          withModelRepository: true,
          withWorkerClient: true,
        });

        await orphanService.tick();

        expect(mocks.workerClient.stopRunner).toHaveBeenCalledWith('runner-stuck');
        // Reap failed — the whole cleanup for this orphan is skipped, not just removeInstance, so
        // a later tick redoes it cleanly rather than double-releasing budget/routing.
        expect(mocks.memoryBudget.releaseInstanceReservations).not.toHaveBeenCalledWith(
          'inst-stuck',
        );
        expect(mocks.lifecycle.removeInstance).not.toHaveBeenCalledWith(
          'stuck-orphan',
          'inst-stuck',
        );
        expect(mocks.logger.warn).toHaveBeenCalledWith(
          expect.objectContaining({ modelName: 'stuck-orphan', instanceId: 'inst-stuck' }),
          'Failed to reap orphan runner process — retaining record for retry next tick',
        );
        // Isolated per-instance: the other orphan in the same tick is still fully processed.
        expect(mocks.memoryBudget.releaseInstanceReservations).toHaveBeenCalledWith('inst-clean');
        expect(mocks.lifecycle.removeInstance).toHaveBeenCalledWith('clean-orphan', 'inst-clean');
      });

      it('removes the record without attempting stopRunner when the worker is not in the pool', async () => {
        mocks.lifecycle.getAllInstances.mockResolvedValue([
          makeModelState({
            modelName: 'deleted-model',
            instanceId: 'inst-orphan',
            workerId: 'w-gone',
            runnerId: 'runner-1',
          }),
        ]);
        mocks.modelRepository.findAll.mockResolvedValue([]);
        mocks.workerPool.getWorker.mockReturnValue(null);
        const orphanService = createService(mocks, {
          withModelRepository: true,
          withWorkerClient: true,
        });

        await orphanService.tick();

        expect(mocks.workerPool.getWorker).toHaveBeenCalledWith('w-gone');
        expect(mocks.workerClient.stopRunner).not.toHaveBeenCalled();
        expect(mocks.lifecycle.removeInstance).toHaveBeenCalledWith('deleted-model', 'inst-orphan');
        expect(mocks.logger.debug).toHaveBeenCalledWith(
          expect.objectContaining({
            modelName: 'deleted-model',
            instanceId: 'inst-orphan',
            workerId: 'w-gone',
          }),
          'Cannot reap orphan runner process; worker not in pool — dropping record anyway',
        );
      });
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
      mocks.lifecycle.getAllInstances.mockResolvedValue([]);

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
      expect(mocks.lifecycle.getAllInstances).toHaveBeenCalled();
    });
  });

  describe('tick — refreshMetrics device labels', () => {
    it('sets distinct device_index labels for each device on a worker with multiple GPUs', async () => {
      mocks.workerPool.getAllWorkers.mockReturnValue([]);
      mocks.memoryBudget.getAllBudgets.mockReturnValue([
        {
          workerId: 'w1',
          lastReportAt: new Date().toISOString(),
          stale: false,
          devices: [
            {
              deviceIndex: 0,
              deviceType: 'gpu',
              totalBytes: 16e9,
              usedBytes: 4e9,
              availableBytes: 12e9,
            },
            {
              deviceIndex: 1,
              deviceType: 'gpu',
              totalBytes: 16e9,
              usedBytes: 2e9,
              availableBytes: 14e9,
            },
          ],
        },
      ]);

      const setSpy = vi.spyOn(deviceMemoryBytes, 'set');

      await service.tick();

      expect(setSpy).toHaveBeenCalledWith(
        { worker_id: 'w1', device_index: '0', state: 'total' },
        16e9,
      );
      expect(setSpy).toHaveBeenCalledWith(
        { worker_id: 'w1', device_index: '1', state: 'total' },
        16e9,
      );
      expect(setSpy).toHaveBeenCalledWith(
        { worker_id: 'w1', device_index: '0', state: 'used' },
        4e9,
      );
      expect(setSpy).toHaveBeenCalledWith(
        { worker_id: 'w1', device_index: '1', state: 'used' },
        2e9,
      );

      setSpy.mockRestore();
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
