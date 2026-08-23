import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { DeviceType, ModelLifecycleState, RunnerState } from '@sardeenz/types';

import { canConnect, createHarness, type TestHarness } from './helpers/harness.js';
import { createMockRunner, type MockRunnerServer } from './helpers/mock-runner.js';
import { createMockWorker, type MockWorkerServer } from './helpers/mock-worker.js';
import { RunnerClient } from '../../clients/runner.js';

const AVAILABLE = await canConnect();

const WORKER_ID = 'w1';
const MEM = 8_000_000_000;

async function deployModel(
  harness: TestHarness,
  runner: MockRunnerServer,
  worker: MockWorkerServer,
  modelName: string,
  instanceId: string,
): Promise<void> {
  await harness.registerWorker({
    workerId: WORKER_ID,
    managementUrl: worker.url,
    devices: [{ deviceIndex: 0, deviceType: DeviceType.CUDA, memoryTotalBytes: 16_000_000_000 }],
  });

  await harness.modelRepository.create({
    name: modelName,
    runnerType: 'vllm',
    modelPath: `/models/${modelName}`,
    requiredMemory: MEM,
    deviceType: 'CUDA',
  });

  await harness.lifecycle.createInstance(modelName, instanceId, WORKER_ID);
  await harness.lifecycle.transition(modelName, instanceId, ModelLifecycleState.STARTING);

  runner.setHealthState(RunnerState.READY);

  await harness.deployOrchestration.deployModel({
    modelName,
    instanceId,
    workerId: WORKER_ID,
    runnerType: 'vllm',
    modelPath: `/models/${modelName}`,
    requiredMemory: MEM,
    tensorParallel: 1,
    devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
  });
}

describe.skipIf(!AVAILABLE)('Sleep/wake integration', () => {
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
  });

  afterEach(async () => {
    await harness?.teardown();
  });

  it('sleep/wake round-trip: ACTIVE → SLEEPING → ACTIVE with routing restored', async () => {
    const MODEL = 'roundtrip-model';
    const INSTANCE_ID = 'inst-roundtrip';
    await deployModel(harness, runner, worker, MODEL, INSTANCE_ID);

    const preInstance = await harness.lifecycle.getInstance(MODEL, INSTANCE_ID);
    expect(preInstance?.state).toBe(ModelLifecycleState.ACTIVE);

    const runnerClient = new RunnerClient({ host: runner.host, port: runner.port });

    // Sleep the model
    runner.setActiveRequests(0);
    await harness.sleepWake.sleepModel(MODEL, INSTANCE_ID, runnerClient);

    const sleepInstance = await harness.lifecycle.getInstance(MODEL, INSTANCE_ID);
    expect(sleepInstance?.state).toBe(ModelLifecycleState.SLEEPING);

    const sleepEntry = await harness.routingMap.getEntry(MODEL);
    expect(sleepEntry?.endpoints.length ?? 0).toBe(0);

    // Wake the model — runner transitions STARTING → READY after a delay
    setTimeout(() => runner.setHealthState(RunnerState.READY), 200);
    await harness.sleepWake.wakeModel(MODEL, INSTANCE_ID, runnerClient);

    const wakeInstance = await harness.lifecycle.getInstance(MODEL, INSTANCE_ID);
    expect(wakeInstance?.state).toBe(ModelLifecycleState.ACTIVE);

    const wakeEntry = await harness.routingMap.getEntry(MODEL);
    expect(wakeEntry?.endpoints.length).toBe(1);
  });

  it('CAS transition prevents concurrent SLEEPING → STARTING races', async () => {
    const MODEL = 'herd-model';
    const INSTANCE_ID = 'inst-herd';
    await deployModel(harness, runner, worker, MODEL, INSTANCE_ID);

    const runnerClient = new RunnerClient({ host: runner.host, port: runner.port });

    // Sleep first
    runner.setActiveRequests(0);
    await harness.sleepWake.sleepModel(MODEL, INSTANCE_ID, runnerClient);

    const sleepInstance = await harness.lifecycle.getInstance(MODEL, INSTANCE_ID);
    expect(sleepInstance?.state).toBe(ModelLifecycleState.SLEEPING);

    // Race 3 concurrent CAS transitions — only one should win
    const results = await Promise.allSettled([
      harness.lifecycle.transition(MODEL, INSTANCE_ID, ModelLifecycleState.STARTING),
      harness.lifecycle.transition(MODEL, INSTANCE_ID, ModelLifecycleState.STARTING),
      harness.lifecycle.transition(MODEL, INSTANCE_ID, ModelLifecycleState.STARTING),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(2);

    const finalInstance = await harness.lifecycle.getInstance(MODEL, INSTANCE_ID);
    expect(finalInstance?.state).toBe(ModelLifecycleState.STARTING);
  });
});
