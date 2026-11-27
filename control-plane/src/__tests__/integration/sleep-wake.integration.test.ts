import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import { DeviceType, ModelLifecycleState, Protocol, RunnerState } from '@sardeenz/types';

import { canConnect, createHarness, type TestHarness } from './helpers/harness.js';
import { createMockRunner, type MockRunnerServer } from './helpers/mock-runner.js';
import { createMockWorker, type MockWorkerServer } from './helpers/mock-worker.js';
import { RunnerClient } from '../../clients/runner.js';
import { registerInternalRoutes } from '../../routes/internal.js';
import type { RouteDeps } from '../../routes/deps.js';
import { ControlPlaneError } from '../../errors.js';

const AVAILABLE = await canConnect();

const WORKER_ID = 'w1';
const MEM = 8_000_000_000;

interface WakeResponse {
  accepted: boolean;
  modelName: string;
  currentState: string;
  message: string;
}

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
    protocol: Protocol.openai,
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

  it('two concurrent internal wake triggers dedupe to one wake (#330)', async () => {
    const MODEL = 'dedupe-model';
    const INSTANCE_ID = 'inst-dedupe';
    await deployModel(harness, runner, worker, MODEL, INSTANCE_ID);

    const runnerClient = new RunnerClient({ host: runner.host, port: runner.port });

    runner.setActiveRequests(0);
    await harness.sleepWake.sleepModel(MODEL, INSTANCE_ID, runnerClient);
    expect((await harness.lifecycle.getInstance(MODEL, INSTANCE_ID))?.state).toBe(
      ModelLifecycleState.SLEEPING,
    );

    // Wake triggers are per replica (ADR-007: the proxy keeps no cross-replica
    // state), so two proxies can POST /api/v1/wake for the same sleeping model at
    // the same moment. The route's CAS admits exactly one; the loser answers the
    // benign "already waking up" 202 (#303). Before that fix the loser 409'd,
    // which made the losing proxy abort its whole parked herd — this case is what
    // pins the two-replica outcome.
    let wakeCalls = 0;
    const deps = {
      config: {},
      modelRepository: harness.modelRepository,
      instanceRepository: harness.instanceRepository,
      lifecycle: harness.lifecycle,
      memoryBudget: harness.memoryBudget,
      workerPool: harness.workerPool,
      routingMap: harness.routingMap,
      placement: harness.placement,
      eviction: harness.eviction,
      sleepWake: {
        wakeModel: (...args: Parameters<typeof harness.sleepWake.wakeModel>) => {
          wakeCalls += 1;
          return harness.sleepWake.wakeModel(...args);
        },
        sleepModel: harness.sleepWake.sleepModel.bind(harness.sleepWake),
      },
      deployOrchestration: harness.deployOrchestration,
      leaderElection: { isLeader: true },
      notifications: { createNotification: () => Promise.resolve() },
      createRunnerClient: (host: string, port: number) =>
        new RunnerClient({ host, port, timeoutMs: 5000 }),
    } as unknown as RouteDeps;

    const app = Fastify({ logger: false });
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof ControlPlaneError) {
        return reply.code(error.statusCode).send(error.toResponse());
      }
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(500).send({ error: message, code: 'INTERNAL_ERROR' });
    });
    registerInternalRoutes(app, deps);
    await app.ready();

    try {
      const payload = { modelName: MODEL };
      const [a, b] = await Promise.all([
        app.inject({ method: 'POST', url: '/api/v1/wake', payload }),
        app.inject({ method: 'POST', url: '/api/v1/wake', payload }),
      ]);

      // Both triggers are 2xx — the winner initiates the wake (202), the loser
      // learns it is already waking (202; 200 only if the wake completed first).
      expect([200, 202]).toContain(a.statusCode);
      expect([200, 202]).toContain(b.statusCode);
      const initiating = [a, b].filter(
        (res) => res.json<WakeResponse>().message === 'Wake initiated',
      );
      expect(initiating).toHaveLength(1);

      // …and exactly one wake was executed for both triggers.
      expect(wakeCalls).toBe(1);
      expect((await harness.lifecycle.getInstance(MODEL, INSTANCE_ID))?.state).toBe(
        ModelLifecycleState.STARTING,
      );

      // Let the background wake finish before teardown.
      runner.setHealthState(RunnerState.READY);
    } finally {
      await app.close();
    }
  });
});
