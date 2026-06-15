import { describe, it, expect, vi } from 'vitest';

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
// Issue #34 regression: in-flight reservations must survive refreshAll
// ---------------------------------------------------------------------------

describe('MemoryBudgetService — refreshAll preserves in-flight reservations', () => {
  it('preserves a reservation when the worker report has not yet reflected the allocation', async () => {
    const workerId = 'w1';
    const deviceIndex = 0;
    const reservedBytes = 8_000_000_000; // 8 GB
    // Worker reports only 1 GB used — the reserved 8 GB is in-flight
    const reportedUsedBytes = 1_000_000_000;
    const totalBytes = 24_000_000_000;

    const report = workerMemoryReport([
      {
        deviceIndex,
        deviceType: 'CUDA',
        memoryUsedBytes: reportedUsedBytes,
        memoryTotalBytes: totalBytes,
      },
    ]);
    const { redis } = makeMockRedis({ [workerKey(workerId)]: report });
    const service = makeService(redis);

    // Place a reservation simulating an in-flight deploy
    // We need a prior budget in the map first so reserveCapacity can recompute
    await service.refreshAll();
    service.reserveCapacity(workerId, deviceIndex, reservedBytes);

    // Run refreshAll — this was the bug: reservations.clear() wiped the reservation
    await service.refreshAll();

    const budget = service.getWorkerBudget(workerId);
    expect(budget).not.toBeNull();
    const device = budget?.devices[0];
    expect(device).not.toBeUndefined();
    // The reservation must still be present (worker hasn't caught up yet)
    expect(device?.reservedBytes).toBe(reservedBytes);
    // Available capacity must be reduced by the reservation
    expect(device?.availableBytes).toBeLessThan(totalBytes - reportedUsedBytes);
  });

  it('clears a reservation when the worker report reflects the allocated memory', async () => {
    const workerId = 'w1';
    const deviceIndex = 0;
    const reservedBytes = 8_000_000_000; // 8 GB
    const totalBytes = 24_000_000_000;

    // Fresh service with the updated worker report (usedBytes now covers the reservation)
    const updatedReport = workerMemoryReport([
      {
        deviceIndex,
        deviceType: 'CUDA',
        memoryUsedBytes: reservedBytes,
        memoryTotalBytes: totalBytes,
      },
    ]);
    const { redis } = makeMockRedis({ [workerKey(workerId)]: updatedReport });
    const service = makeService(redis);

    // Populate the budget map, then place an in-flight reservation
    await service.refreshAll();
    service.reserveCapacity(workerId, deviceIndex, reservedBytes);

    // refreshAll: worker now reports usage >= reserved — reservation must be cleared
    await service.refreshAll();

    const budget = service.getWorkerBudget(workerId);
    expect(budget).not.toBeNull();
    const device = budget?.devices[0];
    expect(device).not.toBeUndefined();
    // Reservation is satisfied — must be cleared
    expect(device?.reservedBytes).toBe(0);
    // Available capacity equals total minus used (reservation no longer double-counts)
    expect(device?.availableBytes).toBe(totalBytes - reservedBytes);
  });

  it('double-placement scenario: second deploy must not be placed on reserved capacity', async () => {
    // This is the exact scenario from the bug report:
    // 1. Deploy A reserves W's capacity
    // 2. Reconciliation fires
    // 3. refreshAll must NOT clear the reservation
    // 4. A second placement attempt must see the reserved bytes
    const workerId = 'w1';
    const deviceIndex = 0;
    const totalBytes = 16_000_000_000; // 16 GB
    const modelABytes = 10_000_000_000; // 10 GB — almost fills the worker
    const modelBBytes = 8_000_000_000; // 8 GB — should not fit after A is reserved

    const report = workerMemoryReport([
      { deviceIndex, deviceType: 'CUDA', memoryUsedBytes: 0, memoryTotalBytes: totalBytes },
    ]);
    const { redis } = makeMockRedis({ [workerKey(workerId)]: report });
    const service = makeService(redis);
    await service.refreshAll();

    // Deploy A places a reservation
    service.reserveCapacity(workerId, deviceIndex, modelABytes);

    // Reconciliation tick fires — must not clear the reservation
    await service.refreshAll();

    const budget = service.getWorkerBudget(workerId);
    expect(budget).not.toBeNull();
    const device = budget?.devices[0];
    expect(device).not.toBeUndefined();

    // After the fix: reserved bytes should still be modelABytes
    expect(device?.reservedBytes).toBe(modelABytes);
    // Available must be less than modelBBytes — prevents double placement
    expect(device?.availableBytes).toBeLessThan(modelBBytes);
  });

  it('preserves reservations across multiple reconciliation ticks while worker is slow to report', async () => {
    const workerId = 'w1';
    const deviceIndex = 0;
    const reservedBytes = 8_000_000_000;
    const totalBytes = 24_000_000_000;

    const report = workerMemoryReport([
      { deviceIndex, deviceType: 'CUDA', memoryUsedBytes: 0, memoryTotalBytes: totalBytes },
    ]);
    const { redis } = makeMockRedis({ [workerKey(workerId)]: report });
    const service = makeService(redis);
    await service.refreshAll();

    service.reserveCapacity(workerId, deviceIndex, reservedBytes);

    // Multiple reconciliation ticks fire before worker reports (worker is slow)
    await service.refreshAll();
    await service.refreshAll();
    await service.refreshAll();

    const budget = service.getWorkerBudget(workerId);
    const device = budget?.devices[0];
    expect(device?.reservedBytes).toBe(reservedBytes);
    expect(device?.availableBytes).toBe(totalBytes - reservedBytes);
  });
});

