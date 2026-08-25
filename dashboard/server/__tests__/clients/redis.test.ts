// @vitest-environment node
/**
 * Integration-style tests for RedisReader that seed an in-memory key store
 * with the exact data shapes written by the control plane's
 * ModelLifecycleService and WorkerPoolService, then verify the dashboard
 * reads them correctly.
 *
 * These tests would have caught the original bug: the dashboard was reading
 * a multi-key schema (models:state:*, models:worker:*, etc.) while the
 * control plane writes single JSON blobs at models:{modelName}.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ModelLifecycleState, WorkerStatus } from '@sardeenz/types';
import type { ControlPlaneComponents } from '@sardeenz/types';

type ModelInfo = ControlPlaneComponents['schemas']['ModelInfo'];
type WorkerInfo = ControlPlaneComponents['schemas']['WorkerInfo'];

// ---------------------------------------------------------------------------
// In-memory Redis mock — simulates only the operations used by RedisReader.
// ---------------------------------------------------------------------------

type PipelineResult = [Error | null, unknown];

class MockRedis {
  readonly store = new Map<string, string>();
  readonly options = {};

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.store.get(key) ?? null);
  }

  set(key: string, value: string): Promise<'OK'> {
    this.store.set(key, value);
    return Promise.resolve('OK');
  }

  /**
   * SCAN mock — returns all matching keys in a single cursor iteration.
   * Supports basic glob patterns with `*` as wildcard.
   */
  scan(_cursor: string, _match: string, pattern: string): Promise<[string, string[]]> {
    const regex = new RegExp(
      '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$',
    );
    const keys = Array.from(this.store.keys()).filter((k) => regex.test(k));
    return Promise.resolve(['0', keys]);
  }

  pipeline(): MockPipeline {
    return new MockPipeline(this);
  }

  ping(): Promise<string> {
    return Promise.resolve('PONG');
  }

  disconnect(): void {
    // noop
  }
}

class MockPipeline {
  private readonly ops: Array<() => PipelineResult> = [];

  constructor(private readonly redis: MockRedis) {}

  get(key: string): this {
    this.ops.push(() => {
      const val = this.redis.store.get(key) ?? null;
      return [null, val];
    });
    return this;
  }

  set(key: string, value: string): this {
    this.ops.push(() => {
      this.redis.store.set(key, value);
      return [null, 'OK'];
    });
    return this;
  }

  exec(): Promise<PipelineResult[]> {
    return Promise.resolve(this.ops.map((op) => op()));
  }
}

// ---------------------------------------------------------------------------
// Dynamically import RedisReader, injecting the mock Redis constructor.
// ---------------------------------------------------------------------------

// We cannot easily mock the `ioredis` constructor at module level in Vitest
// ESM mode, so instead we create the mock and then poke it in via the config
// object's redisUrl path.  However, RedisReader instantiates `new Redis(url)`
// internally, so we override the module import.

vi.mock('ioredis', () => {
  // The real `ioredis` default export is a class. We substitute our mock.
  return { Redis: MockRedis, default: MockRedis };
});

// Now import the module under test — it will receive our mocked Redis.
const { RedisReader } = await import('../../clients/redis.js');
import type { Config } from '../../config.js';

const PREFIX = 'sardeenz';

const mockConfig: Config = {
  listenAddr: '0.0.0.0',
  listenPort: 4000,
  logLevel: 'silent',
  controlPlaneUrl: 'http://cp.test',
  redisUrl: 'redis://localhost:6379',
  redisKeyPrefix: PREFIX,
  prometheusUrl: 'http://prom.test',
  inferenceUrl: 'http://inference.test',
  authMode: 'none',
  adminUsername: 'admin',
  adminPassword: '',
  jwtSecret: '',
  jwtExpirationHours: 8,
  oauthClientId: 'sardeenz',
  oauthClientSecret: '',
  oauthIssuerUrl: '',
  k8sApiUrl: '',
  namespace: 'sardeenz',
  controlPlaneApiToken: '',
  publicUrl: '',
};

