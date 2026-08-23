import { Redis } from 'ioredis';
import pg from 'pg';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { WorkerAgentComponents } from '@sardeenz/types';
import { ModelType, SleepLevel } from '@sardeenz/types';

import { loadRootEnv } from '../../../load-env.js';

import { redisKey } from '../../../clients/redis.js';
import { runMigrations } from '../../../clients/migrations.js';
import { ModelRepository } from '../../../services/model-repository.js';
import { InstanceRepository } from '../../../services/instance-repository.js';
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

// Pick up the repo-root .env so integration tests reach the same Postgres/Redis server as the apps.
loadRootEnv();

// Integration tests TRUNCATE tables and must NEVER run against the dev database. We reach the same
// *server* as the apps (via the loaded .env) but on a DEDICATED database, derived by suffixing the
// dev DB name with `_test` (e.g. sardeenz -> sardeenz_test). setup() additionally hard-refuses any
// database whose name doesn't end in `_test`, so a stray SARDEENZ_DATABASE_URL can never wipe real
// data again (see the incident that motivated this: the harness used to truncate the dev DB).
// Overrides: SARDEENZ_TEST_DATABASE_URL / SARDEENZ_TEST_REDIS_URL for full control;
// SARDEENZ_ALLOW_NON_TEST_DB=1 to bypass the guard (dangerous — only for a throwaway DB).
const TEST_DB_SUFFIX = '_test';
const TEST_REDIS_DB = 1; // keyspace kept off the dev default (DB 0)

const DEV_DATABASE_URL =
  process.env['SARDEENZ_DATABASE_URL'] ?? 'postgresql://sardeenz:sardeenz@localhost:5432/sardeenz';
const DEV_REDIS_URL = process.env['SARDEENZ_REDIS_URL'] ?? 'redis://localhost:6379';

function databaseName(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
}

function isTestDatabase(url: string): boolean {
  return databaseName(url).endsWith(TEST_DB_SUFFIX);
}

function deriveTestDatabaseUrl(devUrl: string): string {
  const u = new URL(devUrl);
  const dbName = databaseName(devUrl);
  const testName = dbName.endsWith(TEST_DB_SUFFIX) ? dbName : `${dbName}${TEST_DB_SUFFIX}`;
  u.pathname = `/${encodeURIComponent(testName)}`;
  return u.toString();
}

function deriveTestRedisUrl(devUrl: string): string {
  const u = new URL(devUrl);
  u.pathname = `/${TEST_REDIS_DB}`;
  return u.toString();
}

const REDIS_URL = process.env['SARDEENZ_TEST_REDIS_URL'] ?? deriveTestRedisUrl(DEV_REDIS_URL);
const DATABASE_URL =
  process.env['SARDEENZ_TEST_DATABASE_URL'] ?? deriveTestDatabaseUrl(DEV_DATABASE_URL);
const ALLOW_NON_TEST_DB = process.env['SARDEENZ_ALLOW_NON_TEST_DB'] === '1';

// Advisory-lock key that serializes concurrent CREATE DATABASE across vitest's parallel test-file
// workers (each runs canConnect() in its own process). Any stable constant works.
const CREATE_DB_LOCK_KEY = 0x5a2d_7e57; // "SARD-TEST"

async function testDatabaseReachable(): Promise<boolean> {
  const probe = new pg.Pool({ connectionString: DATABASE_URL, max: 1, connectionTimeoutMillis: 2000 });
  try {
    await probe.query('SELECT 1');
    return true;
  } catch (err) {
    if ((err as { code?: string }).code === '3D000') return false; // database does not exist (yet)
    throw err; // real failure (server down, auth) — surface it so canConnect() skips honestly
  } finally {
    await probe.end();
  }
}

