import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ClusterEventType,
  DeviceType,
  ModelLifecycleState,
  Protocol,
  RunnerProcessState,
  RunnerState,
} from '@sardeenz/types';
import type { ControlPlaneComponents } from '@sardeenz/types';

import {
  canConnect,
  createHarness,
  rebuildHarnessGraph,
  type TestHarness,
} from './helpers/harness.js';
import { createMockRunner, type MockRunnerServer } from './helpers/mock-runner.js';
import { createMockWorker, type MockWorkerServer } from './helpers/mock-worker.js';
import {
  ReconciliationService,
  type ReconciliationConfig,
  type ReconciliationLogger,
} from '../../services/reconciliation.js';
import { CatalogService } from '../../services/catalog-service.js';
import { WorkerClient } from '../../clients/worker.js';
import { RunnerClient } from '../../clients/runner.js';
import { registerInternalRoutes } from '../../routes/internal.js';
import { registerModelRoutes } from '../../routes/models.js';
import { ControlPlaneError } from '../../errors.js';
import { registry } from '../../health/metrics.js';
import type { RouteDeps } from '../../routes/deps.js';

type ClusterEvent = ControlPlaneComponents['schemas']['ClusterEvent'];

interface WakeResponse {
  accepted: boolean;
  modelName: string;
  currentState: string;
  message: string;
}

const AVAILABLE = await canConnect();

// The reconciliation exemplar's config, with a 1 s deploy timeout so a stranded STARTING instance
// is recoverable within a scenario instead of after ten minutes. The runner-probe grace stays long
// so scenarios that deliberately strand a STARTING instance are never reaped by that path.
const CONFIG: ReconciliationConfig = {
  reconciliationIntervalSecs: 30,
  deployTimeoutSecs: 1,
  sleepTimeoutSecs: 300,
  missingRunnerProbeGraceSecs: 600,
  poolPressureEnabled: false,
  poolPressureThresholdPercent: 90,
  poolPressureReleaseTargetPercent: 75,
  poolPressureDebounceTicks: 3,
  evictionMaxPerCycle: 3,
};

/**
 * Scripted failure scenarios (#340). Nothing else in the suite kills a dependency while the
 * platform is working, so the M21 fixes had no test proving them: this file flushes Redis
 * (scenario 1, the #328 guard), strands a wake across a control-plane rebuild (scenario 2), kills
 * a worker mid-launch (scenario 3) and races two wake triggers (scenario 4a, #303).
 *
 * Failure injection follows D10 — in-process only: Redis loss is a `FLUSHDB` of this harness's
 * DB-1 keyspace (never `SHUTDOWN`, which would kill the CI service container), control-plane loss
 * is `rebuildHarnessGraph` over the same stores, worker/runner loss is `close()` of the mock
 * servers. Every assertion reads state (Postgres rows, Redis records, routing entries, metric
 * deltas, cluster events), never just an HTTP status, and every wait is bounded.
 */