// ---------------------------------------------------------------------------
// Helper: access the mock Redis store behind a RedisReader
// ---------------------------------------------------------------------------

function getStore(reader: InstanceType<typeof RedisReader>): Map<string, string> {
  // Access the private `client` field which is our MockRedis instance.
  const readerObj: Record<string, unknown> = reader as unknown as Record<string, unknown>;
  return (readerObj['client'] as MockRedis).store;
}

// ---------------------------------------------------------------------------
// Control-plane-compatible seed data
// ---------------------------------------------------------------------------

/**
 * Seed a model instance into the store using the exact shape and key pattern written by
 * ModelLifecycleService.createInstance / .transition (#120: one blob per instance, at
 * `{prefix}:models:{modelName}:{instanceId}`, not one blob per model).
 */
function seedModel(
  store: Map<string, string>,
  opts: {
    modelName: string;
    state: ModelLifecycleState;
    instanceId?: string;
    workerId?: string | null;
    stateChangedAt?: string;
    lastInferenceAt?: string | null;
  },
): void {
  const instanceId = opts.instanceId ?? `inst-${opts.modelName}`;
  const blob = {
    instanceId,
    modelName: opts.modelName,
    state: opts.state,
    workerId: opts.workerId ?? null,
    runnerHost: null,
    runnerPort: null,
    runnerId: null,
    lastInferenceAt: opts.lastInferenceAt ?? null,
    stateChangedAt: opts.stateChangedAt ?? '2026-01-01T00:00:00.000Z',
    errorMessage: null,
  };
  store.set(`${PREFIX}:models:${opts.modelName}:${instanceId}`, JSON.stringify(blob));
}

/**
 * Seed a worker info + heartbeat using the exact keys written by
 * WorkerPoolService.discoverWorkers and the runner registration path.
 */
function seedWorkerInfo(
  store: Map<string, string>,
  opts: {
    workerId: string;
    devices: Array<{ deviceIndex: number; deviceType: string; memoryTotalBytes: number }>;
    heartbeatAt?: string | null;
    capabilities?: Array<{
      runnerType: string;
      engineName: string;
      supportedModelTypes: string[];
      supportedDeviceTypes: string[];
      supportedSleepLevels: string[];
    }>;
  },
): void {
  const infoPayload = {
    capabilities: opts.capabilities ?? [],
    devices: opts.devices,
  };
  store.set(`${PREFIX}:workers:${opts.workerId}:info`, JSON.stringify(infoPayload));

  if (opts.heartbeatAt) {
    store.set(`${PREFIX}:workers:${opts.workerId}:heartbeat`, opts.heartbeatAt);
  }
}

/**
 * Seed a worker detail snapshot using the exact key written by
 * WorkerPoolService.checkHeartbeats → writeWorkerDetailSnapshots.
 */
function seedWorkerDetail(
  store: Map<string, string>,
  opts: {
    workerId: string;
    status: WorkerStatus;
    // Mirrors the exact shape WorkerPoolService.validateDevice persists onto `:detail`
    // records — deviceIndex/deviceType/memoryTotalBytes only. used/available/reserved/
    // measured never reach this path in production (see resolveClusterStatusMemory in
    // server/clients/redis.ts); seed those via the {prefix}:cluster:memory snapshot instead.
    devices: Array<{ deviceIndex: number; deviceType: string; memoryTotalBytes: number }>;
    lastHeartbeatAt?: string | null;
    joinedAt?: string;
    capabilities?: Array<{
      runnerType: string;
      engineName: string;
      supportedModelTypes: string[];
      supportedDeviceTypes: string[];
      supportedSleepLevels: string[];
    }>;
  },
): void {
  const record = {
    workerId: opts.workerId,
    status: opts.status,
    capabilities: opts.capabilities ?? [],
    devices: opts.devices,
    lastHeartbeatAt: opts.lastHeartbeatAt ?? null,
    joinedAt: opts.joinedAt ?? '2026-01-01T00:00:00.000Z',
    managementUrl: null,
  };
  store.set(`${PREFIX}:worker:${opts.workerId}:detail`, JSON.stringify(record));
}

