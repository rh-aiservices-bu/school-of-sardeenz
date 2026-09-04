import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadRootEnv } from './load-env.js';
import { loadConfig, redactUrl } from './config.js';
import { createRedisClient, redisKey } from './clients/redis.js';
import { createDatabasePool } from './clients/database.js';
import { runMigrations } from './clients/migrations.js';
import { RunnerClient } from './clients/runner.js';
import { buildServer } from './server.js';
import { ModelRepository } from './services/model-repository.js';
import { InstanceRepository } from './services/instance-repository.js';
import { ModelLifecycleService } from './services/model-lifecycle.js';
import { MemoryBudgetService } from './services/memory-budget.js';
import { WorkerPoolService } from './services/worker-pool.js';
import { RoutingMapService } from './services/routing-map.js';
import { PlacementPipeline } from './services/placement.js';
import { EvictionEngine } from './services/eviction.js';
import { SleepWakeService } from './services/sleep-wake.js';
import { DeployOrchestrationService } from './services/deploy-orchestration.js';
import { LeaderElectionService } from './services/leader-election.js';
import { ReconciliationService } from './services/reconciliation.js';
import { NotificationService } from './services/notification.js';
import { CatalogService } from './services/catalog-service.js';
import { ModuleStoreService } from './services/module-store.js';
import { WeightsBrowserService } from './services/weights-browser.js';
import { ProxyProtocolsService } from './services/proxy-protocols.js';
import { MoveOrchestrationService } from './services/move-orchestration.js';
import { StubImporter, OrasImporter, type SifImporter } from './services/sif-importer.js';
import { WorkerClient } from './clients/worker.js';
import type { ControlPlaneComponents } from '@sardeenz/types';