// ---------------------------------------------------------------------------
// Issue #34 regression: refreshWorkerBudget preserves in-flight reservations
// ---------------------------------------------------------------------------

describe('MemoryBudgetService — refreshWorkerBudget preserves in-flight reservations', () => {
  it('preserves a reservation when the single-worker report has not caught up', async () => {
    const workerId = 'w1';
    const deviceIndex = 0;
    const reservedBytes = 8_000_000_000;
    const reportedUsedBytes = 0;
    const totalBytes = 24_000_000_000;

    const get = vi.fn().mockResolvedValue(
      workerMemoryReport([
        {
          deviceIndex,
          deviceType: 'CUDA',
          memoryUsedBytes: reportedUsedBytes,
          memoryTotalBytes: totalBytes,
        },
      ]),
    );
    const redis = { get } as unknown as Redis;
    const service = makeService(redis);

    // Initial refresh to populate the budget map
    await service.refreshWorkerBudget(workerId);
    service.reserveCapacity(workerId, deviceIndex, reservedBytes);

    // Single-worker refresh — must preserve reservation (worker still at 0 used)
    await service.refreshWorkerBudget(workerId);

    const budget = service.getWorkerBudget(workerId);
    const device = budget?.devices[0];
    expect(device?.reservedBytes).toBe(reservedBytes);
    expect(device?.availableBytes).toBe(totalBytes - reservedBytes);
  });

  it('clears a reservation when the single-worker report has caught up', async () => {
    const workerId = 'w1';
    const deviceIndex = 0;
    const reservedBytes = 8_000_000_000;
    const totalBytes = 24_000_000_000;

    // First call: no usage (pre-deploy snapshot)
    // Second call: usage equals reservation (worker caught up)
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
    service.reserveCapacity(workerId, deviceIndex, reservedBytes);

    // Worker now reports updated usage — reservation should be cleared
    await service.refreshWorkerBudget(workerId);

    const budget = service.getWorkerBudget(workerId);
    const device = budget?.devices[0];
    expect(device?.reservedBytes).toBe(0);
    expect(device?.availableBytes).toBe(totalBytes - reservedBytes);
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

    // Populate both workers
    await service.refreshWorkerBudget(liveWorker);
    // Reserve capacity on the live worker (simulate in-flight deploy)
    service.reserveCapacity(liveWorker, deviceIndex, reservedBytes);

    // Dead worker refresh removes its budget but live worker's reservation stays
    await service.refreshWorkerBudget(deadWorker);

    const liveBudget = service.getWorkerBudget(liveWorker);
    expect(liveBudget?.devices[0]?.reservedBytes).toBe(reservedBytes);
  });
});