// Create the dedicated test database if it doesn't exist yet, so `npm test` works out of the box
// against a local dev Postgres. No-op when it already exists; when we can't reach/create it,
// canConnect() reports unavailable and the integration suite skips.
async function ensureTestDatabaseExists(): Promise<void> {
  if (await testDatabaseReachable()) return; // fast path: already there, no maintenance connection

  const adminUrl = new URL(DATABASE_URL);
  adminUrl.pathname = '/postgres'; // maintenance DB on the same server
  const admin = new pg.Pool({
    connectionString: adminUrl.toString(),
    max: 1,
    connectionTimeoutMillis: 2000,
  });
  const client = await admin.connect();
  try {
    // Serialize with parallel workers so only one CREATE runs at a time — avoids the
    // "template database is being accessed by other users" race and duplicate creates.
    await client.query('SELECT pg_advisory_lock($1)', [CREATE_DB_LOCK_KEY]);
    const { rows } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [
      databaseName(DATABASE_URL),
    ]);
    if (rows.length === 0) {
      // The name is derived/guarded (ends in `_test`); CREATE DATABASE can't be parameterized, so
      // quote-escape defensively.
      await client.query(`CREATE DATABASE "${databaseName(DATABASE_URL).replace(/"/g, '""')}"`);
    }
    await client.query('SELECT pg_advisory_unlock($1)', [CREATE_DB_LOCK_KEY]);
  } finally {
    client.release();
    await admin.end();
  }
}

export interface TestHarness {
  redis: Redis;
  db: pg.Pool;
  keyPrefix: string;
  modelRepository: ModelRepository;
  instanceRepository: InstanceRepository;
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

// Current WorkerInfo/WorkerMemoryReport contract shape (packages/contracts/specs/worker-agent.yaml),
// validated at the Redis boundary by WorkerPoolService (control-plane/src/services/worker-pool.ts).
// Typing the fixture against the generated contract types (rather than ad-hoc shapes) means a future
// contract change that this fixture doesn't account for fails typecheck instead of silently rotting
// until the next live-stack integration run (see #141).
type WorkerInfoPayload = WorkerAgentComponents['schemas']['WorkerInfo'];
type WorkerDeviceInfo = WorkerAgentComponents['schemas']['WorkerDeviceInfo'];
type WorkerMemoryReportPayload = WorkerAgentComponents['schemas']['WorkerMemoryReport'];

export interface RegisterWorkerOpts {
  workerId: string;
  managementUrl: string;
  devices: WorkerDeviceInfo[];
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
    await ensureTestDatabaseExists();
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
  const instanceRepository = new InstanceRepository(db);
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
  const sleepWake = new SleepWakeService(lifecycle, routingMap, memoryBudget, 3000, 3000, 100);
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

    const info: WorkerInfoPayload = {
      capabilities: [
        {
          runnerType: opts.runnerType ?? 'vllm',
          engineName: 'vLLM',
          supportedModelTypes: [ModelType.LLM],
          supportedDeviceTypes: opts.devices.map((d) => d.deviceType),
          supportedSleepLevels: [SleepLevel.L1_HOST_RAM],
          maxTensorParallelism: 1,
          kvCacheElasticSharing: false,
        },
      ],
      devices: opts.devices.map((d) => ({
        deviceIndex: d.deviceIndex,
        deviceType: d.deviceType,
        memoryTotalBytes: d.memoryTotalBytes,
      })),
      managementUrl: opts.managementUrl,
    };

    const memoryReport: WorkerMemoryReportPayload = {
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
    // Last line of defence: the truncation below must only ever hit a dedicated test DB.
    if (!ALLOW_NON_TEST_DB && !isTestDatabase(DATABASE_URL)) {
      throw new Error(
        `Refusing to run integration tests against non-test database "${databaseName(DATABASE_URL)}": ` +
          `these tests TRUNCATE tables. Point SARDEENZ_TEST_DATABASE_URL at a database whose name ends in ` +
          `"${TEST_DB_SUFFIX}", or set SARDEENZ_ALLOW_NON_TEST_DB=1 to override (only for a throwaway DB).`,
      );
    }
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
    await db.query('TRUNCATE models, instances, memory_profiles, benchmarks, settings CASCADE');
  }

  async function teardown(): Promise<void> {
    const keys = await redis.keys(`${keyPrefix}:*`);
    if (keys.length > 0) {
      await redis.del(...keys);
    }
    redis.disconnect();
    // Leave no residue behind, so the last test of a run doesn't linger in the test DB (this is the
    // very failure mode that seeded herd-model/stuck-model into the dev DB before this fix).
    await db.query('TRUNCATE models, instances, memory_profiles, benchmarks, settings CASCADE');
    await db.end();
  }

  return {
    redis,
    db,
    keyPrefix,
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
    registerWorker,
    setup,
    teardown,
  };
}
