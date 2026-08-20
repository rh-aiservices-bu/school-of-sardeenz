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
import { StubImporter, OrasImporter, type SifImporter } from './services/sif-importer.js';
import { WorkerClient } from './clients/worker.js';
import type { ControlPlaneComponents } from '@sardeenz/types';

async function main(): Promise<void> {
  loadRootEnv();
  const config = loadConfig();

  const redis = createRedisClient(config);
  const subscriber = createRedisClient(config);
  const db = createDatabasePool(config);

  await redis.connect();
  await subscriber.connect();

  const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
  const applied = await runMigrations(db, migrationsDir);
  if (applied > 0) {
    console.log(`Applied ${applied} database migration(s)`);
  }

  const modelRepository = new ModelRepository(db);
  const lifecycle = new ModelLifecycleService(redis, config.redisKeyPrefix);
  const memoryBudget = new MemoryBudgetService(
    redis,
    config.redisKeyPrefix,
    config.workerHeartbeatTimeoutSecs,
  );
  const workerPool = new WorkerPoolService(
    redis,
    config.redisKeyPrefix,
    config.workerHeartbeatTimeoutSecs,
  );
  const routingMap = new RoutingMapService(redis, config.redisKeyPrefix);
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
    config.sleepTimeoutSecs * 1000,
    config.wakeTimeoutSecs * 1000,
    config.healthCheckIntervalSecs * 1000,
  );
  const notificationLogger = {
    info: (obj: Record<string, unknown>, msg: string) => console.log(msg, obj),
    warn: (obj: Record<string, unknown>, msg: string) => console.warn(msg, obj),
    error: (obj: Record<string, unknown>, msg: string) => console.error(msg, obj),
  };
  const notifications = new NotificationService(redis, config.redisKeyPrefix, notificationLogger);

  // Runner catalog + SIF import. The importer is pluggable so the control plane stays
  // runtime-agnostic: 'oras' runs `apptainer pull oras://…` (real), 'stub' writes a placeholder
  // (dev/CI, no apptainer). Import progress is published on the shared cluster-events channel.
  const catalogService = new CatalogService(config.runnerCatalogUrl, notificationLogger);
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
      new WorkerClient({ baseUrl, startTimeoutMs: config.deployTimeoutSecs * 1000 + 60_000 }),
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
  });

  const app = await buildServer({
    config,
    redis,
    subscriber,
    db,
    routes: {
      config,
      modelRepository,
      lifecycle,
      memoryBudget,
      workerPool,
      routingMap,
      placement,
      eviction,
      sleepWake,
      deployOrchestration,
      leaderElection,
      notifications,
      catalogService,
      moduleStore,
      weightsBrowser,
      createRunnerClient: (host, port) => new RunnerClient({ host, port }),
      createWorkerClient: (baseUrl) => new WorkerClient({ baseUrl }),
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
    },
    app.log,
    redis,
    config.redisKeyPrefix,
    notifications,
  );

  await leaderElection.start();
  // Only the leader imports (the import route is leader-gated), so only the leader creates temp
  // files — and only the leader should sweep them. A non-leader sweeping the shared RWX module
  // store could unlink the leader's in-flight import temp file mid-download.
  if (leaderElection.isLeader) {
    await moduleStore.sweepTempFiles();
  }
  await workerPool.discoverWorkers();
  await memoryBudget.refreshAll();
  reconciliation.start();

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'Shutting down');
    reconciliation.stop();
    await leaderElection.stop();
    await app.close();
    redis.disconnect();
    subscriber.disconnect();
    await db.end();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ host: config.listenAddr, port: config.listenPort });
  app.log.info(
    {
      address: `${config.listenAddr}:${config.listenPort}`,
      redisUrl: redactUrl(config.redisUrl),
      databaseUrl: redactUrl(config.databaseUrl),
      isLeader: leaderElection.isLeader,
    },
    'Control plane started',
  );
}

main().catch((err: unknown) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
