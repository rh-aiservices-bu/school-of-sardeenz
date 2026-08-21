import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { ModelLifecycleState, RunnerState } from '@sardeenz/types';

import { canConnect, createHarness, type TestHarness } from './helpers/harness.js';
import { createMockRunner, type MockRunnerServer } from './helpers/mock-runner.js';
import { createMockWorker, type MockWorkerServer } from './helpers/mock-worker.js';

const AVAILABLE = await canConnect();

describe.skipIf(!AVAILABLE)('Deploy integration', () => {
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
    runner.setHealthState(RunnerState.STARTING);
    runner.setActiveRequests(0);
  });

  afterEach(async () => {
    await harness?.teardown();
  });

  it('deploy happy path: PENDING → STARTING → ACTIVE with routing', async () => {
    const WORKER_ID = 'w1';
    const MODEL = 'llama-3';
    const MEM = 8_000_000_000;

    await harness.registerWorker({
      workerId: WORKER_ID,
      managementUrl: worker.url,
      devices: [{ deviceIndex: 0, deviceType: 'CUDA', memoryTotalBytes: 16_000_000_000 }],
    });

    const created = await harness.modelRepository.create({
      name: MODEL,
      runnerType: 'vllm',
      modelPath: '/models/llama-3',
      requiredMemory: MEM,
      deviceType: 'CUDA',
      runtimeModule: 'vllm-0.21',
    });
    // runtimeModule round-trips through Postgres (migration 002 column).
    expect(created.runtimeModule).toBe('vllm-0.21');

    await harness.lifecycle.createModel(MODEL, WORKER_ID);

    const workers = harness.workerPool.getAllWorkers();
    const budgets = new Map(harness.memoryBudget.getAllBudgets().map((b) => [b.workerId, b]));
    const result = harness.placement.place(
      {
        modelName: MODEL,
        runnerType: 'vllm',
        requiredMemory: MEM,
        deviceType: 'CUDA',
        tensorParallel: 1,
      },
      workers,
      budgets,
    );

    expect(result).not.toBeNull();
    expect(result!.workerId).toBe(WORKER_ID);

    harness.memoryBudget.reserveCapacity(WORKER_ID, 0, MODEL, MEM);
    await harness.lifecycle.transition(MODEL, ModelLifecycleState.STARTING);

    // Runner becomes READY after a short delay
    setTimeout(() => runner.setHealthState(RunnerState.READY), 200);

    await harness.deployOrchestration.deployModel({
      modelName: MODEL,
      workerId: WORKER_ID,
      runnerType: 'vllm',
      modelPath: '/models/llama-3',
      requiredMemory: MEM,
      tensorParallel: 1,
      runtimeModule: 'vllm-0.21',
      devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
    });

    // The runtime module is forwarded to the worker's start-runner request (which the Apptainer
    // launcher resolves to /modules/vllm-0.21.sif).
    expect(worker.startRequests.at(-1)?.runtimeModule).toBe('vllm-0.21');

    const state = await harness.lifecycle.getState(MODEL);
    expect(state?.state).toBe(ModelLifecycleState.ACTIVE);
    expect(state?.runnerHost).toBe(runner.host);
    expect(state?.runnerPort).toBe(runner.port);

    const entry = await harness.routingMap.getEntry(MODEL);
    expect(entry).not.toBeNull();
    expect(entry!.endpoints.length).toBe(1);
    expect(entry!.endpoints[0].port).toBe(runner.port);
  });

  it(
    'deploy timeout: runner stays STARTING → model transitions to ERROR',
    { timeout: 15_000 },
    async () => {
      const WORKER_ID = 'w2';
      const MODEL = 'stuck-model';
      const MEM = 4_000_000_000;

      await harness.registerWorker({
        workerId: WORKER_ID,
        managementUrl: worker.url,
        devices: [{ deviceIndex: 0, deviceType: 'CUDA', memoryTotalBytes: 16_000_000_000 }],
      });

      await harness.modelRepository.create({
        name: MODEL,
        runnerType: 'vllm',
        modelPath: '/models/stuck',
        requiredMemory: MEM,
        deviceType: 'CUDA',
      });

      await harness.lifecycle.createModel(MODEL, WORKER_ID);
      await harness.lifecycle.transition(MODEL, ModelLifecycleState.STARTING);

      // Runner stays in STARTING — never becomes READY
      runner.setHealthState(RunnerState.STARTING);

      await expect(
        harness.deployOrchestration.deployModel({
          modelName: MODEL,
          workerId: WORKER_ID,
          runnerType: 'vllm',
          modelPath: '/models/stuck',
          requiredMemory: MEM,
          tensorParallel: 1,
          devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
        }),
      ).rejects.toThrow(/timeout/i);

      const state = await harness.lifecycle.getState(MODEL);
      expect(state?.state).toBe(ModelLifecycleState.ERROR);
    },
  );
});