describe.skipIf(!AVAILABLE)('Failure scenarios — control-plane integration (#340)', () => {
  const WORKER_ID = 'w-340';
  const MEM = 8_000_000_000;

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
    runner.setHangWake(false);
    runner.setActiveRequests(0);
  });

  afterEach(async () => {
    await harness?.teardown();
  });

  interface CapturedLine {
    fields: Record<string, unknown>;
    msg: string;
  }

  /** A reconciliation logger that records every line, so log-surface assertions are real. */
  function capturingLogger(): {
    logger: ReconciliationLogger;
    captured: {
      debugs: CapturedLine[];
      infos: CapturedLine[];
      warns: CapturedLine[];
      errors: CapturedLine[];
    };
  } {
    const captured = {
      debugs: [] as CapturedLine[],
      infos: [] as CapturedLine[],
      warns: [] as CapturedLine[],
      errors: [] as CapturedLine[],
    };
    return {
      captured,
      logger: {
        debug: (fields, msg) => captured.debugs.push({ fields, msg }),
        info: (fields, msg) => captured.infos.push({ fields, msg }),
        warn: (fields, msg) => captured.warns.push({ fields, msg }),
        error: (fields, msg) => captured.errors.push({ fields, msg }),
      },
    };
  }

  function buildService(h: TestHarness, logger: ReconciliationLogger): ReconciliationService {
    return new ReconciliationService(
      h.lifecycle,
      h.workerPool,
      h.memoryBudget,
      h.routingMap,
      { isLeader: true },
      CONFIG,
      logger,
      h.redis,
      h.keyPrefix,
      undefined,
      h.instanceRepository,
      h.modelRepository,
      (baseUrl: string) => new WorkerClient({ baseUrl, timeoutMs: 5000 }),
    );
  }

  /**
   * Current value of one counter series. Metrics live on a single process-global registry
   * (`health/metrics.ts`) and are never reset between tests, so every assertion is a **delta**
   * from a baseline captured inside the test.
   */
  async function counterTotal(name: string, labels?: Record<string, string>): Promise<number> {
    const metric = registry.getSingleMetric(name);
    if (!metric) throw new Error(`metric ${name} is not registered`);
    const snapshot = await metric.get();
    let total = 0;
    for (const series of snapshot.values) {
      if (labels && !Object.entries(labels).every(([k, v]) => series.labels[k] === v)) continue;
      total += series.value;
    }
    return total;
  }

  /** Bounded poll (50 ms) — no unbounded waits, so every scenario stays well under 30 s. */
  async function until(
    what: string,
    predicate: () => boolean | Promise<boolean>,
    timeoutMs = 5000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await predicate()) return;
      if (Date.now() >= deadline) {
        throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  async function registerWorker(managementUrl: string): Promise<void> {
    await harness.registerWorker({
      workerId: WORKER_ID,
      managementUrl,
      devices: [{ deviceIndex: 0, deviceType: DeviceType.CUDA, memoryTotalBytes: 16_000_000_000 }],
    });
  }

  /** Deploy one instance straight through the orchestration service (the sleep-wake exemplar). */
  async function deployModel(
    h: TestHarness,
    targetRunner: MockRunnerServer,
    targetWorker: MockWorkerServer,
    modelName: string,
    instanceId: string,
  ): Promise<void> {
    await h.registerWorker({
      workerId: WORKER_ID,
      managementUrl: targetWorker.url,
      devices: [{ deviceIndex: 0, deviceType: DeviceType.CUDA, memoryTotalBytes: 16_000_000_000 }],
    });

    await h.modelRepository.create({
      name: modelName,
      runnerType: 'vllm',
      modelPath: `/models/${modelName}`,
      requiredMemory: MEM,
      deviceType: 'CUDA',
    });

    await h.lifecycle.createInstance(modelName, instanceId, WORKER_ID);
    await h.lifecycle.transition(modelName, instanceId, ModelLifecycleState.STARTING);

    targetRunner.setHealthState(RunnerState.READY);

    await h.deployOrchestration.deployModel({
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

  /** A Fastify app over the harness graph with the internal wake routes mounted. */
  async function buildInternalApp(h: TestHarness): Promise<FastifyInstance> {
    const deps = {
      config: {},
      modelRepository: h.modelRepository,
      instanceRepository: h.instanceRepository,
      lifecycle: h.lifecycle,
      memoryBudget: h.memoryBudget,
      workerPool: h.workerPool,
      routingMap: h.routingMap,
      placement: h.placement,
      eviction: h.eviction,
      sleepWake: h.sleepWake,
      deployOrchestration: h.deployOrchestration,
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
    return app;
  }

  /**
   * A Fastify app over the harness graph with the model routes mounted. `POST
   * /api/v1/models/:name/instances` runs the real launch path (catalog lookup, placement,
   * capacity reservation, background deploy), which is what scenario 3 kills mid-flight.
   */
  async function buildModelsApp(h: TestHarness): Promise<FastifyInstance> {
    const runnersYamlPath = join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      '..',
      '..',
      'runners.yaml',
    );
    const deps = {
      config: { weightsDir: '/models' },
      modelRepository: h.modelRepository,
      instanceRepository: h.instanceRepository,
      lifecycle: h.lifecycle,
      memoryBudget: h.memoryBudget,
      workerPool: h.workerPool,
      routingMap: h.routingMap,
      placement: h.placement,
      eviction: h.eviction,
      sleepWake: h.sleepWake,
      deployOrchestration: h.deployOrchestration,
      leaderElection: { isLeader: true },
      notifications: { createNotification: () => Promise.resolve() },
      catalogService: new CatalogService(runnersYamlPath, {
        info: () => {},
        warn: () => {},
        error: () => {},
      }),
      createRunnerClient: (host: string, port: number) =>
        new RunnerClient({ host, port, timeoutMs: 5000 }),
      createWorkerClient: (baseUrl: string) => new WorkerClient({ baseUrl, timeoutMs: 5000 }),
    } as unknown as RouteDeps;

    const app = Fastify({ logger: false });
    app.setErrorHandler((error: Error & { statusCode?: number; code?: string }, _req, reply) => {
      return reply.code(error.statusCode ?? 500).send({ error: error.message, code: error.code });
    });
    registerModelRoutes(app, deps);
    await app.ready();
    return app;
  }

  function deviceAvailableBytes(h: TestHarness): number {
    const budget = h.memoryBudget.getAllBudgets().find((b) => b.workerId === WORKER_ID);
    const device = budget?.devices.find((d) => d.deviceIndex === 0);
    if (!device) throw new Error(`no memory budget for ${WORKER_ID}/0`);
    return device.availableBytes;
  }

  it('redis loss: flushed keyspace leaves Postgres rows intact and the guard visible', async () => {
    const MODEL = 'redis-loss-model';
    const INSTANCE_ID = 'inst-redis-loss';

    await registerWorker(worker.url);
    await harness.modelRepository.create({
      name: MODEL,
      runnerType: 'vllm',
      modelPath: `/models/${MODEL}`,
      requiredMemory: MEM,
      deviceType: 'CUDA',
    });
    await harness.lifecycle.createInstance(MODEL, INSTANCE_ID, WORKER_ID);
    await harness.instanceRepository.create({
      instanceId: INSTANCE_ID,
      modelName: MODEL,
      workerId: WORKER_ID,
      deviceIndices: [0],
    });

    // Redis loss (D10): the harness's own DB-1 keyspace goes away; the durable ledger does not.
    await harness.redis.flushdb();

    // Workers re-announce after Redis loss — the mock's runner registry lives in its own process,
    // so only the worker keys need recreating. This also arms the runner sweep, so the guard is
    // exercised on both of its surfaces at once.
    await registerWorker(worker.url);
    worker.setListedRunners([
      {
        runnerId: 'runner-redis-loss',
        instanceId: INSTANCE_ID,
        modelName: MODEL,
        state: RunnerProcessState.READY,
        host: runner.host,
        port: runner.port,
        enginePort: runner.port + 1,
      },
    ]);

    const refusedBaseline = await counterTotal(
      'sardeenz_control_plane_reconciliation_unclaimed_runners_total',
      { action: 'refused' },
    );

    const events: ClusterEvent[] = [];
    const unsubscribe = await harness.subscribeClusterEvents((event) => events.push(event));
    try {
      const { logger, captured } = capturingLogger();
      const service = buildService(harness, logger);
      await service.tick();
      await service.tick();

      // #328's acceptance criterion: rows the pre-guard code pruned wholesale are still there.
      const rows = await harness.instanceRepository.findAll();
      expect(rows.map((r) => r.instanceId)).toEqual([INSTANCE_ID]);

      // Nothing is reaped on either surface: no runner stopped, no record dropped.
      expect(worker.stopRequests).toEqual([]);
      expect(await harness.lifecycle.getInstance(MODEL, INSTANCE_ID)).toBeNull();

      // Guard surface 1 — one RUNNER_ORPHANED row for the whole instance-table episode (no
      // workerId: it is the ledger-side guard, not a per-worker observation).
      await until('the instance-table mass-divergence event', () =>
        events.some((e) => e.type === ClusterEventType.RUNNER_ORPHANED && e.workerId === undefined),
      );
      const tableEvents = events.filter(
        (e) => e.type === ClusterEventType.RUNNER_ORPHANED && e.workerId === undefined,
      );
      expect(tableEvents).toHaveLength(1);
      expect(tableEvents[0]?.data).toMatchObject({
        reason: 'mass-divergence',
        instanceIds: [INSTANCE_ID],
        modelNames: [MODEL],
      });

      // Guard surface 2 — the refusal counter. Asserted as a delta ≥ 1, never an exact total: the
      // row guard counts per tick and the runner sweep counts per worker per tick, so two ticks
      // with a worker registered can increment it several times.
      const refusedAfter = await counterTotal(
        'sardeenz_control_plane_reconciliation_unclaimed_runners_total',
        { action: 'refused' },
      );
      expect(refusedAfter - refusedBaseline).toBeGreaterThanOrEqual(1);

      // Guard surface 3 — the log line (prose: assert the notion, not the wording).
      expect(captured.errors.some((line) => /mass divergence/i.test(line.msg))).toBe(true);
    } finally {
      await unsubscribe();
    }
  });

  it('control-plane loss mid-wake: rebuild over the same stores recovers to terminal ERROR', async () => {
    const MODEL_A = 'cp-loss-active';
    const INSTANCE_A = 'inst-cp-loss-active';
    const MODEL_B = 'cp-loss-waking';
    const INSTANCE_B = 'inst-cp-loss-waking';

    await deployModel(harness, runner, worker, MODEL_A, INSTANCE_A);
    await deployModel(harness, runner, worker, MODEL_B, INSTANCE_B);

    // Sleep B so the wake below is the one a restart strands.
    runner.setActiveRequests(0);
    await harness.sleepWake.sleepModel(
      MODEL_B,
      INSTANCE_B,
      new RunnerClient({ host: runner.host, port: runner.port }),
    );
    expect((await harness.lifecycle.getInstance(MODEL_B, INSTANCE_B))?.state).toBe(
      ModelLifecycleState.SLEEPING,
    );

    // The accepted wake trigger, exactly as routes/internal.ts performs it: the route claims
    // SLEEPING → STARTING and then runs the wake in the background (`claimed: true` — since #323 a
    // direct call against a STARTING instance without the flag is a counted no-op).
    runner.setHangWake(true);
    await harness.lifecycle.transition(MODEL_B, INSTANCE_B, ModelLifecycleState.STARTING);
    const abandoned = harness.sleepWake.wakeModel(
      MODEL_B,
      INSTANCE_B,
      new RunnerClient({ host: runner.host, port: runner.port, timeoutMs: 60_000 }),
      { claimed: true },
    );
    // Its rejection only arrives when the hang is released (runner close after the file's tests);
    // `transitionToError` swallows the post-teardown transition failure.
    abandoned.catch(() => {});

    // "Crash": a fresh graph over the same Redis/Postgres, so the abandoned task is stranded on its
    // runner socket while reconciliation runs on state it never touched.
    const rebuilt = rebuildHarnessGraph(harness);
    expect(rebuilt.redis).toBe(harness.redis);
    expect(rebuilt.keyPrefix).toBe(harness.keyPrefix);

    // During the recovery window — new graph, stranded wake still hung, no tick yet — the ACTIVE
    // sibling still advertises its endpoint, so a request routed through the proxy would still be
    // served. This is the store-level stand-in for "kept serving throughout" (live inference
    // traffic is the proxy half of #340); the post-tick assertion below covers the far end.
    expect((await rebuilt.routingMap.getEntry(MODEL_A))?.endpoints.length).toBe(1);

    // `recoverStuckInstances` only flips instances past `deployTimeoutSecs` (1 s here).
    await new Promise<void>((resolve) => setTimeout(resolve, 1200));

    // Still routable at the far end of the window, immediately before the recovery tick.
    expect((await harness.routingMap.getEntry(MODEL_A))?.endpoints.length).toBe(1);

    const stuckBaseline = await counterTotal(
      'sardeenz_control_plane_reconciliation_stuck_models_total',
    );
    const { logger, captured } = capturingLogger();
    await buildService(rebuilt, logger).tick();

    // Store-level outcome: the stranded instance reached a terminal, reported state…
    const stranded = await harness.lifecycle.getInstance(MODEL_B, INSTANCE_B);
    expect(stranded?.state).toBe(ModelLifecycleState.ERROR);
    expect(stranded?.errorMessage).toBeTruthy();
    expect(stranded?.errorMessage).toContain('Stuck in STARTING');

    // …nothing anywhere is left transitional…
    const transient = [
      ModelLifecycleState.PENDING,
      ModelLifecycleState.STARTING,
      ModelLifecycleState.STOPPING,
      ModelLifecycleState.DRAINING,
    ];
    for (const instance of await harness.lifecycle.getAllInstances()) {
      expect(transient).not.toContain(instance.state);
    }

    // …and after recovery the sibling is still ACTIVE and still routable, untouched by the tick
    // (this is what the mock worker's liveness probe exists for: without it
    // `reconcileMissingRunners` reaps A on a harness gap)…
    expect((await harness.lifecycle.getInstance(MODEL_A, INSTANCE_A))?.state).toBe(
      ModelLifecycleState.ACTIVE,
    );
    expect((await harness.routingMap.getEntry(MODEL_A))?.endpoints.length).toBe(1);

    // …B no longer advertises an endpoint, and the recovery is reported, not swallowed (#303).
    expect((await harness.routingMap.getEntry(MODEL_B))?.endpoints.length ?? 0).toBe(0);
    const stuckAfter = await counterTotal(
      'sardeenz_control_plane_reconciliation_stuck_models_total',
    );
    expect(stuckAfter - stuckBaseline).toBeGreaterThanOrEqual(1);
    expect(captured.warns.some((line) => line.msg.includes('Recovered stuck instance'))).toBe(true);
  });

  it(
    'worker/runner loss mid-launch: terminal ERROR, capacity released, retry succeeds',
    { timeout: 15_000 },
    async () => {
      const MODEL = 'mid-launch-model';
      // A runner that never reports READY keeps the launch in its health-poll phase.
      const launchRunner = await createMockRunner();
      const launchWorker = await createMockWorker(launchRunner);

      await registerWorker(launchWorker.url);
      await harness.modelRepository.create({
        name: MODEL,
        runnerType: 'vllm',
        modelPath: `/models/${MODEL}`,
        requiredMemory: MEM,
        deviceType: 'CUDA',
      });

      const app = await buildModelsApp(harness);
      try {
        const preAvailable = deviceAvailableBytes(harness);

        const launched = await app.inject({
          method: 'POST',
          url: `/api/v1/models/${MODEL}/instances`,
        });
        expect(launched.statusCode).toBe(202);
        const instanceId = launched.json<{ instanceId: string }>().instanceId;

        // Mid-launch: the start was dispatched **and acknowledged**, then the worker and its runner
        // die. The reply matters: `startRequests` is pushed before Fastify serializes the response
        // (mock-worker.ts), so polling it alone could observe the dispatch while the control plane
        // is still awaiting the reply — `runnerPort` is persisted only after the reply lands
        // (deploy-orchestration.ts), which makes "the failure is unambiguous" an asserted premise
        // rather than one resting on the later shutdown flushing the response.
        await until(
          'the runner start to be dispatched and acknowledged',
          async () =>
            launchWorker.startRequests.length === 1 &&
            (await harness.lifecycle.getInstance(MODEL, instanceId))?.runnerPort != null,
        );
        await launchWorker.close();
        await launchRunner.close();

        await until(
          `instance ${instanceId} to reach ERROR`,
          async () =>
            (await harness.lifecycle.getInstance(MODEL, instanceId))?.state ===
            ModelLifecycleState.ERROR,
        );
        const failed = await harness.lifecycle.getInstance(MODEL, instanceId);
        expect(failed?.errorMessage).toBeTruthy();

        // Capacity is released (internal accounting only — never a user-facing "reserved" figure).
        expect(deviceAvailableBytes(harness)).toBe(preAvailable);
        // …the routing map has no endpoint for the dead launch…
        expect((await harness.routingMap.getEntry(MODEL))?.endpoints.length ?? 0).toBe(0);

        // …and a retry succeeds once a worker is back. Same worker id on purpose: the dead
        // worker's Redis keys are overwritten, so placement sees exactly one worker.
        const retryRunner = await createMockRunner();
        retryRunner.setHealthState(RunnerState.READY);
        const retryWorker = await createMockWorker(retryRunner);
        try {
          await registerWorker(retryWorker.url);

          const retried = await app.inject({
            method: 'POST',
            url: `/api/v1/models/${MODEL}/instances`,
          });
          expect(retried.statusCode).toBe(202);
          const retryInstanceId = retried.json<{ instanceId: string }>().instanceId;
          await until(
            `instance ${retryInstanceId} to become ACTIVE`,
            async () =>
              (await harness.lifecycle.getInstance(MODEL, retryInstanceId))?.state ===
              ModelLifecycleState.ACTIVE,
          );
          const entry = await harness.routingMap.getEntry(MODEL);
          expect(entry?.endpoints.length).toBe(1);
        } finally {
          await retryWorker.close();
          await retryRunner.close();
        }
      } finally {
        // The happy path already closed these mid-test (that is the injection); Fastify's close()
        // resolves immediately on an already-closed instance, so repeating it here is what frees
        // the listeners when an assertion above the mid-test close fails.
        await launchWorker.close();
        await launchRunner.close();
        await app.close();
      }
    },
  );

  it('two concurrent wake triggers: exactly one wake, both 2xx', async () => {
    const MODEL = 'concurrent-wake-model';
    const INSTANCE_ID = 'inst-concurrent-wake';

    await deployModel(harness, runner, worker, MODEL, INSTANCE_ID);
    runner.setActiveRequests(0);
    await harness.sleepWake.sleepModel(
      MODEL,
      INSTANCE_ID,
      new RunnerClient({ host: runner.host, port: runner.port }),
    );
    expect((await harness.lifecycle.getInstance(MODEL, INSTANCE_ID))?.state).toBe(
      ModelLifecycleState.SLEEPING,
    );

    // A sleeping instance with a runner still at SLEEPING health: the wake below must be the only
    // one, and it cannot reach ACTIVE before the assertions that pin "exactly one".
    const app = await buildInternalApp(harness);
    try {
      const wakeBaseline = await counterTotal('sardeenz_control_plane_wake_triggers_total');
      const runnerWakeBaseline = runner.wakeRequests;

      const payload = { modelName: MODEL };
      const [a, b] = await Promise.all([
        app.inject({ method: 'POST', url: '/api/v1/wake', payload }),
        app.inject({ method: 'POST', url: '/api/v1/wake', payload }),
      ]);

      // Post-#303 both triggers are 2xx: the CAS loser answers the benign "already waking up" 202.
      // Pre-#303 the loser's uncaught INVALID_TRANSITION surfaced as 409.
      expect([200, 202]).toContain(a.statusCode);
      expect([200, 202]).toContain(b.statusCode);
      const initiating = [a, b].filter(
        (res) => res.json<WakeResponse>().message === 'Wake initiated',
      );
      expect(initiating).toHaveLength(1);

      // Let the single wake finish, then assert the store-level outcome. Wait for the runner to
      // have received `/wake` first — its handler flips health back to STARTING, so flipping READY
      // before that would be overwritten and the wake would time out.
      await until(
        'the runner to receive the wake',
        () => runner.wakeRequests - runnerWakeBaseline >= 1,
      );
      runner.setHealthState(RunnerState.READY);
      await until(
        `instance ${INSTANCE_ID} to become ACTIVE`,
        async () =>
          (await harness.lifecycle.getInstance(MODEL, INSTANCE_ID))?.state ===
          ModelLifecycleState.ACTIVE,
      );
      expect((await harness.routingMap.getEntry(MODEL))?.endpoints.length).toBe(1);

      // Exactly one wake executed — the real runner-side HTTP count and the control-plane metric
      // agree (checked after completion, so a second wake would have landed by now).
      expect(runner.wakeRequests - runnerWakeBaseline).toBe(1);
      const wakeAfter = await counterTotal('sardeenz_control_plane_wake_triggers_total');
      expect(wakeAfter - wakeBaseline).toBe(1);
    } finally {
      await app.close();
    }
  });
});