async function main(): Promise<void> {
  loadRootEnv();
  const config = loadConfig();

  const redis = createRedisClient(config);
  const db = createDatabasePool(config);

  await redis.connect();

  const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
  const applied = await runMigrations(db, migrationsDir);
  if (applied > 0) {
    console.log(`Applied ${applied} database migration(s)`);
  }

  const modelRepository = new ModelRepository(db);
  const instanceRepository = new InstanceRepository(db);
  const lifecycle = new ModelLifecycleService(redis, config.redisKeyPrefix);
  const memoryBudget = new MemoryBudgetService(
    redis,
    config.redisKeyPrefix,
    // Staleness horizon for memory reports, not liveness: in-memory budgets are only refreshed
    // by reconciliation's refreshAll(), so a report legitimately ages up to a full reconciliation
    // interval on top of the worker's own reporting cadence. Without the allowance, healthy
    // workers read stale (and drop out of placement/summaries) in the tail of every window now
    // that workers stamp reportedAt (#163). Worker liveness keeps the strict timeout below.
    config.workerHeartbeatTimeoutSecs + config.reconciliationIntervalSecs,
  );
  const workerPool = new WorkerPoolService(
    redis,
    config.redisKeyPrefix,
    config.workerHeartbeatTimeoutSecs,
  );
  const routingMap = new RoutingMapService(redis, config.redisKeyPrefix);
  const proxyProtocols = new ProxyProtocolsService(redis, config.redisKeyPrefix);
  const placement = new PlacementPipeline();
  const eviction = new EvictionEngine(undefined, {
    maxPerCycle: config.evictionMaxPerCycle,
    minActiveTimeSecs: 60,
    circuitBreakerThreshold: 5,
    circuitBreakerWindowSecs: 60,
  });
  const sleepWake = new SleepWakeService(
    lifecycle,
    routingMap,
    memoryBudget,
    config.sleepTimeoutSecs * 1000,
    config.wakeTimeoutSecs * 1000,
    config.healthCheckIntervalSecs * 1000,
  );
  const notificationLogger = {
    info: (obj: Record<string, unknown>, msg: string) => console.log(msg, obj),
    warn: (obj: Record<string, unknown>, msg: string) => console.warn(msg, obj),
    error: (obj: Record<string, unknown>, msg: string) => console.error(msg, obj),
    debug: (obj: Record<string, unknown>, msg: string) => console.debug(msg, obj),
  };
  const notifications = new NotificationService(redis, config.redisKeyPrefix, notificationLogger);

  // Runner catalog + SIF import. The importer is pluggable so the control plane stays
  // runtime-agnostic: 'oras' runs `apptainer pull oras://…` (real), 'stub' writes a placeholder
  // (dev/CI, no apptainer). Import progress is published on the shared cluster-events channel.
  const catalogService = new CatalogService(config.runnerCatalogUrl, notificationLogger, {
    allowInsecureCatalog: config.allowInsecureCatalog,
  });
  const sifImporter: SifImporter =
    config.sifImporter === 'oras'
      ? new OrasImporter({ apptainerBin: config.apptainerBin, verifySif: config.verifySif })
      : new StubImporter();
  const catalogEventsChannel = redisKey(config.redisKeyPrefix, 'cluster-events');
  const emitCatalogEvent = (event: ControlPlaneComponents['schemas']['ClusterEvent']): void => {
    void redis.publish(catalogEventsChannel, JSON.stringify(event)).catch(() => {});
  };
  const moduleStore = new ModuleStoreService(
    config.modulesDir,
    sifImporter,
    emitCatalogEvent,
    notificationLogger,
    notifications,
  );
  const weightsBrowser = new WeightsBrowserService(config.weightsDir, notificationLogger);
  const deployOrchestration = new DeployOrchestrationService(
    lifecycle,
    routingMap,
    workerPool,
    memoryBudget,
    // startRunner blocks on the worker until the runner is healthy (a large model can take many
    // minutes to load), so give it a start timeout matching the deploy budget plus a margin — the
    // worker's own health timeout should fire first with a clean error, not this abort.
    (baseUrl) =>
      new WorkerClient({
        baseUrl,
        startTimeoutMs: config.deployTimeoutSecs * 1000 + 60_000,
        token: config.workerToken,
      }),
    (host, port) => new RunnerClient({ host, port }),
    config.deployTimeoutSecs * 1000,
    config.healthCheckIntervalSecs * 1000,
    notifications,
  );
  const leaderElection = new LeaderElectionService({
    leaseName: config.leaseName,
    leaseNamespace: config.leaseNamespace,
    renewIntervalMs: 10_000,
    leaseDurationMs: 30_000,
    logger: notificationLogger,
  });
  const createWorkerClient = (baseUrl: string) =>
    new WorkerClient({ baseUrl, token: config.workerToken });
  const moveOrchestration = new MoveOrchestrationService(
    lifecycle,
    routingMap,
    sleepWake,
    workerPool,
    memoryBudget,
    instanceRepository,
    leaderElection,
    (host, port) => new RunnerClient({ host, port }),
    createWorkerClient,
    config.deployTimeoutSecs * 1000,
    notificationLogger,
    notifications,
  );

  const app = await buildServer({
    config,
    redis,
    db,
    routes: {
      config,
      modelRepository,
      instanceRepository,
      lifecycle,
      memoryBudget,
      workerPool,
      routingMap,
      placement,
      eviction,
      sleepWake,
      deployOrchestration,
      moveOrchestration,
      leaderElection,
      notifications,
      catalogService,
      moduleStore,
      weightsBrowser,
      proxyProtocols,
      createRunnerClient: (host, port) => new RunnerClient({ host, port }),
      createWorkerClient,
    },
  });

  const reconciliation = new ReconciliationService(
    lifecycle,
    workerPool,
    memoryBudget,
    routingMap,
    leaderElection,
    {
      reconciliationIntervalSecs: config.reconciliationIntervalSecs,
      deployTimeoutSecs: config.deployTimeoutSecs,
      sleepTimeoutSecs: config.sleepTimeoutSecs,
      // STARTING grace for the missing-runner probe: a confirmed miss is only actionable once a
      // start has had its full deploy budget to be a problem; ACTIVE misses are confirmed
      // immediately (see ReconciliationConfig).
      missingRunnerProbeGraceSecs: config.deployTimeoutSecs,
    },
    app.log,
    redis,
    config.redisKeyPrefix,
    notifications,
    instanceRepository,
    modelRepository,
    createWorkerClient,
    moveOrchestration,
  );

  // Leader election runs before the one-shot startup tick below so `isLeader` already reflects
  // whether this instance may do leader-gated work at boot.
  await leaderElection.start();
  // Only the leader imports (the import route is leader-gated), so only the leader creates temp
  // files — and only the leader should sweep them. A non-leader sweeping the shared RWX module
  // store could unlink the leader's in-flight import temp file mid-download.
  if (leaderElection.isLeader) {
    await moduleStore.sweepTempFiles();
  }
  await workerPool.discoverWorkers();
  await memoryBudget.refreshAll();
  // #166: heal boot-time drift immediately instead of after up to one reconciliation interval —
  // a control-plane restart can otherwise leave ghost instance records (e.g. from a blank
  // worker restart) showing as ACTIVE for up to `reconciliationIntervalSecs` longer than
  // necessary. tick() is itself leader-gated, so a non-leader boots without doing it.
  await reconciliation.tick();
  reconciliation.start();

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'Shutting down');
    reconciliation.stop();
    await leaderElection.stop();
    // Hijacked responses (SSE log streams) are invisible to Fastify's own connection tracking, so
    // app.close() would otherwise wait forever for them to end on their own.
    for (const res of app.hijackedResponses) {
      res.end();
    }
    await app.close();
    // Belt-and-braces: if something still keeps the event loop alive (a connection app.close()
    // couldn't reach), don't hang the process indefinitely.
    setTimeout(() => {
      process.exit(1);
    }, 10_000).unref();
    redis.disconnect();
    await db.end();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('unhandledRejection', (reason: unknown) => {
    app.log.fatal({ err: reason }, 'Unhandled promise rejection — exiting');
    process.exit(1);
  });

  await app.listen({ host: config.listenAddr, port: config.listenPort });
  app.log.info(
    {
      address: `${config.listenAddr}:${config.listenPort}`,
      redisUrl: redactUrl(config.redisUrl),
      databaseUrl: redactUrl(config.databaseUrl),
      isLeader: leaderElection.isLeader,
      leadershipMode: leaderElection.leadershipMode,
    },
    'Control plane started',
  );
  if (!config.apiToken) {
    app.log.warn('SARDEENZ_API_TOKEN is not set — API authentication is disabled');
  }
  if (!config.workerToken) {
    app.log.warn(
      'SARDEENZ_WORKER_TOKEN is not set — control plane will not authenticate to worker agents',
    );
  }
}

main().catch((err: unknown) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
