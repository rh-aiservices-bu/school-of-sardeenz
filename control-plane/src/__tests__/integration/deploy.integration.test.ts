import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { DeviceType, ModelLifecycleState, RunnerState } from '@sardeenz/types';

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
      devices: [{ deviceIndex: 0, deviceType: DeviceType.CUDA, memoryTotalBytes: 16_000_000_000 }],
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

  it('stop retains the record and the model can be started again', async () => {
    const WORKER_ID = 'w3';
    const MODEL = 'stoppable-model';
    const MEM = 8_000_000_000;

    await harness.registerWorker({
      workerId: WORKER_ID,
      managementUrl: worker.url,
      devices: [{ deviceIndex: 0, deviceType: DeviceType.CUDA, memoryTotalBytes: 16_000_000_000 }],
    });

    // Deploy to ACTIVE, same shape as the happy-path test above.
    await harness.modelRepository.create({
      name: MODEL,
      runnerType: 'vllm',
      modelPath: '/models/stoppable',
      requiredMemory: MEM,
      deviceType: 'CUDA',
      runtimeModule: 'vllm-0.21',
    });

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

    harness.memoryBudget.reserveCapacity(WORKER_ID, 0, MODEL, MEM);
    await harness.lifecycle.transition(MODEL, ModelLifecycleState.STARTING);

    runner.setHealthState(RunnerState.STARTING);
    setTimeout(() => runner.setHealthState(RunnerState.READY), 200);

    await harness.deployOrchestration.deployModel({
      modelName: MODEL,
      workerId: WORKER_ID,
      runnerType: 'vllm',
      modelPath: '/models/stoppable',
      requiredMemory: MEM,
      tensorParallel: 1,
      runtimeModule: 'vllm-0.21',
      devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
    });

    const activeState = await harness.lifecycle.getState(MODEL);
    expect(activeState?.state).toBe(ModelLifecycleState.ACTIVE);

    // Stop: drives runtime state to STOPPED then clears it, but keeps the DB row (registry
    // semantics, #121) — mirrors the stop route's background sequence minus modelRepository.delete.
    await harness.sleepWake.stopModel(MODEL, null);
    await harness.lifecycle.removeModel(MODEL);

    const recordAfterStop = await harness.modelRepository.findByName(MODEL);
    expect(recordAfterStop).not.toBeNull();
    const stateAfterStop = await harness.lifecycle.getState(MODEL);
    expect(stateAfterStop).toBeNull();

    // Start: re-run the placement pipeline from the stored record — no worker affinity is kept.
    const rec = await harness.modelRepository.findByName(MODEL);
    expect(rec).not.toBeNull();

    await harness.memoryBudget.refreshAll();
    const refreshedBudgets = new Map(
      harness.memoryBudget.getAllBudgets().map((b) => [b.workerId, b]),
    );
    const restartResult = harness.placement.place(
      {
        modelName: rec!.name,
        runnerType: rec!.runnerType,
        requiredMemory: rec!.requiredMemory!,
        deviceType: rec!.deviceType ?? undefined,
        tensorParallel: rec!.tensorParallel,
      },
      workers,
      refreshedBudgets,
    );
    expect(restartResult).not.toBeNull();

    harness.memoryBudget.reserveCapacity(
      restartResult!.workerId,
      restartResult!.devices[0].deviceIndex,
      rec!.name,
      rec!.requiredMemory!,
    );
    await harness.lifecycle.createModel(MODEL);
    await harness.lifecycle.transition(MODEL, ModelLifecycleState.STARTING, {
      workerId: restartResult!.workerId,
      deviceIndices: restartResult!.devices.map((d) => d.deviceIndex),
    });

    runner.setHealthState(RunnerState.STARTING);
    setTimeout(() => runner.setHealthState(RunnerState.READY), 200);

    await harness.deployOrchestration.deployModel({
      modelName: rec!.name,
      workerId: restartResult!.workerId,
      runnerType: rec!.runnerType,
      modelPath: rec!.modelPath,
      requiredMemory: rec!.requiredMemory!,
      tensorParallel: rec!.tensorParallel,
      runtimeModule: rec!.runtimeModule ?? undefined,
      devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
    });

    const restartedState = await harness.lifecycle.getState(MODEL);
    expect(restartedState?.state).toBe(ModelLifecycleState.ACTIVE);
    expect(restartedState?.modelName).toBe(MODEL);

    // Still a single row — Start deployed from the existing record, not a new one.
    const finalRecord = await harness.modelRepository.findByName(MODEL);
    expect(finalRecord).not.toBeNull();
    expect(finalRecord!.name).toBe(MODEL);
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
        devices: [{ deviceIndex: 0, deviceType: DeviceType.CUDA, memoryTotalBytes: 16_000_000_000 }],
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