// ===========================================================================
// Tests
// ===========================================================================

describe('RedisReader — model fallback (control-plane-compatible keys)', () => {
  let reader: InstanceType<typeof RedisReader>;
  let store: Map<string, string>;

  beforeEach(() => {
    reader = new RedisReader(mockConfig);
    store = getStore(reader);
  });

  it('reads a model from the single JSON blob at {prefix}:models:{name}', async () => {
    seedModel(store, {
      modelName: 'llama-3',
      state: ModelLifecycleState.ACTIVE,
      workerId: 'worker-1',
      stateChangedAt: '2026-06-01T12:00:00.000Z',
    });

    const model = await reader.getModel('llama-3');

    expect(model).not.toBeNull();
    expect(model!.modelName).toBe('llama-3');
    expect(model!.state).toBe(ModelLifecycleState.ACTIVE);
    expect(model!.workerId).toBe('worker-1');
    expect(model!.createdAt).toBe('2026-06-01T12:00:00.000Z');
  });

  it('returns null for a model that does not exist', async () => {
    const model = await reader.getModel('nonexistent');
    expect(model).toBeNull();
  });

  it('lists all models from single JSON blobs', async () => {
    seedModel(store, { modelName: 'model-a', state: ModelLifecycleState.ACTIVE });
    seedModel(store, { modelName: 'model-b', state: ModelLifecycleState.SLEEPING });
    seedModel(store, { modelName: 'model-c', state: ModelLifecycleState.ERROR });

    const models = await reader.listModels();

    expect(models).toHaveLength(3);
    const names = models.map((m: ModelInfo) => m.modelName).sort();
    expect(names).toEqual(['model-a', 'model-b', 'model-c']);
  });

  it('prefers the dedicated inference timestamp key over the blob field', async () => {
    seedModel(store, {
      modelName: 'llama-3',
      state: ModelLifecycleState.ACTIVE,
      lastInferenceAt: '2026-06-01T10:00:00.000Z',
    });
    // The control plane writes a more recent timestamp to the dedicated key.
    store.set(`${PREFIX}:inference:last:llama-3`, '2026-06-15T10:00:00.000Z');

    const model = await reader.getModel('llama-3');

    expect(model!.lastInferenceAt).toBe('2026-06-15T10:00:00.000Z');
  });

  it('falls back to blob lastInferenceAt when dedicated key is absent', async () => {
    seedModel(store, {
      modelName: 'llama-3',
      state: ModelLifecycleState.ACTIVE,
      lastInferenceAt: '2026-06-01T10:00:00.000Z',
    });

    const model = await reader.getModel('llama-3');

    expect(model!.lastInferenceAt).toBe('2026-06-01T10:00:00.000Z');
  });

  it('falls back to ERROR for unknown state values', async () => {
    store.set(
      `${PREFIX}:models:bad-model:inst-bad-model`,
      JSON.stringify({
        instanceId: 'inst-bad-model',
        modelName: 'bad-model',
        state: 'INVALID_STATE',
        workerId: null,
      }),
    );

    const model = await reader.getModel('bad-model');

    expect(model).not.toBeNull();
    expect(model!.state).toBe(ModelLifecycleState.ERROR);
  });

  it('returns null for malformed JSON', async () => {
    store.set(`${PREFIX}:models:broken:inst-broken`, 'not valid json');

    const model = await reader.getModel('broken');

    expect(model).toBeNull();
  });

  it('getModelNames returns correct names from key pattern', async () => {
    seedModel(store, { modelName: 'alpha', state: ModelLifecycleState.ACTIVE });
    seedModel(store, { modelName: 'beta', state: ModelLifecycleState.SLEEPING });

    const names = await reader.getModelNames();

    expect(names.sort()).toEqual(['alpha', 'beta']);
  });

  // #120: a model can have N instance blobs; getModel aggregates them.
  describe('multi-instance aggregation (#120)', () => {
    it('reports instanceCount and aggregate ACTIVE when one instance is ACTIVE and one is ERROR', async () => {
      seedModel(store, {
        modelName: 'replica-model',
        instanceId: 'inst-a',
        state: ModelLifecycleState.ACTIVE,
        workerId: 'worker-a',
      });
      seedModel(store, {
        modelName: 'replica-model',
        instanceId: 'inst-b',
        state: ModelLifecycleState.ERROR,
        workerId: 'worker-b',
      });

      const model = await reader.getModel('replica-model');

      expect(model).not.toBeNull();
      expect(model!.instanceCount).toBe(2);
      expect(model!.state).toBe(ModelLifecycleState.ACTIVE);
      // workerId is ambiguous with 2 instances — must not pick one arbitrarily.
      expect(model!.workerId).toBeUndefined();
    });

    it('reports workerId only when the model has exactly one instance', async () => {
      seedModel(store, {
        modelName: 'single-instance-model',
        state: ModelLifecycleState.ACTIVE,
        workerId: 'worker-solo',
      });

      const model = await reader.getModel('single-instance-model');

      expect(model!.instanceCount).toBe(1);
      expect(model!.workerId).toBe('worker-solo');
    });

    it('getModelNames deduplicates model names across multiple instance keys', async () => {
      seedModel(store, {
        modelName: 'dup-name-model',
        instanceId: 'inst-a',
        state: ModelLifecycleState.ACTIVE,
      });
      seedModel(store, {
        modelName: 'dup-name-model',
        instanceId: 'inst-b',
        state: ModelLifecycleState.ACTIVE,
      });

      const names = await reader.getModelNames();

      expect(names).toEqual(['dup-name-model']);
    });

    it('listModels counts each logical model once regardless of instance count', async () => {
      seedModel(store, {
        modelName: 'replica-model',
        instanceId: 'inst-a',
        state: ModelLifecycleState.ACTIVE,
      });
      seedModel(store, {
        modelName: 'replica-model',
        instanceId: 'inst-b',
        state: ModelLifecycleState.ACTIVE,
      });
      seedModel(store, { modelName: 'solo-model', state: ModelLifecycleState.SLEEPING });

      const models = await reader.listModels();

      expect(models).toHaveLength(2);
    });
  });
});

