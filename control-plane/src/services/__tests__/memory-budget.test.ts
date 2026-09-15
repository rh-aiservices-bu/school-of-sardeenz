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

// Doctrine (#163 round 2): a device's memoryUsedBytes IS the NVML-measured figure — there is no
// separate ledger vs. measured split anymore. deviceName/utilizationPercent/temperatureC are new
// optional NVML extras. instances[] entries carry `memoryUsedBytes` (renamed from
// memoryMeasuredUsedBytes).
function workerMemoryReport(
  devices: Array<{
    deviceIndex: number;
    deviceType: string;
    memoryUsedBytes: number;
    memoryTotalBytes: number;
    deviceName?: string;
    utilizationPercent?: number;
    temperatureC?: number;
    kvCache?: { totalBytes: number; usedBytes: number; preallocBytes: number; freeBytes: number };
  }>,
  reportedAt?: string,
  instances?: Array<{
    instanceId: string;
    modelName: string;
    deviceIndex: number;
    memoryUsedBytes: number;
  }>,
): string {
  return JSON.stringify({
    devices,
    ...(instances !== undefined ? { instances } : {}),
    reportedAt: reportedAt ?? new Date().toISOString(),
  });
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
// Issue #87 / #163 doctrine: internal placement holds survive refreshAll/refreshWorkerBudget
// regardless of what usedBytes the worker reports — they are only ever cleared explicitly via
// releaseInstanceReservations or clearWorkerReservations, never inferred from usage. Holds are
// an internal scheduling detail (#163 round 2): they still shift availableBytes, but are never
// exposed as their own field — so these tests assert through availableBytes only.
// ---------------------------------------------------------------------------

describe('MemoryBudgetService — internal placement holds survive refreshes', () => {
  it('preserves a hold across refreshAll even once the worker report reflects the usage', async () => {
    const workerId = 'w1';
    const deviceIndex = 0;
    const heldBytes = 8_000_000_000; // 8 GB
    const totalBytes = 24_000_000_000;

    const report = workerMemoryReport([
      {
        deviceIndex,
        deviceType: 'CUDA',
        memoryUsedBytes: heldBytes,
        memoryTotalBytes: totalBytes,
      },
    ]);
    const { redis } = makeMockRedis({ [workerKey(workerId)]: report });
    const service = makeService(redis);

    await service.refreshAll();
    service.reserveCapacity(workerId, deviceIndex, 'model-a', heldBytes);

    // refreshAll must not infer satisfaction from usedBytes — only explicit release does.
    await service.refreshAll();
    await service.refreshAll();

    const budget = service.getWorkerBudget(workerId);
    expect(budget).not.toBeNull();
    const device = budget?.devices[0];
    // total - used - held = 24GB - 8GB - 8GB = 8GB
    expect(device?.availableBytes).toBe(totalBytes - heldBytes - heldBytes);
  });

  it('preserves a hold across refreshWorkerBudget regardless of reported usage', async () => {
    const workerId = 'w1';
    const deviceIndex = 0;
    const heldBytes = 8_000_000_000;
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
            memoryUsedBytes: heldBytes,
            memoryTotalBytes: totalBytes,
          },
        ]),
      );
    const redis = { get } as unknown as Redis;
    const service = makeService(redis);

    await service.refreshWorkerBudget(workerId);
    service.reserveCapacity(workerId, deviceIndex, 'model-a', heldBytes);

    await service.refreshWorkerBudget(workerId);

    const budget = service.getWorkerBudget(workerId);
    const device = budget?.devices[0];
    expect(device?.availableBytes).toBe(totalBytes - heldBytes - heldBytes);
  });

  it('removes the budget but not holds for other workers when one worker disappears', async () => {
    const deadWorker = 'dead';
    const liveWorker = 'live';
    const deviceIndex = 0;
    const totalBytes = 16_000_000_000;
    const heldBytes = 4_000_000_000;

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
    service.reserveCapacity(liveWorker, deviceIndex, 'model-a', heldBytes);

    await service.refreshWorkerBudget(deadWorker);

    const liveBudget = service.getWorkerBudget(liveWorker);
    expect(liveBudget?.devices[0]?.availableBytes).toBe(totalBytes - heldBytes);
  });
});

