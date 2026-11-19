import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { ClusterEventType, DeviceType, RunnerProcessState } from '@sardeenz/types';

import { canConnect, createHarness, type TestHarness } from './helpers/harness.js';
import { createMockRunner, type MockRunnerServer } from './helpers/mock-runner.js';
import { createMockWorker, type MockWorkerServer } from './helpers/mock-worker.js';
import { ReconciliationService, type ReconciliationConfig } from '../../services/reconciliation.js';
import { WorkerClient } from '../../clients/worker.js';
import { redisKey } from '../../clients/redis.js';
import type { ControlPlaneComponents } from '@sardeenz/types';

type ClusterEvent = ControlPlaneComponents['schemas']['ClusterEvent'];

const AVAILABLE = await canConnect();

// Mirrors the unit-test DEFAULT_CONFIG: the reverse sweep is always on, so nothing here is opt-in
// beyond test duration and the delegate interval.
const CONFIG: ReconciliationConfig = {
  reconciliationIntervalSecs: 30,
  deployTimeoutSecs: 600,
  sleepTimeoutSecs: 300,
  missingRunnerProbeGraceSecs: 600,
  poolPressureEnabled: false,
  poolPressureThresholdPercent: 90,
  poolPressureReleaseTargetPercent: 75,
  poolPressureDebounceTicks: 3,
  evictionMaxPerCycle: 3,
};

/**
 * #286 end-to-end: a worker hosts a runner whose instance record the control plane lost. The
 * reverse sweep must see it through the real `GET /runners` contract and stop it — over real HTTP,
 * against real Redis/Postgres — only after a second consecutive observation.
 */