describe('RedisReader — worker fallback (control-plane-compatible keys)', () => {
  let reader: InstanceType<typeof RedisReader>;
  let store: Map<string, string>;

  beforeEach(() => {
    reader = new RedisReader(mockConfig);
    store = getStore(reader);
  });

  describe('via worker detail snapshots', () => {
    it('reads workers from {prefix}:worker:{id}:detail keys', async () => {
      seedWorkerDetail(store, {
        workerId: 'worker-1',
        status: WorkerStatus.ONLINE,
        devices: [{ deviceIndex: 0, deviceType: 'GPU', memoryTotalBytes: 8_000_000_000 }],
        lastHeartbeatAt: new Date().toISOString(),
      });

      const workers = await reader.listWorkers();

      expect(workers).toHaveLength(1);
      expect(workers[0].workerId).toBe('worker-1');
      expect(workers[0].status).toBe(WorkerStatus.ONLINE);
      expect(workers[0].devices).toHaveLength(1);
    });

    it('handles multiple detail snapshot workers', async () => {
      seedWorkerDetail(store, {
        workerId: 'w1',
        status: WorkerStatus.ONLINE,
        devices: [{ deviceIndex: 0, deviceType: 'GPU', memoryTotalBytes: 16_000_000_000 }],
      });
      seedWorkerDetail(store, {
        workerId: 'w2',
        status: WorkerStatus.OFFLINE,
        devices: [{ deviceIndex: 0, deviceType: 'GPU', memoryTotalBytes: 8_000_000_000 }],
      });

      const workers = await reader.listWorkers();

      expect(workers).toHaveLength(2);
      const ids = workers.map((w: WorkerInfo) => w.workerId).sort();
      expect(ids).toEqual(['w1', 'w2']);
    });
  });

  describe('via info + heartbeat keys (no detail snapshots)', () => {
    it('reads workers from info keys and derives status from heartbeat', async () => {
      // Seed info + fresh heartbeat — should resolve as ONLINE.
      seedWorkerInfo(store, {
        workerId: 'worker-fresh',
        devices: [{ deviceIndex: 0, deviceType: 'GPU', memoryTotalBytes: 8_000_000_000 }],
        heartbeatAt: new Date().toISOString(),
      });

      const workers = await reader.listWorkers();

      expect(workers).toHaveLength(1);
      expect(workers[0].workerId).toBe('worker-fresh');
      expect(workers[0].status).toBe(WorkerStatus.ONLINE);
    });

    it('marks worker OFFLINE when heartbeat is missing', async () => {
      seedWorkerInfo(store, {
        workerId: 'worker-no-hb',
        devices: [{ deviceIndex: 0, deviceType: 'GPU', memoryTotalBytes: 8_000_000_000 }],
        heartbeatAt: null,
      });

      const workers = await reader.listWorkers();

      expect(workers).toHaveLength(1);
      expect(workers[0].workerId).toBe('worker-no-hb');
      expect(workers[0].status).toBe(WorkerStatus.OFFLINE);
    });

    it('marks worker OFFLINE when heartbeat is expired', async () => {
      const expired = new Date(Date.now() - 60_000).toISOString(); // 60s ago
      seedWorkerInfo(store, {
        workerId: 'worker-old',
        devices: [{ deviceIndex: 0, deviceType: 'GPU', memoryTotalBytes: 8_000_000_000 }],
        heartbeatAt: expired,
      });

      const workers = await reader.listWorkers();

      expect(workers).toHaveLength(1);
      expect(workers[0].status).toBe(WorkerStatus.OFFLINE);
    });

    it('extracts workerId from key — does not require it in payload', async () => {
      // This is the critical regression: the old code required workerId in
      // the JSON payload, but the control plane's worker info payload does
      // NOT include workerId.
      const infoPayload = {
        capabilities: [],
        devices: [{ deviceIndex: 0, deviceType: 'GPU', memoryTotalBytes: 8_000_000_000 }],
      };
      store.set(`${PREFIX}:workers:gpu-node-42:info`, JSON.stringify(infoPayload));
      store.set(`${PREFIX}:workers:gpu-node-42:heartbeat`, new Date().toISOString());

      const workers = await reader.listWorkers();

      expect(workers).toHaveLength(1);
      expect(workers[0].workerId).toBe('gpu-node-42');
    });

    it('does not pick up heartbeat-only keys as workers', async () => {
      // Only a heartbeat key, no info key — should not appear.
      store.set(`${PREFIX}:workers:phantom:heartbeat`, new Date().toISOString());

      const workers = await reader.listWorkers();

      expect(workers).toHaveLength(0);
    });
  });

  it('getWorkerDetail reads from {prefix}:worker:{id}:detail', async () => {
    seedWorkerDetail(store, {
      workerId: 'worker-1',
      status: WorkerStatus.ONLINE,
      devices: [{ deviceIndex: 0, deviceType: 'GPU', memoryTotalBytes: 8_000_000_000 }],
      lastHeartbeatAt: '2026-06-15T10:00:00.000Z',
      joinedAt: '2026-01-01T00:00:00.000Z',
    });

    const detail = await reader.getWorkerDetail('worker-1');

    expect(detail).not.toBeNull();
    expect(detail!.workerId).toBe('worker-1');
    expect(detail!.status).toBe(WorkerStatus.ONLINE);
  });

  it('getWorkerDetail returns null for unknown worker', async () => {
    const detail = await reader.getWorkerDetail('nonexistent');
    expect(detail).toBeNull();
  });
});

