import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DeviceType, ModelLifecycleState, Protocol, RunnerState } from '@sardeenz/types';

import { canConnect, createHarness, type TestHarness } from './helpers/harness.js';
import { createMockRunner, type MockRunnerServer } from './helpers/mock-runner.js';
import { createMockWorker } from './helpers/mock-worker.js';
import { deriveAggregateState } from '../../services/model-lifecycle.js';

const AVAILABLE = await canConnect();

const MEM = 8_000_000_000;

/** Deploy one instance of `modelName` onto `workerId`, driving it to ACTIVE end-to-end, exactly
 * the way deployFromRecord (routes/models.ts) does it: create the Redis instance, transition to
 * STARTING, run deployOrchestration.deployModel. Mirrors deploy.integration.test.ts. */
async function deployInstance(
  harness: TestHarness,
  runner: MockRunnerServer,
  workerId: string,
  modelName: string,
  instanceId: string,
): Promise<void> {
  await harness.lifecycle.createInstance(modelName, instanceId, workerId);
  await harness.lifecycle.transition(modelName, instanceId, ModelLifecycleState.STARTING);

  runner.setHealthState(RunnerState.READY);

  await harness.deployOrchestration.deployModel({
    protocol: Protocol.openai,
    modelName,
    instanceId,
    workerId,
    runnerType: 'vllm',
    modelPath: `/models/${modelName}`,
    requiredMemory: MEM,
    tensorParallel: 1,
    devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
  });
}