describe.skipIf(!AVAILABLE)('Reconciliation — unclaimed runner sweep integration (#286)', () => {
  const WORKER_ID = 'w-sweep';
  const MODEL = 'sweep-model';
  const LIVE_INSTANCE = 'inst-sweep-live';
  const LEAKED_INSTANCE = 'inst-sweep-leaked';

  let harness: TestHarness;
  let runner: MockRunnerServer;
  let worker: MockWorkerServer;

  beforeAll(async () => {
    runner = await createMockRunner();
    worker = await createMockWorker(runner);
  });

  afterAll(async () => {
    await worker.close();
    await runner.close();
  });

  beforeEach(async () => {
    harness = createHarness();
    await harness.setup();
    worker.stopRequests.length = 0;
    worker.setListedRunners([]);
  });

  afterEach(async () => {
    await harness?.teardown();
  });

  /** Seed one model row plus the given instance records on the mock worker. */
  async function seedInstances(instanceIds: string[]): Promise<void> {
    await harness.registerWorker({
      workerId: WORKER_ID,
      managementUrl: worker.url,
      devices: [{ deviceIndex: 0, deviceType: DeviceType.CUDA, memoryTotalBytes: 16_000_000_000 }],
    });
    await harness.modelRepository.create({
      name: MODEL,
      runnerType: 'vllm',
      modelPath: '/models/sweep',
      requiredMemory: 1_000_000_000,
      deviceType: 'CUDA',
    });
    for (const instanceId of instanceIds) {
      await harness.lifecycle.createInstance(MODEL, instanceId, WORKER_ID);
    }
  }

  function buildService(): ReconciliationService {
    return new ReconciliationService(
      harness.lifecycle,
      harness.workerPool,
      harness.memoryBudget,
      harness.routingMap,
      { isLeader: true },
      CONFIG,
      { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      harness.redis,
      harness.keyPrefix,
      undefined,
      harness.instanceRepository,
      harness.modelRepository,
      (baseUrl: string) => new WorkerClient({ baseUrl, timeoutMs: 5000 }),
    );
  }

  it('stops a runner whose instance record was deleted behind the control plane, on the second tick', async () => {
    await seedInstances([LIVE_INSTANCE]);
    worker.setListedRunners([
      {
        runnerId: 'runner-live',
        instanceId: LIVE_INSTANCE,
        modelName: MODEL,
        state: RunnerProcessState.READY,
        host: '127.0.0.1',
        port: 8000,
        enginePort: 8001,
      },
      {
        runnerId: 'runner-leaked',
        instanceId: LEAKED_INSTANCE,
        modelName: MODEL,
        state: RunnerProcessState.READY,
        host: '127.0.0.1',
        port: 8002,
        enginePort: 8003,
      },
    ]);

    const events: ClusterEvent[] = [];
    const unsubscribe = await harness.subscribeClusterEvents((event) => events.push(event));
    try {
      const service = buildService();

      await service.tick();
      expect(worker.stopRequests).toEqual([]);

      await service.tick();
      // Only the runner without a record is stopped; the claimed one keeps serving.
      expect(worker.stopRequests).toEqual(['runner-leaked']);

      const orphanEvents = events.filter((e) => e.type === ClusterEventType.RUNNER_ORPHANED);
      expect(orphanEvents).toHaveLength(1);
      expect(orphanEvents[0]).toMatchObject({
        workerId: WORKER_ID,
        modelName: MODEL,
        data: { runnerId: 'runner-leaked', instanceId: LEAKED_INSTANCE, reason: 'unclaimed' },
      });
    } finally {
      await unsubscribe();
    }

    // The sweep only ever touches the runner process — the surviving record is intact.
    expect(await harness.lifecycle.getInstance(MODEL, LIVE_INSTANCE)).not.toBeNull();
  });

  it('refuses to reap anything when the control plane holds no instance records at all', async () => {
    // The #241 signature: Redis state is gone (simulated by dropping the instance keys).
    await seedInstances([LIVE_INSTANCE]);
    await harness.redis.del(redisKey(harness.keyPrefix, 'models', MODEL, LIVE_INSTANCE));
    worker.setListedRunners([
      {
        runnerId: 'runner-a',
        instanceId: 'inst-a',
        modelName: MODEL,
        state: RunnerProcessState.READY,
        host: '127.0.0.1',
        port: 8000,
        enginePort: 8001,
      },
      {
        runnerId: 'runner-b',
        instanceId: 'inst-b',
        modelName: MODEL,
        state: RunnerProcessState.READY,
        host: '127.0.0.1',
        port: 8002,
        enginePort: 8003,
      },
    ]);

    const events: ClusterEvent[] = [];
    const unsubscribe = await harness.subscribeClusterEvents((event) => events.push(event));
    try {
      const service = buildService();

      await service.tick();
      await service.tick();

      expect(worker.stopRequests).toEqual([]);
      const orphanEvents = events.filter((e) => e.type === ClusterEventType.RUNNER_ORPHANED);
      // One refusal per worker per divergence episode, not per tick: the second refused tick
      // recounts `action: 'refused'` but must not repeat the red row.
      expect(orphanEvents).toHaveLength(1);
      for (const event of orphanEvents) {
        expect(event.data).toMatchObject({ reason: 'mass-divergence' });
      }
    } finally {
      await unsubscribe();
    }
  });

  it('publishes the record-dropped event for a forced teardown, over the harness publisher', async () => {
    await seedInstances([LIVE_INSTANCE]);

    const events: ClusterEvent[] = [];
    const unsubscribe = await harness.subscribeClusterEvents((event) => events.push(event));
    try {
      // A forced stop drops a record that still claims a worker: the dashboard's Recent events
      // must show it, which only holds if the harness wires the same publisher production does.
      await harness.lifecycle.removeInstance(MODEL, LIVE_INSTANCE, 'operator-forced');

      await vi.waitFor(() => {
        expect(events.filter((e) => e.type === ClusterEventType.RUNNER_ORPHANED)).toHaveLength(1);
      });
      const [event] = events.filter((e) => e.type === ClusterEventType.RUNNER_ORPHANED);
      expect(event).toMatchObject({
        type: ClusterEventType.RUNNER_ORPHANED,
        modelName: MODEL,
        workerId: WORKER_ID,
        data: {
          instanceId: LIVE_INSTANCE,
          disposition: 'operator-forced',
          reason: 'record-dropped',
        },
      });
      expect(await harness.lifecycle.getInstance(MODEL, LIVE_INSTANCE)).toBeNull();
    } finally {
      await unsubscribe();
    }
  });
});
