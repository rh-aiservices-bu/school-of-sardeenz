import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import { DeviceType, ModelLifecycleState, RunnerState } from '@sardeenz/types';

import { canConnect, createHarness, type TestHarness } from './helpers/harness.js';
import { createMockRunner, type MockRunnerServer } from './helpers/mock-runner.js';
import { createMockWorker, type MockWorkerServer } from './helpers/mock-worker.js';
import { registerModelRoutes } from '../../routes/models.js';
import type { RouteDeps } from '../../routes/deps.js';
import { RunnerClient } from '../../clients/runner.js';
import { WorkerClient } from '../../clients/worker.js';

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
    const INSTANCE_ID = 'inst-llama-3-a';
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
      engineArgs: ['--max-model-len=8192', '--enable-prefix-caching'],
    });
    // runtimeModule round-trips through Postgres (migration 002 column).
    expect(created.runtimeModule).toBe('vllm-0.21');
    // engineArgs round-trips through Postgres as a native text[] (migration 004 column).
    expect(created.engineArgs).toEqual(['--max-model-len=8192', '--enable-prefix-caching']);

    const refetched = await harness.modelRepository.findByName(MODEL);
    expect(refetched?.engineArgs).toEqual(['--max-model-len=8192', '--enable-prefix-caching']);

    await harness.lifecycle.createInstance(MODEL, INSTANCE_ID, WORKER_ID);

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

    harness.memoryBudget.reserveCapacity(WORKER_ID, 0, INSTANCE_ID, MEM);
    await harness.lifecycle.transition(MODEL, INSTANCE_ID, ModelLifecycleState.STARTING);

    // Runner becomes READY after a short delay
    setTimeout(() => runner.setHealthState(RunnerState.READY), 200);

    await harness.deployOrchestration.deployModel({
      modelName: MODEL,
      instanceId: INSTANCE_ID,
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
    expect(worker.startRequests.at(-1)?.instanceId).toBe(INSTANCE_ID);

    const instance = await harness.lifecycle.getInstance(MODEL, INSTANCE_ID);
    expect(instance?.state).toBe(ModelLifecycleState.ACTIVE);
    expect(instance?.runnerHost).toBe(runner.host);
    expect(instance?.runnerPort).toBe(runner.port);

    const entry = await harness.routingMap.getEntry(MODEL);
    expect(entry).not.toBeNull();
    expect(entry!.endpoints.length).toBe(1);
    expect(entry!.endpoints[0].port).toBe(runner.port);
  });

  it('stop retains the record and the model can be started again', async () => {
    const WORKER_ID = 'w3';
    const MODEL = 'stoppable-model';
    const INSTANCE_ID = 'inst-stoppable-a';
    const RESTART_INSTANCE_ID = 'inst-stoppable-b';
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

    await harness.lifecycle.createInstance(MODEL, INSTANCE_ID, WORKER_ID);

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

    harness.memoryBudget.reserveCapacity(WORKER_ID, 0, INSTANCE_ID, MEM);
    await harness.lifecycle.transition(MODEL, INSTANCE_ID, ModelLifecycleState.STARTING);

    runner.setHealthState(RunnerState.STARTING);
    setTimeout(() => runner.setHealthState(RunnerState.READY), 200);

    await harness.deployOrchestration.deployModel({
      modelName: MODEL,
      instanceId: INSTANCE_ID,
      workerId: WORKER_ID,
      runnerType: 'vllm',
      modelPath: '/models/stoppable',
      requiredMemory: MEM,
      tensorParallel: 1,
      runtimeModule: 'vllm-0.21',
      devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
    });

    const activeInstance = await harness.lifecycle.getInstance(MODEL, INSTANCE_ID);
    expect(activeInstance?.state).toBe(ModelLifecycleState.ACTIVE);

    // Stop: drives runtime state to STOPPED then clears it, but keeps the DB row (registry
    // semantics, #121) — mirrors the stop route's background sequence minus modelRepository.delete.
    await harness.sleepWake.stopModel(MODEL, INSTANCE_ID, null);
    await harness.lifecycle.removeInstance(MODEL, INSTANCE_ID);

    const recordAfterStop = await harness.modelRepository.findByName(MODEL);
    expect(recordAfterStop).not.toBeNull();
    const instanceAfterStop = await harness.lifecycle.getInstance(MODEL, INSTANCE_ID);
    expect(instanceAfterStop).toBeNull();
    const instancesAfterStop = await harness.lifecycle.getInstancesForModel(MODEL);
    expect(instancesAfterStop).toHaveLength(0);

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
      RESTART_INSTANCE_ID,
      rec!.requiredMemory!,
    );
    await harness.lifecycle.createInstance(MODEL, RESTART_INSTANCE_ID);
    await harness.lifecycle.transition(MODEL, RESTART_INSTANCE_ID, ModelLifecycleState.STARTING, {
      workerId: restartResult!.workerId,
      deviceIndices: restartResult!.devices.map((d) => d.deviceIndex),
    });

    runner.setHealthState(RunnerState.STARTING);
    setTimeout(() => runner.setHealthState(RunnerState.READY), 200);

    await harness.deployOrchestration.deployModel({
      modelName: rec!.name,
      instanceId: RESTART_INSTANCE_ID,
      workerId: restartResult!.workerId,
      runnerType: rec!.runnerType,
      modelPath: rec!.modelPath,
      requiredMemory: rec!.requiredMemory!,
      tensorParallel: rec!.tensorParallel,
      runtimeModule: rec!.runtimeModule ?? undefined,
      devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
    });

    const restartedInstance = await harness.lifecycle.getInstance(MODEL, RESTART_INSTANCE_ID);
    expect(restartedInstance?.state).toBe(ModelLifecycleState.ACTIVE);
    expect(restartedInstance?.modelName).toBe(MODEL);

    // Still a single row — Start deployed from the existing record, not a new one.
    const finalRecord = await harness.modelRepository.findByName(MODEL);
    expect(finalRecord).not.toBeNull();
    expect(finalRecord!.name).toBe(MODEL);
  });

  it('deploy with servedModelName: round-trips through Postgres, GET detail, and the worker request (ADR-020, #154)', async () => {
    const WORKER_ID = 'w4';
    const MODEL = 'llama-3-fast';
    const INSTANCE_ID = 'inst-llama-3-fast-a';
    const SERVED_MODEL_NAME = 'meta-llama/Llama-3.1-8B-Instruct';
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
      servedModelName: SERVED_MODEL_NAME,
    });
    // servedModelName round-trips through Postgres (migration 005 column).
    expect(created.servedModelName).toBe(SERVED_MODEL_NAME);

    // What GET /api/v1/models/:modelName reads for the detail response (models.ts builds
    // `servedModelName: record?.servedModelName ?? undefined` straight off this repository call).
    const refetched = await harness.modelRepository.findByName(MODEL);
    expect(refetched?.servedModelName).toBe(SERVED_MODEL_NAME);

    await harness.lifecycle.createInstance(MODEL, INSTANCE_ID, WORKER_ID);

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

    harness.memoryBudget.reserveCapacity(WORKER_ID, 0, INSTANCE_ID, MEM);
    await harness.lifecycle.transition(MODEL, INSTANCE_ID, ModelLifecycleState.STARTING);

    runner.setHealthState(RunnerState.STARTING);
    setTimeout(() => runner.setHealthState(RunnerState.READY), 200);

    await harness.deployOrchestration.deployModel({
      modelName: MODEL,
      instanceId: INSTANCE_ID,
      workerId: WORKER_ID,
      runnerType: 'vllm',
      modelPath: '/models/llama-3',
      requiredMemory: MEM,
      tensorParallel: 1,
      servedModelName: SERVED_MODEL_NAME,
      devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
    });

    // Forwarded to the worker's start-runner request, which the launcher maps to the dual
    // --served-model-name argv (ADR-020 point 1).
    expect(worker.startRequests.at(-1)?.servedModelName).toBe(SERVED_MODEL_NAME);

    const instance = await harness.lifecycle.getInstance(MODEL, INSTANCE_ID);
    expect(instance?.state).toBe(ModelLifecycleState.ACTIVE);
  });

  it('two configurations sharing one servedModelName both deploy (not unique, ADR-020 point 2)', async () => {
    const WORKER_ID = 'w5';
    const SERVED_MODEL_NAME = 'meta-llama/Llama-3.1-8B-Instruct';
    const MEM = 4_000_000_000;

    await harness.registerWorker({
      workerId: WORKER_ID,
      managementUrl: worker.url,
      devices: [{ deviceIndex: 0, deviceType: DeviceType.CUDA, memoryTotalBytes: 16_000_000_000 }],
    });

    const configs = [
      { name: 'config-a', instanceId: 'inst-config-a', modelPath: '/models/config-a' },
      { name: 'config-b', instanceId: 'inst-config-b', modelPath: '/models/config-b' },
    ];

    for (const config of configs) {
      const created = await harness.modelRepository.create({
        name: config.name,
        runnerType: 'vllm',
        modelPath: config.modelPath,
        requiredMemory: MEM,
        deviceType: 'CUDA',
        servedModelName: SERVED_MODEL_NAME,
      });
      // No uniqueness constraint on served_model_name — both configs create successfully with the
      // same value.
      expect(created.servedModelName).toBe(SERVED_MODEL_NAME);

      await harness.lifecycle.createInstance(config.name, config.instanceId, WORKER_ID);

      const workers = harness.workerPool.getAllWorkers();
      const budgets = new Map(harness.memoryBudget.getAllBudgets().map((b) => [b.workerId, b]));
      const result = harness.placement.place(
        {
          modelName: config.name,
          runnerType: 'vllm',
          requiredMemory: MEM,
          deviceType: 'CUDA',
          tensorParallel: 1,
        },
        workers,
        budgets,
      );
      expect(result).not.toBeNull();

      harness.memoryBudget.reserveCapacity(WORKER_ID, 0, config.instanceId, MEM);
      await harness.lifecycle.transition(
        config.name,
        config.instanceId,
        ModelLifecycleState.STARTING,
      );

      runner.setHealthState(RunnerState.STARTING);
      setTimeout(() => runner.setHealthState(RunnerState.READY), 200);

      await harness.deployOrchestration.deployModel({
        modelName: config.name,
        instanceId: config.instanceId,
        workerId: WORKER_ID,
        runnerType: 'vllm',
        modelPath: config.modelPath,
        requiredMemory: MEM,
        tensorParallel: 1,
        servedModelName: SERVED_MODEL_NAME,
        devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
      });

      const instance = await harness.lifecycle.getInstance(config.name, config.instanceId);
      expect(instance?.state).toBe(ModelLifecycleState.ACTIVE);
    }

    // Both configuration rows exist independently, both carrying the same served model name.
    const recordA = await harness.modelRepository.findByName('config-a');
    const recordB = await harness.modelRepository.findByName('config-b');
    expect(recordA?.servedModelName).toBe(SERVED_MODEL_NAME);
    expect(recordB?.servedModelName).toBe(SERVED_MODEL_NAME);
  });

  it('deploy with displayName: round-trips through Postgres but never reaches the worker (presentation-only)', async () => {
    const WORKER_ID = 'w6';
    const MODEL = 'llama-3-labeled';
    const INSTANCE_ID = 'inst-llama-3-labeled-a';
    const DISPLAY_NAME = 'Qwen test 1';
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
      displayName: DISPLAY_NAME,
    });
    // displayName round-trips through Postgres (migration 006 column).
    expect(created.displayName).toBe(DISPLAY_NAME);

    const refetched = await harness.modelRepository.findByName(MODEL);
    expect(refetched?.displayName).toBe(DISPLAY_NAME);

    await harness.lifecycle.createInstance(MODEL, INSTANCE_ID, WORKER_ID);

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

    harness.memoryBudget.reserveCapacity(WORKER_ID, 0, INSTANCE_ID, MEM);
    await harness.lifecycle.transition(MODEL, INSTANCE_ID, ModelLifecycleState.STARTING);

    runner.setHealthState(RunnerState.STARTING);
    setTimeout(() => runner.setHealthState(RunnerState.READY), 200);

    // Deliberately NOT passed to deployModel — displayName is presentation-only and never crosses
    // deploy-orchestration or the worker boundary (unlike servedModelName above).
    await harness.deployOrchestration.deployModel({
      modelName: MODEL,
      instanceId: INSTANCE_ID,
      workerId: WORKER_ID,
      runnerType: 'vllm',
      modelPath: '/models/llama-3',
      requiredMemory: MEM,
      tensorParallel: 1,
      devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
    });

    const startRequest = worker.startRequests.at(-1);
    expect(startRequest).toBeDefined();
    expect('displayName' in (startRequest ?? {})).toBe(false);

    const instance = await harness.lifecycle.getInstance(MODEL, INSTANCE_ID);
    expect(instance?.state).toBe(ModelLifecycleState.ACTIVE);
  });

  it('DELETE /api/v1/models/:modelName reaps the runner process via the real route (#157)', async () => {
    const WORKER_ID = 'w7';
    const MODEL = 'llama-3-reap';
    const INSTANCE_ID = 'inst-llama-3-reap-a';
    const MEM = 8_000_000_000;

    await harness.registerWorker({
      workerId: WORKER_ID,
      managementUrl: worker.url,
      devices: [{ deviceIndex: 0, deviceType: DeviceType.CUDA, memoryTotalBytes: 16_000_000_000 }],
    });

    await harness.modelRepository.create({
      name: MODEL,
      runnerType: 'vllm',
      modelPath: '/models/llama-3',
      requiredMemory: MEM,
      deviceType: 'CUDA',
    });

    await harness.lifecycle.createInstance(MODEL, INSTANCE_ID, WORKER_ID);

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

    harness.memoryBudget.reserveCapacity(WORKER_ID, 0, INSTANCE_ID, MEM);
    await harness.lifecycle.transition(MODEL, INSTANCE_ID, ModelLifecycleState.STARTING);

    runner.setHealthState(RunnerState.STARTING);
    setTimeout(() => runner.setHealthState(RunnerState.READY), 200);

    await harness.deployOrchestration.deployModel({
      modelName: MODEL,
      instanceId: INSTANCE_ID,
      workerId: WORKER_ID,
      runnerType: 'vllm',
      modelPath: '/models/llama-3',
      requiredMemory: MEM,
      tensorParallel: 1,
      devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
    });

    const active = await harness.lifecycle.getInstance(MODEL, INSTANCE_ID);
    expect(active?.state).toBe(ModelLifecycleState.ACTIVE);
    const runnerId = active?.runnerId;
    expect(runnerId).toBeTruthy();

    // Build a real Fastify app wired to the harness's real services (not mocks), so
    // routes/models.ts's actual teardownInstance code runs and reaches the mock worker over real
    // HTTP — #157 is precisely that this DELETE call was never made in production. config,
    // leaderElection, and notifications are the only RouteDeps fields models.ts needs that the
    // harness doesn't already provide.
    const deps = {
      config: { weightsDir: '/models' },
      modelRepository: harness.modelRepository,
      instanceRepository: harness.instanceRepository,
      lifecycle: harness.lifecycle,
      memoryBudget: harness.memoryBudget,
      workerPool: harness.workerPool,
      routingMap: harness.routingMap,
      placement: harness.placement,
      eviction: harness.eviction,
      sleepWake: harness.sleepWake,
      deployOrchestration: harness.deployOrchestration,
      leaderElection: { isLeader: true },
      notifications: { createNotification: () => Promise.resolve() },
      createRunnerClient: (host: string, port: number) =>
        new RunnerClient({ host, port, timeoutMs: 5000 }),
      createWorkerClient: (baseUrl: string) => new WorkerClient({ baseUrl, timeoutMs: 5000 }),
    } as unknown as RouteDeps;

    const app = Fastify({ logger: false });
    app.setErrorHandler((error: Error & { statusCode?: number; code?: string }, _req, reply) => {
      return reply.code(error.statusCode ?? 500).send({ error: error.message, code: error.code });
    });
    registerModelRoutes(app, deps);

    try {
      const res = await app.inject({ method: 'DELETE', url: `/api/v1/models/${MODEL}` });
      expect(res.statusCode).toBe(202);

      // Teardown runs in the background — poll until the Redis instance record is gone.
      const deadline = Date.now() + 5000;
      let instanceAfter = await harness.lifecycle.getInstance(MODEL, INSTANCE_ID);
      while (instanceAfter && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        instanceAfter = await harness.lifecycle.getInstance(MODEL, INSTANCE_ID);
      }
      expect(instanceAfter).toBeNull();

      // The whole point of #157: the worker actually received the DELETE for this runnerId.
      expect(worker.stopRequests).toContain(runnerId);
    } finally {
      await app.close();
    }
  });

  it(
    'deploy timeout: runner stays STARTING → model transitions to ERROR',
    { timeout: 15_000 },
    async () => {
      const WORKER_ID = 'w2';
      const MODEL = 'stuck-model';
      const INSTANCE_ID = 'inst-stuck-a';
      const MEM = 4_000_000_000;

      await harness.registerWorker({
        workerId: WORKER_ID,
        managementUrl: worker.url,
        devices: [
          { deviceIndex: 0, deviceType: DeviceType.CUDA, memoryTotalBytes: 16_000_000_000 },
        ],
      });

      await harness.modelRepository.create({
        name: MODEL,
        runnerType: 'vllm',
        modelPath: '/models/stuck',
        requiredMemory: MEM,
        deviceType: 'CUDA',
      });

      await harness.lifecycle.createInstance(MODEL, INSTANCE_ID, WORKER_ID);
      await harness.lifecycle.transition(MODEL, INSTANCE_ID, ModelLifecycleState.STARTING);

      // Runner stays in STARTING — never becomes READY
      runner.setHealthState(RunnerState.STARTING);

      await expect(
        harness.deployOrchestration.deployModel({
          modelName: MODEL,
          instanceId: INSTANCE_ID,
          workerId: WORKER_ID,
          runnerType: 'vllm',
          modelPath: '/models/stuck',
          requiredMemory: MEM,
          tensorParallel: 1,
          devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
        }),
      ).rejects.toThrow(/timed out/i);

      const instance = await harness.lifecycle.getInstance(MODEL, INSTANCE_ID);
      expect(instance?.state).toBe(ModelLifecycleState.ERROR);
    },
  );
});