// ---------------------------------------------------------------------------
// Issue #87: vanished worker (refreshAll) clears its holds
// ---------------------------------------------------------------------------

describe('MemoryBudgetService — vanished worker clears holds', () => {
  it('clears holds when a worker key disappears from refreshAll, so a rejoining worker starts clean', async () => {
    const workerId = 'w1';
    const deviceIndex = 0;
    const totalBytes = 16_000_000_000;
    const heldBytes = 4_000_000_000;

    const report = workerMemoryReport([
      { deviceIndex, deviceType: 'CUDA', memoryUsedBytes: 0, memoryTotalBytes: totalBytes },
    ]);
    const { redis, scan, pipeline, get } = makeMockRedis({ [workerKey(workerId)]: report });
    const service = makeService(redis);

    await service.refreshAll();
    service.reserveCapacity(workerId, deviceIndex, 'model-a', heldBytes);
    expect(service.getWorkerBudget(workerId)?.devices[0]?.availableBytes).toBe(
      totalBytes - heldBytes,
    );

    // Worker's memory key vanishes from Redis (no longer scanned).
    scan.mockResolvedValue(['0', []]);
    pipeline.mockReturnValue({
      get: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([]),
    });

    await service.refreshAll();

    expect(service.getWorkerBudget(workerId)).toBeNull();

    // Worker rejoins and reports the same key — its old hold must not resurface.
    get.mockResolvedValue(report);
    const rejoined = await service.refreshWorkerBudget(workerId);
    expect(rejoined?.devices[0]?.availableBytes).toBe(totalBytes);
  });
});

// ---------------------------------------------------------------------------
// Placement-hold mechanics (reserveCapacity/releaseInstanceReservations/clearWorkerReservations)
// — the mechanics are unchanged (#163 round 2); only the field name they used to surface
// (reservedBytes) is gone. Assert through availableBytes instead.
// ---------------------------------------------------------------------------