describe('RedisReader — cluster status fallback', () => {
  let reader: InstanceType<typeof RedisReader>;
  let store: Map<string, string>;

  beforeEach(() => {
    reader = new RedisReader(mockConfig);
    store = getStore(reader);
  });

  it('computes cluster status from model blobs and worker details', async () => {
    seedModel(store, { modelName: 'active-1', state: ModelLifecycleState.ACTIVE });
    seedModel(store, { modelName: 'active-2', state: ModelLifecycleState.ACTIVE });
    seedModel(store, { modelName: 'sleeping-1', state: ModelLifecycleState.SLEEPING });
    seedModel(store, { modelName: 'error-1', state: ModelLifecycleState.ERROR });

    seedWorkerDetail(store, {
      workerId: 'w1',
      status: WorkerStatus.ONLINE,
      devices: [{ deviceIndex: 0, deviceType: 'GPU', memoryTotalBytes: 16_000_000_000 }],
    });
    seedWorkerDetail(store, {
      workerId: 'w2',
      status: WorkerStatus.OFFLINE,
      devices: [{ deviceIndex: 0, deviceType: 'GPU', memoryTotalBytes: 8_000_000_000 }],
    });

    const status = await reader.getClusterStatus();

    expect(status.modelCounts).toEqual({
      total: 4,
      active: 2,
      sleeping: 1,
      starting: 0,
      error: 1,
      other: 0,
    });
    expect(status.workerCount).toBe(2);
    expect(status.workersOnline).toBe(1);
    // Memory sums — detail snapshots carry memoryTotalBytes only, so
    // used/available/reserved default to 0 and measuredUsedBytes is omitted
    // (no device in this fixture reports an NVML measurement).
    expect(status.memory).toEqual({
      totalBytes: 24_000_000_000,
      usedBytes: 0,
      availableBytes: 0,
      reservedBytes: 0,
    });
  });

  it('returns zero counts when Redis is empty', async () => {
    const status = await reader.getClusterStatus();

    expect(status.modelCounts!.total).toBe(0);
    expect(status.workerCount).toBe(0);
  });

  // The `:detail` records that back listWorkers() only ever carry memoryTotalBytes per
  // device (WorkerPoolService.validateDevice strips used/available/reserved/measured), so
  // reservedBytes/measuredUsedBytes can only reach getClusterStatus() through the
  // control-plane-computed `{prefix}:cluster:memory` snapshot — the real shape written by
  // MemoryBudgetService.writeClusterMemorySnapshot/getClusterSummary. Seed that key
  // directly rather than the `:detail` devices (#163 review fix — the previous version of
  // these tests seeded a device shape the real writer never emits).
  it('prefers the cluster:memory snapshot summary (incl. reservedBytes/measuredUsedBytes) over detail sums', async () => {
    seedWorkerDetail(store, {
      workerId: 'w1',
      status: WorkerStatus.ONLINE,
      devices: [{ deviceIndex: 0, deviceType: 'GPU', memoryTotalBytes: 16_000_000_000 }],
    });
    seedWorkerDetail(store, {
      workerId: 'w2',
      status: WorkerStatus.ONLINE,
      devices: [{ deviceIndex: 0, deviceType: 'GPU', memoryTotalBytes: 8_000_000_000 }],
    });
    store.set(
      `${PREFIX}:cluster:memory`,
      JSON.stringify({
        workers: [
          {
            workerId: 'w1',
            devices: [
              {
                deviceIndex: 0,
                deviceType: 'GPU',
                memoryTotalBytes: 16_000_000_000,
                memoryUsedBytes: 4_000_000_000,
                memoryAvailableBytes: 10_000_000_000,
                memoryReservedBytes: 2_000_000_000,
                memoryMeasuredUsedBytes: 5_000_000_000,
              },
            ],
          },
          {
            workerId: 'w2',
            devices: [
              {
                deviceIndex: 0,
                deviceType: 'GPU',
                memoryTotalBytes: 8_000_000_000,
                memoryUsedBytes: 1_000_000_000,
                memoryAvailableBytes: 7_000_000_000,
                // No measurement reported for this device — must not zero out the aggregate.
              },
            ],
          },
        ],
        summary: {
          totalBytes: 24_000_000_000,
          usedBytes: 5_000_000_000,
          availableBytes: 17_000_000_000,
          reservedBytes: 2_000_000_000,
          measuredUsedBytes: 5_000_000_000,
        },
      }),
    );

    const status = await reader.getClusterStatus();

    expect(status.memory).toEqual({
      totalBytes: 24_000_000_000,
      usedBytes: 5_000_000_000,
      availableBytes: 17_000_000_000,
      reservedBytes: 2_000_000_000,
      measuredUsedBytes: 5_000_000_000,
    });
  });

  it('omits measuredUsedBytes when the cluster:memory snapshot summary omits it', async () => {
    store.set(
      `${PREFIX}:cluster:memory`,
      JSON.stringify({
        workers: [
          {
            workerId: 'w1',
            devices: [{ deviceIndex: 0, deviceType: 'GPU', memoryTotalBytes: 16_000_000_000 }],
          },
        ],
        summary: {
          totalBytes: 16_000_000_000,
          usedBytes: 0,
          availableBytes: 16_000_000_000,
          reservedBytes: 0,
        },
      }),
    );

    const status = await reader.getClusterStatus();

    expect(status.memory).not.toHaveProperty('measuredUsedBytes');
  });

  it('falls back to summing :detail devices when no cluster:memory snapshot exists', async () => {
    seedWorkerDetail(store, {
      workerId: 'w1',
      status: WorkerStatus.ONLINE,
      devices: [{ deviceIndex: 0, deviceType: 'GPU', memoryTotalBytes: 16_000_000_000 }],
    });

    const status = await reader.getClusterStatus();

    // No snapshot present — falls back to the detail-sum path, which (per the real
    // writer's device shape) only ever carries totalBytes.
    expect(status.memory).toEqual({
      totalBytes: 16_000_000_000,
      usedBytes: 0,
      availableBytes: 0,
      reservedBytes: 0,
    });
  });
});

