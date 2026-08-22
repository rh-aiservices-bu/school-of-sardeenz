import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { MemoryBudgetService } from '../memory-budget.js';
import type { Redis } from '../../clients/redis.js';

// ---------------------------------------------------------------------------
// Mock Redis helpers
// ---------------------------------------------------------------------------

function makeMockRedis(workerReports: Record<string, string> = {}): {
  redis: Redis;
  get: ReturnType<typeof vi.fn>;
  scan: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  pipeline: ReturnType<typeof vi.fn>;
} {
  // Build a scan result that lists all known worker memory keys
  const allKeys = Object.keys(workerReports);

  const scan = vi.fn().mockResolvedValue(['0', allKeys]);

  const get = vi.fn().mockImplementation((key: string) => {
    return Promise.resolve(workerReports[key] ?? null);
  });

  // set() is called by writeClusterMemorySnapshot after refreshAll
  const set = vi.fn().mockResolvedValue('OK');

  // Pipeline mock: collects get() calls, returns their results on exec()
  const pipelineGet = vi.fn().mockReturnThis();
  const exec = vi.fn().mockImplementation(() => {
    const results = allKeys.map((k) => [null, workerReports[k] ?? null] as [null, string | null]);
    return Promise.resolve(results);
  });

  const pipeline = vi.fn().mockReturnValue({ get: pipelineGet, exec });

  const redis = { get, scan, set, pipeline } as unknown as Redis;

  return { redis, get, scan, set, pipeline };
}

