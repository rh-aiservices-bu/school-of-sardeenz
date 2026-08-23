import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { DeviceType, ModelLifecycleState, RunnerState, WorkerStatus } from '@sardeenz/types';

import { canConnect, createHarness, type TestHarness } from './helpers/harness.js';
import { createMockRunner, type MockRunnerServer } from './helpers/mock-runner.js';
import { createMockWorker, type MockWorkerServer } from './helpers/mock-worker.js';
import { RunnerClient } from '../../clients/runner.js';

const AVAILABLE = await canConnect();

const WORKER_ID = 'w1';
const MEM = 8_000_000_000;

describe.skipIf(!AVAILABLE)('Worker routing integration', () => {
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
    runner.setActiveRequests(0);
    runner.setHealthState(RunnerState.STARTING);
  });

  afterEach(async () => {
    await harness?.teardown();
  });

  it('worker join: register and discover appears in pool as ONLINE', async () => {
    await harness.registerWorker({
      workerId: WORKER_ID,
      managementUrl: worker.url,
      devices: [{ deviceIndex: 0, deviceType: DeviceType.CUDA, memoryTotalBytes: 16_000_000_000 }],
    });

    const record = harness.workerPool.getWorker(WORKER_ID);
    expect(record).not.toBeNull();
    expect(record!.status).toBe(WorkerStatus.ONLINE);
    expect(record!.capabilities.length).toBe(1);
    expect(record!.capabilities[0].runnerType).toBe('vllm');
    expect(record!.devices[0].memoryTotalBytes).toBe(16_000_000_000);
  });

  it('worker leave: expired heartbeat transitions worker to OFFLINE', async () => {
    // Use a very short heartbeat timeout so we can test expiry
    const shortHarness = createHarness();
    // Override the workerPool with a 1-second timeout
    await shortHarness.setup();

    await shortHarness.registerWorker({
      workerId: WORKER_ID,
      managementUrl: worker.url,
      devices: [{ deviceIndex: 0, deviceType: DeviceType.CUDA, memoryTotalBytes: 16_000_000_000 }],
    });

    const before = shortHarness.workerPool.getWorker(WORKER_ID);
    expect(before?.status).toBe(WorkerStatus.ONLINE);

    // Delete the heartbeat key to simulate expiry
    const heartbeatKey = `${shortHarness.keyPrefix}:workers:${WORKER_ID}:heartbeat`;
    await shortHarness.redis.del(heartbeatKey);

    // Re-check heartbeats — worker should now be OFFLINE
    await shortHarness.workerPool.checkHeartbeats();

    const after = shortHarness.workerPool.getWorker(WORKER_ID);
    expect(after?.status).toBe(WorkerStatus.OFFLINE);

    await shortHarness.teardown();
  });

  it('routing map consistency: deploy → routing entry → sleep → entry removed → wake → entry restored', async () => {
    await harness.registerWorker({
      workerId: WORKER_ID,
      managementUrl: worker.url,
      devices: [{ deviceIndex: 0, deviceType: DeviceType.CUDA, memoryTotalBytes: 16_000_000_000 }],
    });

    const MODEL = 'routing-model';
    const INSTANCE_ID = 'inst-routing-model';
    await harness.modelRepository.create({
      name: MODEL,
      runnerType: 'vllm',
      modelPath: `/models/${MODEL}`,
      requiredMemory: MEM,
      deviceType: 'CUDA',
    });

    await harness.lifecycle.createInstance(MODEL, INSTANCE_ID, WORKER_ID);
    await harness.lifecycle.transition(MODEL, INSTANCE_ID, ModelLifecycleState.STARTING);

    runner.setHealthState(RunnerState.READY);
    await harness.deployOrchestration.deployModel({
      modelName: MODEL,
      instanceId: INSTANCE_ID,
      workerId: WORKER_ID,
      runnerType: 'vllm',
      modelPath: `/models/${MODEL}`,
      requiredMemory: MEM,
      tensorParallel: 1,
      devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
    });

    // After deploy: routing entry exists with 1 endpoint
    const deployEntry = await harness.routingMap.getEntry(MODEL);
    expect(deployEntry).not.toBeNull();
    expect(deployEntry!.endpoints.length).toBe(1);
    expect(deployEntry!.endpoints[0].host).toBe(runner.host);
    expect(deployEntry!.endpoints[0].port).toBe(runner.port);

    // Sleep: routing entry endpoints should be cleared
    const runnerClient = new RunnerClient({ host: runner.host, port: runner.port });
    runner.setActiveRequests(0);
    await harness.sleepWake.sleepModel(MODEL, INSTANCE_ID, runnerClient);

    const sleepEntry = await harness.routingMap.getEntry(MODEL);
    expect(sleepEntry?.endpoints.length ?? 0).toBe(0);

    // Wake: routing entry endpoints should be restored
    setTimeout(() => runner.setHealthState(RunnerState.READY), 200);
    await harness.sleepWake.wakeModel(MODEL, INSTANCE_ID, runnerClient);

    const wakeEntry = await harness.routingMap.getEntry(MODEL);
    expect(wakeEntry).not.toBeNull();
    expect(wakeEntry!.endpoints.length).toBe(1);
    expect(wakeEntry!.endpoints[0].host).toBe(runner.host);
    expect(wakeEntry!.endpoints[0].port).toBe(runner.port);
  });
});
