import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';
import { WorkerStatus } from '@sardeenz/types';

import { WorkerPoolService } from '../worker-pool.js';
import type { Redis } from '../../clients/redis.js';

// ---------------------------------------------------------------------------
// Mock Redis helpers
// ---------------------------------------------------------------------------

const KEY_PREFIX = 'sardeenz';
const HEARTBEAT_TIMEOUT_SECS = 60;

function infoKey(workerId: string): string {
  return `${KEY_PREFIX}:workers:${workerId}:info`;
}

function makeMockRedis(infoRecords: Record<string, string>): { redis: Redis } {
  const infoKeys = Object.keys(infoRecords);
  const scan = vi.fn().mockResolvedValue(['0', infoKeys]);

  const pipeline = vi.fn().mockImplementation(() => {
    const queuedKeys: string[] = [];
    const pipelineObj = {
      get: vi.fn((key: string) => {
        queuedKeys.push(key);
        return pipelineObj;
      }),
      exec: vi.fn(() =>
        Promise.resolve(
          queuedKeys.map((k) => [null, infoRecords[k] ?? null] as [null, string | null]),
        ),
      ),
    };
    return pipelineObj;
  });

  const redis = { scan, pipeline } as unknown as Redis;
  return { redis };
}

function makeService(redis: Redis): WorkerPoolService {
  return new WorkerPoolService(redis, KEY_PREFIX, HEARTBEAT_TIMEOUT_SECS);
}

/**
 * Map-backed Redis for stateful discovery tests: SCAN with one `*`, pipelines of get/set, and del.
 * TTL arguments are accepted and ignored (no test waits for expiry).
 */
function makeMutableRedis(seed: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(seed));
  const matches = (pattern: string, key: string): boolean => {
    const re = new RegExp(
      '^' +
        pattern
          .split('*')
          .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .join('.*') +
        '$',
    );
    return re.test(key);
  };
  const scan = vi.fn((_cursor: string, _match: string, pattern: string) => {
    const keys = Array.from(store.keys()).filter((k) => matches(pattern, k));
    return Promise.resolve(['0', keys] as [string, string[]]);
  });
  const pipeline = vi.fn(() => {
    const ops: Array<() => [null, unknown]> = [];
    const pipe = {
      get: vi.fn((key: string) => {
        ops.push(() => [null, store.get(key) ?? null]);
        return pipe;
      }),
      set: vi.fn((...args: unknown[]) => {
        const [key, value] = args as [string, string];
        ops.push(() => {
          store.set(key, value);
          return [null, 'OK'];
        });
        return pipe;
      }),
      exec: vi.fn(() => Promise.resolve(ops.map((op) => op()))),
    };
    return pipe;
  });
  const del = vi.fn((...keys: string[]) => {
    let removed = 0;
    for (const key of keys) if (store.delete(key)) removed += 1;
    return Promise.resolve(removed);
  });
  const redis = { scan, pipeline, del } as unknown as Redis;
  return { redis, store };
}

function validPayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    capabilities: [
      {
        runnerType: 'vllm',
        engineName: 'vLLM',
        supportedModelTypes: ['LLM'],
        supportedDeviceTypes: ['CUDA'],
        supportedSleepLevels: ['L1_HOST_RAM'],
      },
    ],
    devices: [{ deviceIndex: 0, deviceType: 'CUDA', memoryTotalBytes: 16_000_000_000 }],
    managementUrl: 'http://worker1:9100',
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('WorkerPoolService — parseWorkerInfo (via discoverWorkers)', () => {
  let warnSpy: MockInstance<(...args: unknown[]) => void>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('accepts a valid full payload', async () => {
    const workerId = 'w1';
    const { redis } = makeMockRedis({ [infoKey(workerId)]: validPayload() });
    const service = makeService(redis);

    await service.discoverWorkers();

    const worker = service.getWorker(workerId);
    expect(worker).not.toBeNull();
    expect(worker?.capabilities).toHaveLength(1);
    expect(worker?.capabilities[0]?.runnerType).toBe('vllm');
    expect(worker?.devices).toHaveLength(1);
    expect(worker?.managementUrl).toBe('http://worker1:9100');
  });

  it('accepts a valid minimal payload (optional capability fields omitted) and applies defaults', async () => {
    const workerId = 'w1';
    const payload = validPayload({
      capabilities: [
        {
          runnerType: 'vllm',
          engineName: 'vLLM',
          supportedModelTypes: ['LLM'],
          supportedDeviceTypes: ['CUDA'],
          supportedSleepLevels: ['L1_HOST_RAM'],
        },
      ],
    });
    const { redis } = makeMockRedis({ [infoKey(workerId)]: payload });
    const service = makeService(redis);

    await service.discoverWorkers();

    const worker = service.getWorker(workerId);
    expect(worker).not.toBeNull();
    expect(worker?.capabilities[0]?.maxTensorParallelism).toBe(1);
    expect(worker?.capabilities[0]?.kvCacheElasticSharing).toBe(false);
  });

  it('rejects a payload with non-array devices', async () => {
    const workerId = 'w1';
    const payload = validPayload({ devices: 'not-an-array' });
    const { redis } = makeMockRedis({ [infoKey(workerId)]: payload });
    const service = makeService(redis);

    await service.discoverWorkers();

    expect(service.getWorker(workerId)).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('devices'));
  });

  it('accepts an empty devices array and logs a warning', async () => {
    const workerId = 'w1';
    const payload = validPayload({ devices: [] });
    const { redis } = makeMockRedis({ [infoKey(workerId)]: payload });
    const service = makeService(redis);

    await service.discoverWorkers();

    const worker = service.getWorker(workerId);
    expect(worker).not.toBeNull();
    expect(worker?.devices).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('devices'));
  });

  it('rejects a payload with an empty capabilities array', async () => {
    const workerId = 'w1';
    const payload = validPayload({ capabilities: [] });
    const { redis } = makeMockRedis({ [infoKey(workerId)]: payload });
    const service = makeService(redis);

    await service.discoverWorkers();

    expect(service.getWorker(workerId)).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('capabilities'));
  });

  it('rejects a device missing memoryTotalBytes', async () => {
    const workerId = 'w1';
    const payload = validPayload({ devices: [{ deviceIndex: 0, deviceType: 'CUDA' }] });
    const { redis } = makeMockRedis({ [infoKey(workerId)]: payload });
    const service = makeService(redis);

    await service.discoverWorkers();

    expect(service.getWorker(workerId)).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('memoryTotalBytes'));
  });

  it('rejects a device with a numeric-string byte count', async () => {
    const workerId = 'w1';
    const payload = validPayload({
      devices: [{ deviceIndex: 0, deviceType: 'CUDA', memoryTotalBytes: '16000000000' }],
    });
    const { redis } = makeMockRedis({ [infoKey(workerId)]: payload });
    const service = makeService(redis);

    await service.discoverWorkers();

    expect(service.getWorker(workerId)).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('memoryTotalBytes'));
  });

  it('rejects a device with a negative byte count', async () => {
    const workerId = 'w1';
    const payload = validPayload({
      devices: [{ deviceIndex: 0, deviceType: 'CUDA', memoryTotalBytes: -1 }],
    });
    const { redis } = makeMockRedis({ [infoKey(workerId)]: payload });
    const service = makeService(redis);

    await service.discoverWorkers();

    expect(service.getWorker(workerId)).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('memoryTotalBytes'));
  });

  it('rejects invalid enum values in supportedDeviceTypes', async () => {
    const workerId = 'w1';
    const payload = validPayload({
      capabilities: [
        {
          runnerType: 'vllm',
          engineName: 'vLLM',
          supportedModelTypes: ['LLM'],
          supportedDeviceTypes: ['BOGUS'],
          supportedSleepLevels: ['L1_HOST_RAM'],
        },
      ],
    });
    const { redis } = makeMockRedis({ [infoKey(workerId)]: payload });
    const service = makeService(redis);

    await service.discoverWorkers();

    expect(service.getWorker(workerId)).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('supportedDeviceTypes'));
  });

  it('rejects an invalid deviceType on a device', async () => {
    const workerId = 'w1';
    const payload = validPayload({
      devices: [{ deviceIndex: 0, deviceType: 'BOGUS', memoryTotalBytes: 16_000_000_000 }],
    });
    const { redis } = makeMockRedis({ [infoKey(workerId)]: payload });
    const service = makeService(redis);

    await service.discoverWorkers();

    expect(service.getWorker(workerId)).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('deviceType'));
  });

  it('rejects a payload missing managementUrl', async () => {
    const workerId = 'w1';
    const raw = JSON.parse(validPayload()) as Record<string, unknown>;
    delete raw.managementUrl;
    const payload = JSON.stringify(raw);
    const { redis } = makeMockRedis({ [infoKey(workerId)]: payload });
    const service = makeService(redis);

    await service.discoverWorkers();

    expect(service.getWorker(workerId)).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('managementUrl'));
  });

  it.each([
    ['a bare host:port (no scheme)', 'worker1:9100'],
    ['a non-http scheme', 'ftp://worker1:9100'],
    ['a relative path', '/workers/w1'],
  ])('rejects managementUrl that is %s', async (_label, managementUrl) => {
    const workerId = 'w1';
    const { redis } = makeMockRedis({ [infoKey(workerId)]: validPayload({ managementUrl }) });
    const service = makeService(redis);

    await service.discoverWorkers();

    expect(service.getWorker(workerId)).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('managementUrl'));
  });

  it('accepts an https managementUrl', async () => {
    const workerId = 'w1';
    const { redis } = makeMockRedis({
      [infoKey(workerId)]: validPayload({ managementUrl: 'https://worker1.example:9100' }),
    });
    const service = makeService(redis);

    await service.discoverWorkers();

    expect(service.getWorker(workerId)?.managementUrl).toBe('https://worker1.example:9100');
  });
});

describe('WorkerPoolService — deleteWorkerState (#240)', () => {
  it('deletes exactly the info, heartbeat and memory keys', async () => {
    const del = vi.fn().mockResolvedValue(3);
    const service = makeService({ del } as unknown as Redis);

    await service.deleteWorkerState('w1');

    expect(del).toHaveBeenCalledTimes(1);
    expect(del).toHaveBeenCalledWith(
      'sardeenz:workers:w1:info',
      'sardeenz:workers:w1:heartbeat',
      'sardeenz:workers:w1:memory',
    );
  });

  it('propagates a Redis error', async () => {
    const service = makeService({
      del: vi.fn().mockRejectedValue(new Error('redis down')),
    } as unknown as Redis);

    await expect(service.deleteWorkerState('w1')).rejects.toThrow('redis down');
  });

  it('a rediscovered OFFLINE worker leaves nothing for the next discovery after removeWorker + deleteWorkerState (#240)', async () => {
    const { redis } = makeMutableRedis({ [infoKey('w1')]: validPayload() });
    const service = makeService(redis);

    await service.discoverWorkers();
    expect(service.getWorker('w1')?.status).toBe(WorkerStatus.OFFLINE); // no heartbeat key
    service.removeWorker('w1');
    await service.deleteWorkerState('w1');
    await service.discoverWorkers();

    expect(service.getAllWorkers()).toEqual([]);
  });
});