function workerMemoryReport(
  devices: Array<{
    deviceIndex: number;
    deviceType: string;
    memoryUsedBytes: number;
    memoryTotalBytes: number;
  }>,
  reportedAt?: string,
): string {
  return JSON.stringify({ devices, reportedAt: reportedAt ?? new Date().toISOString() });
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

const KEY_PREFIX = 'sardeenz';
const HEARTBEAT_TIMEOUT_SECS = 60;

function makeService(redis: Redis): MemoryBudgetService {
  return new MemoryBudgetService(redis, KEY_PREFIX, HEARTBEAT_TIMEOUT_SECS);
}

function workerKey(workerId: string): string {
  return `${KEY_PREFIX}:workers:${workerId}:memory`;
}

// ---------------------------------------------------------------------------
// Issue #87: reservations must survive refreshAll/refreshWorkerBudget regardless
// of what usedBytes the worker reports — they are only ever cleared explicitly via
// releaseModelReservations or clearWorkerReservations, never inferred from usage.
// ---------------------------------------------------------------------------

describe('MemoryBudgetService — reservations survive refreshes', () => {
  it('preserves a reservation across refreshAll even once the worker report reflects the usage', async () => {
    const workerId = 'w1';
    const deviceIndex = 0;
    const reservedBytes = 8_000_000_000; // 8 GB
    const totalBytes = 24_000_000_000;

    const report = workerMemoryReport([
      {
        deviceIndex,
        deviceType: 'CUDA',
        memoryUsedBytes: reservedBytes,
        memoryTotalBytes: totalBytes,
      },
    ]);
    const { redis } = makeMockRedis({ [workerKey(workerId)]: report });
    const service = makeService(redis);

    await service.refreshAll();
    service.reserveCapacity(workerId, deviceIndex, 'model-a', reservedBytes);

    // refreshAll must not infer satisfaction from usedBytes — only explicit release does.
    await service.refreshAll();
    await service.refreshAll();

    const budget = service.getWorkerBudget(workerId);
    expect(budget).not.toBeNull();
    const device = budget?.devices[0];
    expect(device?.reservedBytes).toBe(reservedBytes);
    // total - used - reserved = 24GB - 8GB - 8GB = 8GB
    expect(device?.availableBytes).toBe(totalBytes - reservedBytes - reservedBytes);
  });

  it('preserves a reservation across refreshWorkerBudget regardless of reported usage', async () => {
    const workerId = 'w1';
    const deviceIndex = 0;
    const reservedBytes = 8_000_000_000;
    const totalBytes = 24_000_000_000;

    const get = vi
      .fn()
      .mockResolvedValueOnce(
        workerMemoryReport([
          { deviceIndex, deviceType: 'CUDA', memoryUsedBytes: 0, memoryTotalBytes: totalBytes },
        ]),
      )
      .mockResolvedValueOnce(
        workerMemoryReport([
          {
            deviceIndex,
            deviceType: 'CUDA',
            memoryUsedBytes: reservedBytes,
            memoryTotalBytes: totalBytes,
          },
        ]),
      );
    const redis = { get } as unknown as Redis;
    const service = makeService(redis);

    await service.refreshWorkerBudget(workerId);
    service.reserveCapacity(workerId, deviceIndex, 'model-a', reservedBytes);

    await service.refreshWorkerBudget(workerId);

    const budget = service.getWorkerBudget(workerId);
    const device = budget?.devices[0];
    expect(device?.reservedBytes).toBe(reservedBytes);
    expect(device?.availableBytes).toBe(totalBytes - reservedBytes - reservedBytes);
  });

  it('removes the budget but not reservations for other workers when one worker disappears', async () => {
    const deadWorker = 'dead';
    const liveWorker = 'live';
    const deviceIndex = 0;
    const totalBytes = 16_000_000_000;
    const reservedBytes = 4_000_000_000;

    const get = vi.fn().mockImplementation((key: string) => {
      if (key.includes(liveWorker)) {
        return Promise.resolve(
          workerMemoryReport([
            { deviceIndex, deviceType: 'CUDA', memoryUsedBytes: 0, memoryTotalBytes: totalBytes },
          ]),
        );
      }
      return Promise.resolve(null); // dead worker has no key
    });
    const redis = { get } as unknown as Redis;
    const service = makeService(redis);

    await service.refreshWorkerBudget(liveWorker);
    service.reserveCapacity(liveWorker, deviceIndex, 'model-a', reservedBytes);

    await service.refreshWorkerBudget(deadWorker);

    const liveBudget = service.getWorkerBudget(liveWorker);
    expect(liveBudget?.devices[0]?.reservedBytes).toBe(reservedBytes);
  });
});

// ---------------------------------------------------------------------------
// Issue #87: vanished worker (refreshAll) clears its reservations
// ---------------------------------------------------------------------------

describe('MemoryBudgetService — vanished worker clears reservations', () => {
  it('clears reservations when a worker key disappears from refreshAll, so a rejoining worker starts clean', async () => {
    const workerId = 'w1';
    const deviceIndex = 0;
    const totalBytes = 16_000_000_000;
    const reservedBytes = 4_000_000_000;

    const report = workerMemoryReport([
      { deviceIndex, deviceType: 'CUDA', memoryUsedBytes: 0, memoryTotalBytes: totalBytes },
    ]);
    const { redis, scan, pipeline, get } = makeMockRedis({ [workerKey(workerId)]: report });
    const service = makeService(redis);

    await service.refreshAll();
    service.reserveCapacity(workerId, deviceIndex, 'model-a', reservedBytes);
    expect(service.getWorkerBudget(workerId)?.devices[0]?.reservedBytes).toBe(reservedBytes);

    // Worker's memory key vanishes from Redis (no longer scanned).
    scan.mockResolvedValue(['0', []]);
    pipeline.mockReturnValue({ get: vi.fn().mockReturnThis(), exec: vi.fn().mockResolvedValue([]) });

    await service.refreshAll();

    expect(service.getWorkerBudget(workerId)).toBeNull();

    // Worker rejoins and reports the same key — its old reservation must not resurface.
    get.mockResolvedValue(report);
    const rejoined = await service.refreshWorkerBudget(workerId);
    expect(rejoined?.devices[0]?.reservedBytes).toBe(0);
    expect(rejoined?.devices[0]?.availableBytes).toBe(totalBytes);
  });
});

// ---------------------------------------------------------------------------
// Reservation mechanics
// ---------------------------------------------------------------------------

describe('MemoryBudgetService — reservation mechanics', () => {
  it('reserveCapacity reduces availableBytes immediately', async () => {
    const workerId = 'w1';
    const deviceIndex = 0;
    const totalBytes = 16_000_000_000;
    const reservedBytes = 6_000_000_000;

    const get = vi
      .fn()
      .mockResolvedValue(
        workerMemoryReport([
          { deviceIndex, deviceType: 'CUDA', memoryUsedBytes: 0, memoryTotalBytes: totalBytes },
        ]),
      );
    const redis = { get } as unknown as Redis;
    const service = makeService(redis);

    await service.refreshWorkerBudget(workerId);
    service.reserveCapacity(workerId, deviceIndex, 'model-a', reservedBytes);

    const budget = service.getWorkerBudget(workerId);
    const device = budget?.devices[0];
    expect(device?.reservedBytes).toBe(reservedBytes);
    expect(device?.availableBytes).toBe(totalBytes - reservedBytes);
  });

  it('reserveCapacity is idempotent for the same model — repeated calls do not accumulate', async () => {
    const workerId = 'w1';
    const deviceIndex = 0;
    const totalBytes = 16_000_000_000;
    const reservedBytes = 6_000_000_000;

    const get = vi
      .fn()
      .mockResolvedValue(
        workerMemoryReport([
          { deviceIndex, deviceType: 'CUDA', memoryUsedBytes: 0, memoryTotalBytes: totalBytes },
        ]),
      );
    const redis = { get } as unknown as Redis;
    const service = makeService(redis);

    await service.refreshWorkerBudget(workerId);
    service.reserveCapacity(workerId, deviceIndex, 'model-a', reservedBytes);
    service.reserveCapacity(workerId, deviceIndex, 'model-a', reservedBytes);
    service.reserveCapacity(workerId, deviceIndex, 'model-a', reservedBytes);

    const budget = service.getWorkerBudget(workerId);
    const device = budget?.devices[0];
    expect(device?.reservedBytes).toBe(reservedBytes);
    expect(device?.availableBytes).toBe(totalBytes - reservedBytes);
  });

  it('co-located models on the same device sum their reservations for availableBytes', async () => {
    const workerId = 'w1';
    const deviceIndex = 0;
    const totalBytes = 16_000_000_000;
    const modelABytes = 4_000_000_000;
    const modelBBytes = 3_000_000_000;

    const get = vi
      .fn()
      .mockResolvedValue(
        workerMemoryReport([
          { deviceIndex, deviceType: 'CUDA', memoryUsedBytes: 0, memoryTotalBytes: totalBytes },
        ]),
      );
    const redis = { get } as unknown as Redis;
    const service = makeService(redis);

    await service.refreshWorkerBudget(workerId);
    service.reserveCapacity(workerId, deviceIndex, 'model-a', modelABytes);
    service.reserveCapacity(workerId, deviceIndex, 'model-b', modelBBytes);

    const budget = service.getWorkerBudget(workerId);
    const device = budget?.devices[0];
    expect(device?.reservedBytes).toBe(modelABytes + modelBBytes);
    expect(device?.availableBytes).toBe(totalBytes - modelABytes - modelBBytes);
  });

  it('releaseModelReservations restores availableBytes for the released model only', async () => {
    const workerId = 'w1';
    const deviceIndex = 0;
    const totalBytes = 16_000_000_000;
    const modelABytes = 6_000_000_000;
    const modelBBytes = 3_000_000_000;

    const get = vi
      .fn()
      .mockResolvedValue(
        workerMemoryReport([
          { deviceIndex, deviceType: 'CUDA', memoryUsedBytes: 0, memoryTotalBytes: totalBytes },
        ]),
      );
    const redis = { get } as unknown as Redis;
    const service = makeService(redis);

    await service.refreshWorkerBudget(workerId);
    service.reserveCapacity(workerId, deviceIndex, 'model-a', modelABytes);
    service.reserveCapacity(workerId, deviceIndex, 'model-b', modelBBytes);

    service.releaseModelReservations('model-a');

    const budget = service.getWorkerBudget(workerId);
    const device = budget?.devices[0];
    expect(device?.reservedBytes).toBe(modelBBytes);
    expect(device?.availableBytes).toBe(totalBytes - modelBBytes);
  });

  it('releaseModelReservations removes the model from every device it reserved on', async () => {
    const workerId = 'w1';
    const totalBytes = 16_000_000_000;
    const bytesPerDevice = 4_000_000_000;

    const get = vi.fn().mockResolvedValue(
      workerMemoryReport([
        { deviceIndex: 0, deviceType: 'CUDA', memoryUsedBytes: 0, memoryTotalBytes: totalBytes },
        { deviceIndex: 1, deviceType: 'CUDA', memoryUsedBytes: 0, memoryTotalBytes: totalBytes },
      ]),
    );
    const redis = { get } as unknown as Redis;
    const service = makeService(redis);

    await service.refreshWorkerBudget(workerId);
    service.reserveCapacity(workerId, 0, 'model-a', bytesPerDevice);
    service.reserveCapacity(workerId, 1, 'model-a', bytesPerDevice);

    service.releaseModelReservations('model-a');

    const budget = service.getWorkerBudget(workerId);
    expect(budget?.devices[0]?.reservedBytes).toBe(0);
    expect(budget?.devices[1]?.reservedBytes).toBe(0);
    expect(budget?.devices[0]?.availableBytes).toBe(totalBytes);
    expect(budget?.devices[1]?.availableBytes).toBe(totalBytes);
  });

  it('releaseModelReservations is idempotent — releasing twice is a no-op', async () => {
    const workerId = 'w1';
    const deviceIndex = 0;
    const totalBytes = 16_000_000_000;
    const reservedBytes = 6_000_000_000;

    const get = vi
      .fn()
      .mockResolvedValue(
        workerMemoryReport([
          { deviceIndex, deviceType: 'CUDA', memoryUsedBytes: 0, memoryTotalBytes: totalBytes },
        ]),
      );
    const redis = { get } as unknown as Redis;
    const service = makeService(redis);

    await service.refreshWorkerBudget(workerId);
    service.reserveCapacity(workerId, deviceIndex, 'model-a', reservedBytes);

    service.releaseModelReservations('model-a');
    service.releaseModelReservations('model-a'); // double release — should not throw or misbehave

    const budget = service.getWorkerBudget(workerId);
    const device = budget?.devices[0];
    expect(device?.reservedBytes).toBe(0);
    expect(device?.availableBytes).toBe(totalBytes);
  });

  it('clearWorkerReservations removes all reservations for a worker across devices', async () => {
    const workerId = 'w1';
    const totalBytes = 16_000_000_000;
    const bytesPerDevice = 4_000_000_000;

    const get = vi.fn().mockResolvedValue(
      workerMemoryReport([
        { deviceIndex: 0, deviceType: 'CUDA', memoryUsedBytes: 0, memoryTotalBytes: totalBytes },
        { deviceIndex: 1, deviceType: 'CUDA', memoryUsedBytes: 0, memoryTotalBytes: totalBytes },
      ]),
    );
    const redis = { get } as unknown as Redis;
    const service = makeService(redis);

    await service.refreshWorkerBudget(workerId);
    service.reserveCapacity(workerId, 0, 'model-a', bytesPerDevice);
    service.reserveCapacity(workerId, 1, 'model-b', bytesPerDevice);

    service.clearWorkerReservations(workerId);

    const budget = service.getWorkerBudget(workerId);
    expect(budget?.devices[0]?.reservedBytes).toBe(0);
    expect(budget?.devices[1]?.reservedBytes).toBe(0);
  });

  it('getClusterSummary includes reserved bytes', async () => {
    const workerId = 'w1';
    const deviceIndex = 0;
    const totalBytes = 16_000_000_000;
    const reservedBytes = 4_000_000_000;

    const get = vi
      .fn()
      .mockResolvedValue(
        workerMemoryReport([
          { deviceIndex, deviceType: 'CUDA', memoryUsedBytes: 0, memoryTotalBytes: totalBytes },
        ]),
      );
    const redis = { get } as unknown as Redis;
    const service = makeService(redis);

    await service.refreshWorkerBudget(workerId);
    service.reserveCapacity(workerId, deviceIndex, 'model-a', reservedBytes);

    const summary = service.getClusterSummary();
    expect(summary.reservedBytes).toBe(reservedBytes);
    expect(summary.availableBytes).toBe(totalBytes - reservedBytes);
  });
});

// ---------------------------------------------------------------------------
// availableBytes formula: total - used - reserved (not max(used, reserved))
// ---------------------------------------------------------------------------

describe('MemoryBudgetService — availableBytes formula', () => {
  it('subtracts both used and reserved bytes rather than taking the max', async () => {
    const workerId = 'w1';
    const deviceIndex = 0;
    const totalBytes = 24_000_000_000;
    const usedBytes = 10_000_000_000;
    const reservedBytes = 5_000_000_000;

    const report = workerMemoryReport([
      { deviceIndex, deviceType: 'CUDA', memoryUsedBytes: usedBytes, memoryTotalBytes: totalBytes },
    ]);
    const get = vi.fn().mockResolvedValue(report);
    const redis = { get } as unknown as Redis;
    const service = makeService(redis);

    await service.refreshWorkerBudget(workerId);
    service.reserveCapacity(workerId, deviceIndex, 'model-a', reservedBytes);

    const budget = service.getWorkerBudget(workerId);
    const device = budget?.devices[0];
    // Old (buggy) formula: total - max(used, reserved) = 24 - 10 = 14GB
    // New formula: total - used - reserved = 24 - 10 - 5 = 9GB
    expect(device?.availableBytes).toBe(totalBytes - usedBytes - reservedBytes);
  });

  it('clamps availableBytes to zero when used + reserved exceeds total', async () => {
    const workerId = 'w1';
    const deviceIndex = 0;
    const totalBytes = 16_000_000_000;
    const usedBytes = 10_000_000_000;
    const reservedBytes = 10_000_000_000;

    const report = workerMemoryReport([
      { deviceIndex, deviceType: 'CUDA', memoryUsedBytes: usedBytes, memoryTotalBytes: totalBytes },
    ]);
    const get = vi.fn().mockResolvedValue(report);
    const redis = { get } as unknown as Redis;
    const service = makeService(redis);

    await service.refreshWorkerBudget(workerId);
    service.reserveCapacity(workerId, deviceIndex, 'model-a', reservedBytes);

    const budget = service.getWorkerBudget(workerId);
    expect(budget?.devices[0]?.availableBytes).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Issue #83: parseReport field-level validation at the Redis boundary
// ---------------------------------------------------------------------------

describe('MemoryBudgetService — parseReport validation', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('accepts a valid report', async () => {
    const workerId = 'w1';
    const report = workerMemoryReport([
      { deviceIndex: 0, deviceType: 'CUDA', memoryUsedBytes: 0, memoryTotalBytes: 16_000_000_000 },
    ]);
    const get = vi.fn().mockResolvedValue(report);
    const redis = { get } as unknown as Redis;
    const service = makeService(redis);

    const budget = await service.refreshWorkerBudget(workerId);

    expect(budget).not.toBeNull();
    expect(budget?.devices).toHaveLength(1);
  });

  it('rejects a report with non-array devices', async () => {
    const workerId = 'w1';
    const get = vi.fn().mockResolvedValue(JSON.stringify({ devices: 'not-an-array' }));
    const redis = { get } as unknown as Redis;
    const service = makeService(redis);

    const budget = await service.refreshWorkerBudget(workerId);

    expect(budget).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('devices'));
  });

  it('rejects a report missing memoryUsedBytes (not treated as NaN)', async () => {
    const workerId = 'w1';
    const get = vi.fn().mockResolvedValue(
      JSON.stringify({
        devices: [{ deviceIndex: 0, deviceType: 'CUDA', memoryTotalBytes: 16_000_000_000 }],
      }),
    );
    const redis = { get } as unknown as Redis;
    const service = makeService(redis);

    const budget = await service.refreshWorkerBudget(workerId);

    expect(budget).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('memoryUsedBytes'));
  });

  it('rejects a report with a string byte count', async () => {
    const workerId = 'w1';
    const get = vi.fn().mockResolvedValue(
      JSON.stringify({
        devices: [
          {
            deviceIndex: 0,
            deviceType: 'CUDA',
            memoryUsedBytes: '0',
            memoryTotalBytes: 16_000_000_000,
          },
        ],
      }),
    );
    const redis = { get } as unknown as Redis;
    const service = makeService(redis);

    const budget = await service.refreshWorkerBudget(workerId);

    expect(budget).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('memoryUsedBytes'));
  });

  it('rejects a report with a negative byte count', async () => {
    const workerId = 'w1';
    const get = vi.fn().mockResolvedValue(
      JSON.stringify({
        devices: [
          { deviceIndex: 0, deviceType: 'CUDA', memoryUsedBytes: -1, memoryTotalBytes: 16_000_000_000 },
        ],
      }),
    );
    const redis = { get } as unknown as Redis;
    const service = makeService(redis);

    const budget = await service.refreshWorkerBudget(workerId);

    expect(budget).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('memoryUsedBytes'));
  });

  it('rejects a report with an invalid deviceType', async () => {
    const workerId = 'w1';
    const get = vi.fn().mockResolvedValue(
      JSON.stringify({
        devices: [
          { deviceIndex: 0, deviceType: 'BOGUS', memoryUsedBytes: 0, memoryTotalBytes: 16_000_000_000 },
        ],
      }),
    );
    const redis = { get } as unknown as Redis;
    const service = makeService(redis);

    const budget = await service.refreshWorkerBudget(workerId);

    expect(budget).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('deviceType'));
  });

  it('uses reportedAt when present, else falls back to the current time', async () => {
    const workerId = 'w1';
    const reportedAt = '2020-01-01T00:00:00.000Z';
    const report = workerMemoryReport(
      [{ deviceIndex: 0, deviceType: 'CUDA', memoryUsedBytes: 0, memoryTotalBytes: 16_000_000_000 }],
      reportedAt,
    );
    const get = vi.fn().mockResolvedValue(report);
    const redis = { get } as unknown as Redis;
    const service = makeService(redis);

    const budget = await service.refreshWorkerBudget(workerId);

    expect(budget?.lastReportAt).toBe(reportedAt);
  });
});
