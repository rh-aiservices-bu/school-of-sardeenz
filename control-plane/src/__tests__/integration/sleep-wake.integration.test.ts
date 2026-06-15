import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { ModelLifecycleState, RunnerState } from '@sardeenz/types';

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
): Promise<void> {
  await harness.registerWorker({
    workerId: WORKER_ID,
    managementUrl: worker.url,
    devices: [{ deviceIndex: 0, deviceType: 'CUDA', memoryTotalBytes: 16_000_000_000 }],
  });

  await harness.modelRepository.create({
    name: modelName,
    runnerType: 'vllm',
    modelPath: `/models/${modelName}`,
    requiredMemory: MEM,
    deviceType: 'CUDA',
  });

  await harness.lifecycle.createModel(modelName, WORKER_ID);
  await harness.lifecycle.transition(modelName, ModelLifecycleState.STARTING);

  runner.setHealthState(RunnerState.READY);

  await harness.deployOrchestration.deployModel({
    modelName,
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
    await deployModel(harness, runner, worker, MODEL);

    const preState = await harness.lifecycle.getState(MODEL);
    expect(preState?.state).toBe(ModelLifecycleState.ACTIVE);

    const runnerClient = new RunnerClient({ host: runner.host, port: runner.port });

    // Sleep the model
    runner.setActiveRequests(0);
    await harness.sleepWake.sleepModel(MODEL, runnerClient);

    const sleepState = await harness.lifecycle.getState(MODEL);
    expect(sleepState?.state).toBe(ModelLifecycleState.SLEEPING);

    const sleepEntry = await harness.routingMap.getEntry(MODEL);
    expect(sleepEntry?.endpoints.length ?? 0).toBe(0);

    // Wake the model — runner transitions STARTING → READY after a delay
    setTimeout(() => runner.setHealthState(RunnerState.READY), 200);
    await harness.sleepWake.wakeModel(MODEL, runnerClient);

    const wakeState = await harness.lifecycle.getState(MODEL);
    expect(wakeState?.state).toBe(ModelLifecycleState.ACTIVE);

    const wakeEntry = await harness.routingMap.getEntry(MODEL);
    expect(wakeEntry?.endpoints.length).toBe(1);
  });

  it('CAS transition prevents concurrent SLEEPING → STARTING races', async () => {
    const MODEL = 'herd-model';
    await deployModel(harness, runner, worker, MODEL);

    const runnerClient = new RunnerClient({ host: runner.host, port: runner.port });

    // Sleep first
    runner.setActiveRequests(0);
    await harness.sleepWake.sleepModel(MODEL, runnerClient);

    const sleepState = await harness.lifecycle.getState(MODEL);
    expect(sleepState?.state).toBe(ModelLifecycleState.SLEEPING);

    // Race 3 concurrent CAS transitions — only one should win
    const results = await Promise.allSettled([
      harness.lifecycle.transition(MODEL, ModelLifecycleState.STARTING),
      harness.lifecycle.transition(MODEL, ModelLifecycleState.STARTING),
      harness.lifecycle.transition(MODEL, ModelLifecycleState.STARTING),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(2);

    const finalState = await harness.lifecycle.getState(MODEL);
    expect(finalState?.state).toBe(ModelLifecycleState.STARTING);
  });
});