describe.skipIf(!AVAILABLE)('Instances integration (#120: logical model / instance split)', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = createHarness();
    await harness.setup();
  });

  afterEach(async () => {
    await harness?.teardown();
  });

  it('second instance on a different worker: both endpoints registered and healthy (criterion 1)', async () => {
    const MODEL = 'replica-diff-worker';
    const INSTANCE_A = 'inst-diff-a';
    const INSTANCE_B = 'inst-diff-b';

    const runnerA = await createMockRunner();
    const runnerB = await createMockRunner();
    const workerA = await createMockWorker(runnerA);
    const workerB = await createMockWorker(runnerB);
    try {
      await harness.registerWorker({
        workerId: 'w-diff-a',
        managementUrl: workerA.url,
        devices: [
          { deviceIndex: 0, deviceType: DeviceType.CUDA, memoryTotalBytes: 16_000_000_000 },
        ],
      });
      await harness.registerWorker({
        workerId: 'w-diff-b',
        managementUrl: workerB.url,
        devices: [
          { deviceIndex: 0, deviceType: DeviceType.CUDA, memoryTotalBytes: 16_000_000_000 },
        ],
      });

      await harness.modelRepository.create({
        name: MODEL,
        runnerType: 'vllm',
        modelPath: `/models/${MODEL}`,
        requiredMemory: MEM,
        deviceType: 'CUDA',
      });

      await deployInstance(harness, runnerA, 'w-diff-a', MODEL, INSTANCE_A);
      await deployInstance(harness, runnerB, 'w-diff-b', MODEL, INSTANCE_B);

      const entry = await harness.routingMap.getEntry(MODEL);
      expect(entry).not.toBeNull();
      expect(entry!.endpoints).toHaveLength(2);
      expect(entry!.endpoints.every((e) => e.healthy && e.weight > 0)).toBe(true);
      const ports = entry!.endpoints.map((e) => e.port).sort();
      expect(ports).toEqual([runnerA.port, runnerB.port].sort());

      const instances = await harness.lifecycle.getInstancesForModel(MODEL);
      expect(instances).toHaveLength(2);
      expect(deriveAggregateState(instances)).toBe(ModelLifecycleState.ACTIVE);
    } finally {
      await workerA.close();
      await workerB.close();
      await runnerA.close();
      await runnerB.close();
    }
  });

  it('second instance on the SAME worker: two runners, two endpoints (worker rework proof)', async () => {
    const MODEL = 'replica-same-worker';
    const INSTANCE_A = 'inst-same-a';
    const INSTANCE_B = 'inst-same-b';
    const WORKER_ID = 'w-same';

    const runnerA = await createMockRunner();
    const runnerB = await createMockRunner();
    // One worker, backed by TWO distinct mock runners — assigns runnerA to the first POST
    // /runners and runnerB to the second, so their routing endpoints don't collide. This is what
    // actually exercises the dev-worker's modelRunners: Map<string, Set<string>> rework: the
    // pre-#120 worker would 409 the second start for the same model name.
    const worker = await createMockWorker([runnerA, runnerB]);
    try {
      await harness.registerWorker({
        workerId: WORKER_ID,
        managementUrl: worker.url,
        // Two devices so both instances' capacity reservations fit without evicting each other.
        devices: [
          { deviceIndex: 0, deviceType: DeviceType.CUDA, memoryTotalBytes: 16_000_000_000 },
          { deviceIndex: 1, deviceType: DeviceType.CUDA, memoryTotalBytes: 16_000_000_000 },
        ],
      });

      await harness.modelRepository.create({
        name: MODEL,
        runnerType: 'vllm',
        modelPath: `/models/${MODEL}`,
        requiredMemory: MEM,
        deviceType: 'CUDA',
      });

      await deployInstance(harness, runnerA, WORKER_ID, MODEL, INSTANCE_A);
      await deployInstance(harness, runnerB, WORKER_ID, MODEL, INSTANCE_B);

      expect(worker.startRequests).toHaveLength(2);
      expect(worker.startRequests[0]?.instanceId).toBe(INSTANCE_A);
      expect(worker.startRequests[1]?.instanceId).toBe(INSTANCE_B);

      const entry = await harness.routingMap.getEntry(MODEL);
      expect(entry).not.toBeNull();
      expect(entry!.endpoints).toHaveLength(2);
      const ports = entry!.endpoints.map((e) => e.port).sort();
      expect(ports).toEqual([runnerA.port, runnerB.port].sort());

      const instances = await harness.lifecycle.getInstancesForModel(MODEL);
      expect(instances).toHaveLength(2);
      expect(new Set(instances.map((i) => i.workerId))).toEqual(new Set([WORKER_ID]));
    } finally {
      await worker.close();
      await runnerA.close();
      await runnerB.close();
    }
  });

  it('independent stop: stopping one instance leaves the other serving uninterrupted (criterion 2)', async () => {
    const MODEL = 'independent-stop';
    const INSTANCE_A = 'inst-stop-a';
    const INSTANCE_B = 'inst-stop-b';

    const runnerA = await createMockRunner();
    const runnerB = await createMockRunner();
    const workerA = await createMockWorker(runnerA);
    const workerB = await createMockWorker(runnerB);
    try {
      await harness.registerWorker({
        workerId: 'w-stop-a',
        managementUrl: workerA.url,
        devices: [
          { deviceIndex: 0, deviceType: DeviceType.CUDA, memoryTotalBytes: 16_000_000_000 },
        ],
      });
      await harness.registerWorker({
        workerId: 'w-stop-b',
        managementUrl: workerB.url,
        devices: [
          { deviceIndex: 0, deviceType: DeviceType.CUDA, memoryTotalBytes: 16_000_000_000 },
        ],
      });

      await harness.modelRepository.create({
        name: MODEL,
        runnerType: 'vllm',
        modelPath: `/models/${MODEL}`,
        requiredMemory: MEM,
        deviceType: 'CUDA',
      });

      await deployInstance(harness, runnerA, 'w-stop-a', MODEL, INSTANCE_A);
      await deployInstance(harness, runnerB, 'w-stop-b', MODEL, INSTANCE_B);

      let entry = await harness.routingMap.getEntry(MODEL);
      expect(entry!.endpoints).toHaveLength(2);

      // Stop instance A only — mirrors DELETE /api/v1/models/:modelName/instances/:instanceId.
      await harness.sleepWake.stopModel(MODEL, INSTANCE_A, null);
      await harness.lifecycle.removeInstance(MODEL, INSTANCE_A);

      entry = await harness.routingMap.getEntry(MODEL);
      expect(entry).not.toBeNull();
      expect(entry!.endpoints).toHaveLength(1);
      expect(entry!.endpoints[0].port).toBe(runnerB.port);

      const remaining = await harness.lifecycle.getInstancesForModel(MODEL);
      expect(remaining).toHaveLength(1);
      expect(remaining[0].instanceId).toBe(INSTANCE_B);
      expect(deriveAggregateState(remaining)).toBe(ModelLifecycleState.ACTIVE);
    } finally {
      await workerA.close();
      await workerB.close();
      await runnerA.close();
      await runnerB.close();
    }
  });

  it('aggregate ACTIVE when one instance is ACTIVE and another is ERROR (criterion 4)', async () => {
    const MODEL = 'aggregate-active-error';
    const INSTANCE_A = 'inst-agg-a';
    const INSTANCE_B = 'inst-agg-b';

    const runnerA = await createMockRunner();
    const runnerB = await createMockRunner();
    const workerA = await createMockWorker(runnerA);
    const workerB = await createMockWorker(runnerB);
    try {
      await harness.registerWorker({
        workerId: 'w-agg-a',
        managementUrl: workerA.url,
        devices: [
          { deviceIndex: 0, deviceType: DeviceType.CUDA, memoryTotalBytes: 16_000_000_000 },
        ],
      });
      await harness.registerWorker({
        workerId: 'w-agg-b',
        managementUrl: workerB.url,
        devices: [
          { deviceIndex: 0, deviceType: DeviceType.CUDA, memoryTotalBytes: 16_000_000_000 },
        ],
      });

      await harness.modelRepository.create({
        name: MODEL,
        runnerType: 'vllm',
        modelPath: `/models/${MODEL}`,
        requiredMemory: MEM,
        deviceType: 'CUDA',
      });

      await deployInstance(harness, runnerA, 'w-agg-a', MODEL, INSTANCE_A);
      await deployInstance(harness, runnerB, 'w-agg-b', MODEL, INSTANCE_B);

      // Force instance A into ERROR directly (simulates a runner-side failure post-deploy).
      await harness.lifecycle.transition(MODEL, INSTANCE_A, ModelLifecycleState.DRAINING);
      await harness.lifecycle.transition(MODEL, INSTANCE_A, ModelLifecycleState.ERROR, {
        errorMessage: 'simulated runner crash',
      });

      const instances = await harness.lifecycle.getInstancesForModel(MODEL);
      expect(instances).toHaveLength(2);
      const byId = new Map(instances.map((i) => [i.instanceId, i.state]));
      expect(byId.get(INSTANCE_A)).toBe(ModelLifecycleState.ERROR);
      expect(byId.get(INSTANCE_B)).toBe(ModelLifecycleState.ACTIVE);

      // The logical model's aggregate state must be ACTIVE — one healthy replica masks the
      // broken one (the exact rule GET /api/v1/models and GET /api/v1/models/:name apply).
      expect(deriveAggregateState(instances)).toBe(ModelLifecycleState.ACTIVE);
    } finally {
      await workerA.close();
      await workerB.close();
      await runnerA.close();
      await runnerB.close();
    }
  });

  it(
    'scripted move: deploy new instance → shift weight to 0 → drain → remove old, zero failed requests (criterion 3)',
    { timeout: 20_000 },
    async () => {
      const MODEL = 'scripted-move';
      const INSTANCE_OLD = 'inst-move-old';
      const INSTANCE_NEW = 'inst-move-new';

      const runnerOld = await createMockRunner();
      const runnerNew = await createMockRunner();
      const workerOld = await createMockWorker(runnerOld);
      const workerNew = await createMockWorker(runnerNew);
      try {
        await harness.registerWorker({
          workerId: 'w-move-old',
          managementUrl: workerOld.url,
          devices: [
            { deviceIndex: 0, deviceType: DeviceType.CUDA, memoryTotalBytes: 16_000_000_000 },
          ],
        });
        await harness.registerWorker({
          workerId: 'w-move-new',
          managementUrl: workerNew.url,
          devices: [
            { deviceIndex: 0, deviceType: DeviceType.CUDA, memoryTotalBytes: 16_000_000_000 },
          ],
        });

        await harness.modelRepository.create({
          name: MODEL,
          runnerType: 'vllm',
          modelPath: `/models/${MODEL}`,
          requiredMemory: MEM,
          deviceType: 'CUDA',
        });

        // Step 1: deploy the old instance — it alone serves.
        await deployInstance(harness, runnerOld, 'w-move-old', MODEL, INSTANCE_OLD);

        // Step 2: deploy the new instance elsewhere — both endpoints now serve (criterion 1's
        // no-409 behavior is what makes this possible at all).
        await deployInstance(harness, runnerNew, 'w-move-new', MODEL, INSTANCE_NEW);

        let entry = await harness.routingMap.getEntry(MODEL);
        expect(entry!.endpoints).toHaveLength(2);
        const oldEndpoint = entry!.endpoints.find((e) => e.port === runnerOld.port)!;
        expect(oldEndpoint).toBeDefined();

        // Concurrent load loop: every ~10ms, read the routing map and apply the proxy's exact
        // balancer predicate (endpoints.some(e => e.healthy && e.weight > 0) — mirrors
        // proxy/src/forwarding/balancer.rs:28) to decide whether a request would have succeeded.
        // This faithfully models the stateless proxy's routing decision without running Rust.
        let successes = 0;
        let failures = 0;
        let loadRunning = true;
        const loadLoop = (async () => {
          while (loadRunning) {
            const live = await harness.routingMap.getEntry(MODEL);
            const selectable = (live?.endpoints ?? []).some((e) => e.healthy && e.weight > 0);
            if (selectable) successes++;
            else failures++;
            await new Promise((r) => setTimeout(r, 10));
          }
        })();

        // Step 3: shift traffic off the old instance (weight -> 0). It's still "in" the routing
        // map (so the load loop keeps observing it) but the balancer predicate excludes it.
        await harness.routingMap.updateEndpointWeight(MODEL, oldEndpoint.host, oldEndpoint.port, 0);

        // Give the load loop a few ticks to observe the weight-0 state before removing the old
        // instance entirely.
        await new Promise((r) => setTimeout(r, 50));

        // Step 4: drain + remove the old instance — the "stop old" move step.
        await harness.sleepWake.stopModel(MODEL, INSTANCE_OLD, null);
        await harness.lifecycle.removeInstance(MODEL, INSTANCE_OLD);

        // Let the load loop keep sampling briefly after the removal too.
        await new Promise((r) => setTimeout(r, 50));
        loadRunning = false;
        await loadLoop;

        expect(failures).toBe(0);
        expect(successes).toBeGreaterThan(0);

        entry = await harness.routingMap.getEntry(MODEL);
        expect(entry).not.toBeNull();
        expect(entry!.endpoints).toHaveLength(1);
        expect(entry!.endpoints[0].port).toBe(runnerNew.port);

        const instances = await harness.lifecycle.getInstancesForModel(MODEL);
        expect(instances).toHaveLength(1);
        expect(instances[0].instanceId).toBe(INSTANCE_NEW);
        expect(deriveAggregateState(instances)).toBe(ModelLifecycleState.ACTIVE);
      } finally {
        await workerOld.close();
        await workerNew.close();
        await runnerOld.close();
        await runnerNew.close();
      }
    },
  );
});