describe('RedisReader — cluster memory fallback', () => {
  let reader: InstanceType<typeof RedisReader>;
  let store: Map<string, string>;

  beforeEach(() => {
    reader = new RedisReader(mockConfig);
    store = getStore(reader);
  });

  it('reads cluster memory snapshot from {prefix}:cluster:memory', async () => {
    const snapshot = {
      workers: [
        {
          workerId: 'w1',
          devices: [
            {
              deviceIndex: 0,
              deviceType: 'GPU',
              memoryTotalBytes: 16_000_000_000,
              memoryUsedBytes: 4_000_000_000,
              memoryAvailableBytes: 12_000_000_000,
            },
          ],
        },
      ],
      summary: {
        totalBytes: 16_000_000_000,
        usedBytes: 4_000_000_000,
        availableBytes: 12_000_000_000,
        reservedBytes: 0,
      },
    };
    store.set(`${PREFIX}:cluster:memory`, JSON.stringify(snapshot));

    const memory = await reader.getClusterMemory();

    expect(memory).not.toBeNull();
    expect(memory!.summary.totalBytes).toBe(16_000_000_000);
    expect(memory!.workers).toHaveLength(1);
  });

  it('returns null when no cluster memory snapshot exists', async () => {
    const memory = await reader.getClusterMemory();
    expect(memory).toBeNull();
  });
});

describe('RedisReader — isHealthy', () => {
  it('returns true when ping succeeds', async () => {
    const reader = new RedisReader(mockConfig);
    const healthy = await reader.isHealthy();
    expect(healthy).toBe(true);
  });
});
