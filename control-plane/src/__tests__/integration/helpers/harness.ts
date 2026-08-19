import { Redis } from 'ioredis';
import pg from 'pg';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadRootEnv } from '../../../load-env.js';

import { redisKey } from '../../../clients/redis.js';
import { runMigrations } from '../../../clients/migrations.js';
import { ModelRepository } from '../../../services/model-repository.js';
import { ModelLifecycleService } from '../../../services/model-lifecycle.js';
import { MemoryBudgetService } from '../../../services/memory-budget.js';
import { WorkerPoolService } from '../../../services/worker-pool.js';
import { RoutingMapService } from '../../../services/routing-map.js';
import { PlacementPipeline } from '../../../services/placement.js';
import { EvictionEngine } from '../../../services/eviction.js';
import { SleepWakeService } from '../../../services/sleep-wake.js';
import { DeployOrchestrationService } from '../../../services/deploy-orchestration.js';
import { RunnerClient } from '../../../clients/runner.js';
import { WorkerClient } from '../../../clients/worker.js';

// Pick up the repo-root .env so integration tests connect to the same host ports as the apps.
loadRootEnv();

const REDIS_URL = process.env['SARDEENZ_REDIS_URL'] ?? 'redis://localhost:6379/1';
const DATABASE_URL =
  process.env['SARDEENZ_DATABASE_URL'] ?? 'postgresql://sardeenz:sardeenz@localhost:5432/sardeenz';

export interface TestHarness {
  redis: Redis;
  db: pg.Pool;
  keyPrefix: string;
  modelRepository: ModelRepository;
  lifecycle: ModelLifecycleService;
  memoryBudget: MemoryBudgetService;
  workerPool: WorkerPoolService;
  routingMap: RoutingMapService;
  placement: PlacementPipeline;
  eviction: EvictionEngine;
  sleepWake: SleepWakeService;
  deployOrchestration: DeployOrchestrationService;
  registerWorker(opts: RegisterWorkerOpts): Promise<void>;
  setup(): Promise<void>;
  teardown(): Promise<void>;
}

export interface RegisterWorkerOpts {
  workerId: string;
  managementUrl: string;
  devices: { deviceIndex: number; deviceType: string; memoryTotalBytes: number }[];
  runnerType?: string;
}

let prefixCounter = 0;

export async function canConnect(): Promise<boolean> {
  let redis: Redis | undefined;
  let db: pg.Pool | undefined;
  try {
    redis = new Redis(REDIS_URL, { lazyConnect: true, connectTimeout: 2000 });
    await redis.connect();
    await redis.ping();
    db = new pg.Pool({ connectionString: DATABASE_URL, max: 1, connectionTimeoutMillis: 2000 });
    await db.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    redis?.disconnect();
    await db?.end();
  }
}

export function createHarness(): TestHarness {
  const keyPrefix = `test-${++prefixCounter}-${Date.now()}`;

  const redis = new Redis(REDIS_URL, { lazyConnect: true });
  const db = new pg.Pool({
    connectionString: DATABASE_URL,
    max: 5,
    connectionTimeoutMillis: 5000,
  });

  const modelRepository = new ModelRepository(db);
  const lifecycle = new ModelLifecycleService(redis, keyPrefix);
  const memoryBudget = new MemoryBudgetService(redis, keyPrefix, 30);
  const workerPool = new WorkerPoolService(redis, keyPrefix, 300);
  const routingMap = new RoutingMapService(redis, keyPrefix);
  const placement = new PlacementPipeline();
  const eviction = new EvictionEngine(undefined, {
    maxPerCycle: 3,
    minActiveTimeSecs: 0,
    circuitBreakerThreshold: 10,
    circuitBreakerWindowSecs: 60,
  });
  const sleepWake = new SleepWakeService(lifecycle, routingMap, 3000, 3000, 100);
  const deployOrchestration = new DeployOrchestrationService(
    lifecycle,
    routingMap,
    workerPool,
    memoryBudget,
    (baseUrl) => new WorkerClient({ baseUrl, timeoutMs: 5000 }),
    (host, port) => new RunnerClient({ host, port, timeoutMs: 5000 }),
    5000,
    100,
  );

  async function registerWorker(opts: RegisterWorkerOpts): Promise<void> {
    const infoKey = redisKey(keyPrefix, 'workers', opts.workerId, 'info');
    const heartbeatKey = redisKey(keyPrefix, 'workers', opts.workerId, 'heartbeat');
    const memoryKey = redisKey(keyPrefix, 'workers', opts.workerId, 'memory');

    const info = {
      capabilities: [
        {
          runnerType: opts.runnerType ?? 'vllm',
          engineName: 'vLLM',
          supportedModelTypes: ['text-generation'],
          supportedDeviceTypes: opts.devices.map((d) => d.deviceType),
          supportedSleepLevels: ['L1_HOST_RAM'],
        },
      ],
      devices: opts.devices.map((d) => ({
        deviceIndex: d.deviceIndex,
        deviceType: d.deviceType,
        memoryTotalBytes: d.memoryTotalBytes,
      })),
      managementUrl: opts.managementUrl,
    };

    const memoryReport = {
      devices: opts.devices.map((d) => ({
        deviceIndex: d.deviceIndex,
        deviceType: d.deviceType,
        memoryUsedBytes: 0,
        memoryTotalBytes: d.memoryTotalBytes,
      })),
      reportedAt: new Date().toISOString(),
    };

    await redis
      .pipeline()
      .set(infoKey, JSON.stringify(info))
      .set(heartbeatKey, new Date().toISOString())
      .set(memoryKey, JSON.stringify(memoryReport))
      .exec();

    await workerPool.discoverWorkers();
    await memoryBudget.refreshAll();
  }

  async function setup(): Promise<void> {
    await redis.connect();
    const migrationsDir = join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      '..',
      '..',
      'migrations',
    );
    await runMigrations(db, migrationsDir);
    await db.query('TRUNCATE models, memory_profiles, benchmarks, settings CASCADE');
  }

  async function teardown(): Promise<void> {
    const keys = await redis.keys(`${keyPrefix}:*`);
    if (keys.length > 0) {
      await redis.del(...keys);
    }
    redis.disconnect();
    await db.end();
  }

  return {
    redis,
    db,
    keyPrefix,
    modelRepository,
    lifecycle,
    memoryBudget,
    workerPool,
    routingMap,
    placement,
    eviction,
    sleepWake,
    deployOrchestration,
    registerWorker,
    setup,
    teardown,
  };
}