// ---------------------------------------------------------------------------
// Existing reservation mechanics (non-regression)
// ---------------------------------------------------------------------------

describe('MemoryBudgetService — reservation mechanics', () => {
  it('reserveCapacity reduces availableBytes immediately', async () => {
    const workerId = 'w1';
    const deviceIndex = 0;
    const totalBytes = 16_000_000_000;
    const reservedBytes = 6_000_000_000;

    const get = vi.fn().mockResolvedValue(
      workerMemoryReport([
        { deviceIndex, deviceType: 'CUDA', memoryUsedBytes: 0, memoryTotalBytes: totalBytes },
      ]),
    );
    const redis = { get } as unknown as Redis;
    const service = makeService(redis);

    await service.refreshWorkerBudget(workerId);
    service.reserveCapacity(workerId, deviceIndex, reservedBytes);

    const budget = service.getWorkerBudget(workerId);
    const device = budget?.devices[0];
    expect(device?.reservedBytes).toBe(reservedBytes);
    expect(device?.availableBytes).toBe(totalBytes - reservedBytes);
  });

  it('releaseCapacity restores availableBytes', async () => {
    const workerId = 'w1';
    const deviceIndex = 0;
    const totalBytes = 16_000_000_000;
    const reservedBytes = 6_000_000_000;

    const get = vi.fn().mockResolvedValue(
      workerMemoryReport([
        { deviceIndex, deviceType: 'CUDA', memoryUsedBytes: 0, memoryTotalBytes: totalBytes },
      ]),
    );
    const redis = { get } as unknown as Redis;
    const service = makeService(redis);

    await service.refreshWorkerBudget(workerId);
    service.reserveCapacity(workerId, deviceIndex, reservedBytes);
    service.releaseCapacity(workerId, deviceIndex, reservedBytes);

    const budget = service.getWorkerBudget(workerId);
    const device = budget?.devices[0];
    expect(device?.reservedBytes).toBe(0);
    expect(device?.availableBytes).toBe(totalBytes);
  });

  it('releaseCapacity clamps to zero on double release', async () => {
    const workerId = 'w1';
    const deviceIndex = 0;
    const totalBytes = 16_000_000_000;
    const reservedBytes = 6_000_000_000;

    const get = vi.fn().mockResolvedValue(
      workerMemoryReport([
        { deviceIndex, deviceType: 'CUDA', memoryUsedBytes: 0, memoryTotalBytes: totalBytes },
      ]),
    );
    const redis = { get } as unknown as Redis;
    const service = makeService(redis);

    await service.refreshWorkerBudget(workerId);
    service.reserveCapacity(workerId, deviceIndex, reservedBytes);
    service.releaseCapacity(workerId, deviceIndex, reservedBytes);
    service.releaseCapacity(workerId, deviceIndex, reservedBytes); // double release

    const budget = service.getWorkerBudget(workerId);
    const device = budget?.devices[0];
    expect(device?.reservedBytes).toBe(0);
    expect(device?.availableBytes).toBe(totalBytes);
  });

  it('getClusterSummary includes reserved bytes', async () => {
    const workerId = 'w1';
    const deviceIndex = 0;
    const totalBytes = 16_000_000_000;
    const reservedBytes = 4_000_000_000;

    const get = vi.fn().mockResolvedValue(
      workerMemoryReport([
        { deviceIndex, deviceType: 'CUDA', memoryUsedBytes: 0, memoryTotalBytes: totalBytes },
      ]),
    );
    const redis = { get } as unknown as Redis;
    const service = makeService(redis);

    await service.refreshWorkerBudget(workerId);
    service.reserveCapacity(workerId, deviceIndex, reservedBytes);

    const summary = service.getClusterSummary();
    expect(summary.reservedBytes).toBe(reservedBytes);
    expect(summary.availableBytes).toBe(totalBytes - reservedBytes);
  });
});