describe('MemoryBudgetService — placement hold mechanics', () => {
  it('reserveCapacity reduces availableBytes immediately', async () => {
    const workerId = 'w1';
    const deviceIndex = 0;
    const totalBytes = 16_000_000_000;
    const heldBytes = 6_000_000_000;

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
    service.reserveCapacity(workerId, deviceIndex, 'model-a', heldBytes);

    const budget = service.getWorkerBudget(workerId);
    const device = budget?.devices[0];
    expect(device?.availableBytes).toBe(totalBytes - heldBytes);
  });

  it('reserveCapacity is idempotent for the same model — repeated calls do not accumulate', async () => {
    const workerId = 'w1';
    const deviceIndex = 0;
    const totalBytes = 16_000_000_000;
    const heldBytes = 6_000_000_000;

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
    service.reserveCapacity(workerId, deviceIndex, 'model-a', heldBytes);
    service.reserveCapacity(workerId, deviceIndex, 'model-a', heldBytes);
    service.reserveCapacity(workerId, deviceIndex, 'model-a', heldBytes);

    const budget = service.getWorkerBudget(workerId);
    const device = budget?.devices[0];
    expect(device?.availableBytes).toBe(totalBytes - heldBytes);
  });

  it('co-located models on the same device sum their holds for availableBytes', async () => {
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
    expect(device?.availableBytes).toBe(totalBytes - modelABytes - modelBBytes);
  });

  it('releaseInstanceReservations restores availableBytes for the released model only', async () => {
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

    service.releaseInstanceReservations('model-a');

    const budget = service.getWorkerBudget(workerId);
    const device = budget?.devices[0];
    expect(device?.availableBytes).toBe(totalBytes - modelBBytes);
  });

  it('releaseInstanceReservations removes the model from every device it held on', async () => {
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

    service.releaseInstanceReservations('model-a');

    const budget = service.getWorkerBudget(workerId);
    expect(budget?.devices[0]?.availableBytes).toBe(totalBytes);
    expect(budget?.devices[1]?.availableBytes).toBe(totalBytes);
  });

  it('releaseInstanceReservations is idempotent — releasing twice is a no-op', async () => {
    const workerId = 'w1';
    const deviceIndex = 0;
    const totalBytes = 16_000_000_000;
    const heldBytes = 6_000_000_000;

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
    service.reserveCapacity(workerId, deviceIndex, 'model-a', heldBytes);

    service.releaseInstanceReservations('model-a');
    service.releaseInstanceReservations('model-a'); // double release — should not throw or misbehave

    const budget = service.getWorkerBudget(workerId);
    const device = budget?.devices[0];
    expect(device?.availableBytes).toBe(totalBytes);
  });

  it('clearWorkerReservations removes all holds for a worker across devices', async () => {
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
    expect(budget?.devices[0]?.availableBytes).toBe(totalBytes);
    expect(budget?.devices[1]?.availableBytes).toBe(totalBytes);
  });

  it("getClusterSummary's availableBytes nets out internal placement holds (holds are not a separate field)", async () => {
    const workerId = 'w1';
    const deviceIndex = 0;
    const totalBytes = 16_000_000_000;
    const heldBytes = 4_000_000_000;

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
    service.reserveCapacity(workerId, deviceIndex, 'model-a', heldBytes);

    const summary = service.getClusterSummary();
    expect(summary.availableBytes).toBe(totalBytes - heldBytes);
    expect('reservedBytes' in summary).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// availableBytes formula: total - used - held (not max(used, held))
// ---------------------------------------------------------------------------

describe('MemoryBudgetService — availableBytes formula', () => {
  it('subtracts both used and held bytes rather than taking the max', async () => {
    const workerId = 'w1';
    const deviceIndex = 0;
    const totalBytes = 24_000_000_000;
    const usedBytes = 10_000_000_000;
    const heldBytes = 5_000_000_000;

    const report = workerMemoryReport([
      { deviceIndex, deviceType: 'CUDA', memoryUsedBytes: usedBytes, memoryTotalBytes: totalBytes },
    ]);
    const get = vi.fn().mockResolvedValue(report);
    const redis = { get } as unknown as Redis;
    const service = makeService(redis);

    await service.refreshWorkerBudget(workerId);
    service.reserveCapacity(workerId, deviceIndex, 'model-a', heldBytes);

    const budget = service.getWorkerBudget(workerId);
    const device = budget?.devices[0];
    // Old (buggy) formula: total - max(used, held) = 24 - 10 = 14GB
    // New formula: total - used - held = 24 - 10 - 5 = 9GB
    expect(device?.availableBytes).toBe(totalBytes - usedBytes - heldBytes);
  });

  it('clamps availableBytes to zero when used + held exceeds total', async () => {
    const workerId = 'w1';
    const deviceIndex = 0;
    const totalBytes = 16_000_000_000;
    const usedBytes = 10_000_000_000;
    const heldBytes = 10_000_000_000;

    const report = workerMemoryReport([
      { deviceIndex, deviceType: 'CUDA', memoryUsedBytes: usedBytes, memoryTotalBytes: totalBytes },
    ]);
    const get = vi.fn().mockResolvedValue(report);
    const redis = { get } as unknown as Redis;
    const service = makeService(redis);

    await service.refreshWorkerBudget(workerId);
    service.reserveCapacity(workerId, deviceIndex, 'model-a', heldBytes);

    const budget = service.getWorkerBudget(workerId);
    expect(budget?.devices[0]?.availableBytes).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Issue #83: parseReport field-level validation at the Redis boundary (core ledger fields —
// these are still hard-rejected on malformed input; unaffected by the #163 doctrine change).
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
          {
            deviceIndex: 0,
            deviceType: 'CUDA',
            memoryUsedBytes: -1,
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

  it('rejects a report with an invalid deviceType', async () => {
    const workerId = 'w1';
    const get = vi.fn().mockResolvedValue(
      JSON.stringify({
        devices: [
          {
            deviceIndex: 0,
            deviceType: 'BOGUS',
            memoryUsedBytes: 0,
            memoryTotalBytes: 16_000_000_000,
          },
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
      [
        {
          deviceIndex: 0,
          deviceType: 'CUDA',
          memoryUsedBytes: 0,
          memoryTotalBytes: 16_000_000_000,
        },
      ],
      reportedAt,
    );
    const get = vi.fn().mockResolvedValue(report);
    const redis = { get } as unknown as Redis;
    const service = makeService(redis);

    const budget = await service.refreshWorkerBudget(workerId);

    expect(budget?.lastReportAt).toBe(reportedAt);
  });
});

// ---------------------------------------------------------------------------
// Issue #163 (round 2): optional NVML device extras (deviceName/utilizationPercent/temperatureC)
// — telemetry-tolerant, like the ledger fields' malformed-drop policy but never rejecting the
// whole device/report.
// ---------------------------------------------------------------------------

describe('MemoryBudgetService — optional NVML device fields', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('carries valid deviceName/utilizationPercent/temperatureC through to the device budget', async () => {
    const workerId = 'w1';
    const report = workerMemoryReport([
      {
        deviceIndex: 0,
        deviceType: 'CUDA',
        memoryUsedBytes: 8_000_000_000,
        memoryTotalBytes: 16_000_000_000,
        deviceName: 'NVIDIA GeForce RTX 4070 Ti',
        utilizationPercent: 42,
        temperatureC: 61,
      },
    ]);
    const get = vi.fn().mockResolvedValue(report);
    const redis = { get } as unknown as Redis;
    const service = makeService(redis);

    const budget = await service.refreshWorkerBudget(workerId);

    expect(budget?.devices[0]?.deviceName).toBe('NVIDIA GeForce RTX 4070 Ti');
    expect(budget?.devices[0]?.utilizationPercent).toBe(42);
    expect(budget?.devices[0]?.temperatureC).toBe(61);
  });

  it('leaves them absent when the device omits them', async () => {
    const workerId = 'w1';
    const report = workerMemoryReport([
      { deviceIndex: 0, deviceType: 'CUDA', memoryUsedBytes: 0, memoryTotalBytes: 16_000_000_000 },
    ]);
    const get = vi.fn().mockResolvedValue(report);
    const redis = { get } as unknown as Redis;
    const service = makeService(redis);

    const budget = await service.refreshWorkerBudget(workerId);

    expect(budget?.devices[0]?.deviceName).toBeUndefined();
    expect(budget?.devices[0]?.utilizationPercent).toBeUndefined();
    expect(budget?.devices[0]?.temperatureC).toBeUndefined();
  });

  it('drops a malformed deviceName (empty string) but keeps the core device report', async () => {
    const workerId = 'w1';
    const get = vi.fn().mockResolvedValue(
      JSON.stringify({
        devices: [
          {
            deviceIndex: 0,
            deviceType: 'CUDA',
            memoryUsedBytes: 0,
            memoryTotalBytes: 16_000_000_000,
            deviceName: '',
          },
        ],
      }),
    );
    const redis = { get } as unknown as Redis;
    const service = makeService(redis);

    const budget = await service.refreshWorkerBudget(workerId);

    expect(budget).not.toBeNull();
    expect(budget?.devices[0]?.deviceName).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('deviceName'));
  });

  it('drops a malformed utilizationPercent (out of range) but keeps the core device report', async () => {
    const workerId = 'w1';
    const get = vi.fn().mockResolvedValue(
      JSON.stringify({
        devices: [
          {
            deviceIndex: 0,
            deviceType: 'CUDA',
            memoryUsedBytes: 0,
            memoryTotalBytes: 16_000_000_000,
            utilizationPercent: 142,
          },
        ],
      }),
    );
    const redis = { get } as unknown as Redis;
    const service = makeService(redis);

    const budget = await service.refreshWorkerBudget(workerId);

    expect(budget).not.toBeNull();
    expect(budget?.devices[0]?.utilizationPercent).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('utilizationPercent'));
  });

  it('drops a malformed temperatureC (non-number) but keeps the core device report', async () => {
    const workerId = 'w1';
    const get = vi.fn().mockResolvedValue(
      JSON.stringify({
        devices: [
          {
            deviceIndex: 0,
            deviceType: 'CUDA',
            memoryUsedBytes: 0,
            memoryTotalBytes: 16_000_000_000,
            temperatureC: '61',
          },
        ],
      }),
    );
    const redis = { get } as unknown as Redis;
    const service = makeService(redis);

    const budget = await service.refreshWorkerBudget(workerId);

    expect(budget).not.toBeNull();
    expect(budget?.devices[0]?.temperatureC).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('temperatureC'));
  });
});

// ---------------------------------------------------------------------------
// Issue #165: per-device kvcached pool block (kvCache) — telemetry-tolerant like the NVML
// extras above: relayed verbatim when valid, dropped (with a warning) when malformed, never
// rejecting the device/report, and absent (never zeroed) when not reported.
// ---------------------------------------------------------------------------

describe('MemoryBudgetService — kvcached pool block (issue #165)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  const validKV = { totalBytes: 16_000_000_000, usedBytes: 6_000_000_000, preallocBytes: 2_000_000_000, freeBytes: 8_000_000_000 };

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('carries a valid kvCache block through to the device budget', async () => {
    const workerId = 'w1';
    const report = workerMemoryReport([
      {
        deviceIndex: 0,
        deviceType: 'CUDA',
        memoryUsedBytes: 8_000_000_000,
        memoryTotalBytes: 16_000_000_000,
        kvCache: validKV,
      },
    ]);
    const get = vi.fn().mockResolvedValue(report);
    const redis = { get } as unknown as Redis;
    const service = makeService(redis);

    const budget = await service.refreshWorkerBudget(workerId);

    expect(budget?.devices[0]?.kvCache).toEqual(validKV);
    // Telemetry only — the kvCache block must not shift placement math.
    expect(budget?.devices[0]?.usedBytes).toBe(8_000_000_000);
    expect(budget?.devices[0]?.availableBytes).toBe(8_000_000_000);
  });

  it('leaves kvCache absent when the device omits it', async () => {
    const workerId = 'w1';
    const report = workerMemoryReport([
      { deviceIndex: 0, deviceType: 'CUDA', memoryUsedBytes: 0, memoryTotalBytes: 16_000_000_000 },
    ]);
    const get = vi.fn().mockResolvedValue(report);
    const redis = { get } as unknown as Redis;
    const service = makeService(redis);

    const budget = await service.refreshWorkerBudget(workerId);

    expect('kvCache' in (budget?.devices[0] ?? {})).toBe(false);
  });

  it('drops a malformed kvCache block (negative value) but keeps the core device report', async () => {
    const workerId = 'w1';
    const get = vi.fn().mockResolvedValue(
      JSON.stringify({
        devices: [
          {
            deviceIndex: 0,
            deviceType: 'CUDA',
            memoryUsedBytes: 0,
            memoryTotalBytes: 16_000_000_000,
            kvCache: { totalBytes: -1, usedBytes: 0, preallocBytes: 0, freeBytes: 0 },
          },
        ],
      }),
    );
    const redis = { get } as unknown as Redis;
    const service = makeService(redis);

    const budget = await service.refreshWorkerBudget(workerId);

    expect(budget).not.toBeNull();
    expect(budget?.devices[0]?.usedBytes).toBe(0);
    expect('kvCache' in (budget?.devices[0] ?? {})).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('kvCache'));
  });

  it('drops a kvCache block missing a field but keeps the core device report', async () => {
    const workerId = 'w1';
    const get = vi.fn().mockResolvedValue(
      JSON.stringify({
        devices: [
          {
            deviceIndex: 0,
            deviceType: 'CUDA',
            memoryUsedBytes: 0,
            memoryTotalBytes: 16_000_000_000,
            kvCache: { totalBytes: 100, usedBytes: 10, preallocBytes: 5 },
          },
        ],
      }),
    );
    const redis = { get } as unknown as Redis;
    const service = makeService(redis);

    const budget = await service.refreshWorkerBudget(workerId);

    expect(budget).not.toBeNull();
    expect('kvCache' in (budget?.devices[0] ?? {})).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('freeBytes'));
  });

  it('drops a non-object kvCache value but keeps the core device report', async () => {
    const workerId = 'w1';
    const get = vi.fn().mockResolvedValue(
      JSON.stringify({
        devices: [
          {
            deviceIndex: 0,
            deviceType: 'CUDA',
            memoryUsedBytes: 0,
            memoryTotalBytes: 16_000_000_000,
            kvCache: 'nope',
          },
        ],
      }),
    );
    const redis = { get } as unknown as Redis;
    const service = makeService(redis);

    const budget = await service.refreshWorkerBudget(workerId);

    expect(budget).not.toBeNull();
    expect('kvCache' in (budget?.devices[0] ?? {})).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('kvCache'));
  });
});

// ---------------------------------------------------------------------------
// Issue #163: instances[] measured attribution — telemetry-tolerant, never rejects the core
// report. Source field is `memoryUsedBytes` (renamed from memoryMeasuredUsedBytes in round 2).
// ---------------------------------------------------------------------------

describe('MemoryBudgetService — instances[] measured attribution', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('carries valid instances[] measurements through to instanceMeasurements', async () => {
    const workerId = 'w1';
    const report = workerMemoryReport(
      [
        {
          deviceIndex: 0,
          deviceType: 'CUDA',
          memoryUsedBytes: 0,
          memoryTotalBytes: 16_000_000_000,
        },
      ],
      undefined,
      [{ instanceId: 'inst-a', modelName: 'model-a', deviceIndex: 0, memoryUsedBytes: 5e9 }],
    );
    const get = vi.fn().mockResolvedValue(report);
    const redis = { get } as unknown as Redis;
    const service = makeService(redis);

    const budget = await service.refreshWorkerBudget(workerId);

    expect(budget?.instanceMeasurements).toEqual([
      { instanceId: 'inst-a', modelName: 'model-a', deviceIndex: 0, measuredUsedBytes: 5e9 },
    ]);
  });

  it('drops a malformed instances entry but keeps the core report and any valid siblings', async () => {
    const workerId = 'w1';
    const get = vi.fn().mockResolvedValue(
      JSON.stringify({
        devices: [
          {
            deviceIndex: 0,
            deviceType: 'CUDA',
            memoryUsedBytes: 0,
            memoryTotalBytes: 16_000_000_000,
          },
        ],
        instances: [
          { instanceId: 'inst-a', modelName: 'model-a', deviceIndex: 0, memoryUsedBytes: 5e9 },
          { instanceId: 'inst-b', modelName: 'model-b', deviceIndex: 0 }, // missing measurement
        ],
      }),
    );
    const redis = { get } as unknown as Redis;
    const service = makeService(redis);

    const budget = await service.refreshWorkerBudget(workerId);

    expect(budget).not.toBeNull();
    expect(budget?.instanceMeasurements).toEqual([
      { instanceId: 'inst-a', modelName: 'model-a', deviceIndex: 0, measuredUsedBytes: 5e9 },
    ]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('instances[1]'));
  });

  it('drops a non-array instances field but keeps the core report', async () => {
    const workerId = 'w1';
    const get = vi.fn().mockResolvedValue(
      JSON.stringify({
        devices: [
          {
            deviceIndex: 0,
            deviceType: 'CUDA',
            memoryUsedBytes: 0,
            memoryTotalBytes: 16_000_000_000,
          },
        ],
        instances: 'not-an-array',
      }),
    );
    const redis = { get } as unknown as Redis;
    const service = makeService(redis);

    const budget = await service.refreshWorkerBudget(workerId);

    expect(budget).not.toBeNull();
    expect(budget?.instanceMeasurements).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Issue #163 (round 2 doctrine): getClusterSummary is measured-only — {totalBytes, usedBytes,
// availableBytes}, nothing else. No reserved/measured split.
// ---------------------------------------------------------------------------

describe('MemoryBudgetService — getClusterSummary (measured-only)', () => {
  it('sums totalBytes/usedBytes/availableBytes across non-stale workers/devices', async () => {
    const { redis } = makeMockRedis({
      [workerKey('w1')]: workerMemoryReport([
        {
          deviceIndex: 0,
          deviceType: 'CUDA',
          memoryUsedBytes: 3_000_000_000,
          memoryTotalBytes: 16_000_000_000,
        },
      ]),
      [workerKey('w2')]: workerMemoryReport([
        {
          deviceIndex: 0,
          deviceType: 'CUDA',
          memoryUsedBytes: 2_000_000_000,
          memoryTotalBytes: 16_000_000_000,
        },
      ]),
    });
    const service = makeService(redis);

    await service.refreshAll();

    const summary = service.getClusterSummary();
    expect(summary).toEqual({
      totalBytes: 32_000_000_000,
      usedBytes: 5_000_000_000,
      availableBytes: 27_000_000_000,
    });
  });

  it('excludes stale workers from the summary', async () => {
    const workerId = 'w1';
    const report = workerMemoryReport(
      [
        {
          deviceIndex: 0,
          deviceType: 'CUDA',
          memoryUsedBytes: 3_000_000_000,
          memoryTotalBytes: 16_000_000_000,
        },
      ],
      '2000-01-01T00:00:00.000Z', // long stale
    );
    const get = vi.fn().mockResolvedValue(report);
    const redis = { get } as unknown as Redis;
    const service = new MemoryBudgetService(redis, KEY_PREFIX, 1); // 1s heartbeat timeout

    await service.refreshWorkerBudget(workerId);

    expect(service.getClusterSummary()).toEqual({ totalBytes: 0, usedBytes: 0, availableBytes: 0 });
  });

  it('never includes a reservedBytes or measuredUsedBytes key', async () => {
    const workerId = 'w1';
    const get = vi
      .fn()
      .mockResolvedValue(
        workerMemoryReport([
          {
            deviceIndex: 0,
            deviceType: 'CUDA',
            memoryUsedBytes: 0,
            memoryTotalBytes: 16_000_000_000,
          },
        ]),
      );
    const redis = { get } as unknown as Redis;
    const service = makeService(redis);

    await service.refreshWorkerBudget(workerId);

    const summary = service.getClusterSummary();
    expect(Object.keys(summary).sort()).toEqual(['availableBytes', 'totalBytes', 'usedBytes']);
  });
});

describe('MemoryBudgetService — getMeasuredByInstance', () => {
  it('aggregates one instance measured across two devices on the same worker', async () => {
    const workerId = 'w1';
    const report = workerMemoryReport(
      [
        {
          deviceIndex: 0,
          deviceType: 'CUDA',
          memoryUsedBytes: 0,
          memoryTotalBytes: 16_000_000_000,
        },
        {
          deviceIndex: 1,
          deviceType: 'CUDA',
          memoryUsedBytes: 0,
          memoryTotalBytes: 16_000_000_000,
        },
      ],
      undefined,
      [
        { instanceId: 'inst-a', modelName: 'model-a', deviceIndex: 0, memoryUsedBytes: 4e9 },
        { instanceId: 'inst-a', modelName: 'model-a', deviceIndex: 1, memoryUsedBytes: 4e9 },
      ],
    );
    const get = vi.fn().mockResolvedValue(report);
    const redis = { get } as unknown as Redis;
    const service = makeService(redis);

    await service.refreshWorkerBudget(workerId);

    const byInstance = service.getMeasuredByInstance();
    expect(byInstance.get('inst-a')).toBe(8e9);
  });

  it('aggregates the same instanceId across two workers', async () => {
    const { redis } = makeMockRedis({
      [workerKey('w1')]: workerMemoryReport(
        [
          {
            deviceIndex: 0,
            deviceType: 'CUDA',
            memoryUsedBytes: 0,
            memoryTotalBytes: 16_000_000_000,
          },
        ],
        undefined,
        [{ instanceId: 'inst-a', modelName: 'model-a', deviceIndex: 0, memoryUsedBytes: 3e9 }],
      ),
      [workerKey('w2')]: workerMemoryReport(
        [
          {
            deviceIndex: 0,
            deviceType: 'CUDA',
            memoryUsedBytes: 0,
            memoryTotalBytes: 16_000_000_000,
          },
        ],
        undefined,
        [{ instanceId: 'inst-a', modelName: 'model-a', deviceIndex: 0, memoryUsedBytes: 2e9 }],
      ),
    });
    const service = makeService(redis);

    await service.refreshAll();

    expect(service.getMeasuredByInstance().get('inst-a')).toBe(5e9);
  });

  it('excludes stale workers from getMeasuredByInstance (mirrors getClusterSummary staleness handling)', async () => {
    const workerId = 'w1';
    const report = workerMemoryReport(
      [
        {
          deviceIndex: 0,
          deviceType: 'CUDA',
          memoryUsedBytes: 0,
          memoryTotalBytes: 16_000_000_000,
        },
      ],
      '2000-01-01T00:00:00.000Z', // long stale
      [{ instanceId: 'inst-a', modelName: 'model-a', deviceIndex: 0, memoryUsedBytes: 4e9 }],
    );
    const get = vi.fn().mockResolvedValue(report);
    const redis = { get } as unknown as Redis;
    const service = new MemoryBudgetService(redis, KEY_PREFIX, 1); // 1s heartbeat timeout

    await service.refreshWorkerBudget(workerId);

    expect(service.getMeasuredByInstance().has('inst-a')).toBe(false);
    expect(service.getMeasuredByInstance().size).toBe(0);
  });

  it('returns an empty map when no worker reported instance measurements', async () => {
    const workerId = 'w1';
    const get = vi
      .fn()
      .mockResolvedValue(
        workerMemoryReport([
          {
            deviceIndex: 0,
            deviceType: 'CUDA',
            memoryUsedBytes: 0,
            memoryTotalBytes: 16_000_000_000,
          },
        ]),
      );
    const redis = { get } as unknown as Redis;
    const service = makeService(redis);

    await service.refreshWorkerBudget(workerId);

    expect(service.getMeasuredByInstance().size).toBe(0);
  });
});

describe('MemoryBudgetService — writeClusterMemorySnapshot content (measured-only)', () => {
  it('includes per-device deviceName/utilizationPercent/temperatureC when present, and a measured-only summary', async () => {
    const { redis, set } = makeMockRedis({
      [workerKey('w1')]: workerMemoryReport([
        {
          deviceIndex: 0,
          deviceType: 'CUDA',
          memoryUsedBytes: 6_000_000_000,
          memoryTotalBytes: 16_000_000_000,
          deviceName: 'NVIDIA GeForce RTX 4070 Ti',
          utilizationPercent: 55,
          temperatureC: 64,
          kvCache: {
            totalBytes: 12_000_000_000,
            usedBytes: 5_000_000_000,
            preallocBytes: 1_000_000_000,
            freeBytes: 6_000_000_000,
          },
        },
      ]),
    });
    const service = makeService(redis);

    await service.refreshAll();

    expect(set).toHaveBeenCalledTimes(1);
    const [key, payload] = set.mock.calls[0] as [string, string];
    expect(key).toBe(`${KEY_PREFIX}:cluster:memory`);
    const snapshot = JSON.parse(payload) as {
      workers: Array<{
        devices: Array<Record<string, unknown>>;
      }>;
      summary: Record<string, unknown>;
    };
    const device = snapshot.workers[0]?.devices[0];
    expect(device?.deviceName).toBe('NVIDIA GeForce RTX 4070 Ti');
    expect(device?.utilizationPercent).toBe(55);
    expect(device?.temperatureC).toBe(64);
    expect(device?.kvCache).toEqual({
      totalBytes: 12_000_000_000,
      usedBytes: 5_000_000_000,
      preallocBytes: 1_000_000_000,
      freeBytes: 6_000_000_000,
    });
    expect('memoryReservedBytes' in (device ?? {})).toBe(false);
    expect('memoryMeasuredUsedBytes' in (device ?? {})).toBe(false);
    expect(snapshot.summary).toEqual({
      totalBytes: 16_000_000_000,
      usedBytes: 6_000_000_000,
      availableBytes: 10_000_000_000,
    });
  });

  it('omits deviceName/utilizationPercent/temperatureC per-device when the worker did not report them', async () => {
    const { redis, set } = makeMockRedis({
      [workerKey('w1')]: workerMemoryReport([
        {
          deviceIndex: 0,
          deviceType: 'CUDA',
          memoryUsedBytes: 0,
          memoryTotalBytes: 16_000_000_000,
        },
      ]),
    });
    const service = makeService(redis);

    await service.refreshAll();

    const [, payload] = set.mock.calls[0] as [string, string];
    const snapshot = JSON.parse(payload) as {
      workers: Array<{ devices: Array<Record<string, unknown>> }>;
    };
    const device = snapshot.workers[0]?.devices[0] ?? {};
    expect('deviceName' in device).toBe(false);
    expect('utilizationPercent' in device).toBe(false);
    expect('temperatureC' in device).toBe(false);
    expect('kvCache' in device).toBe(false);
  });
});
