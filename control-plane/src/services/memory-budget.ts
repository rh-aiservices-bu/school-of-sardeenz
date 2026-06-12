import type { Redis } from '../clients/redis.js';
import { redisKey } from '../clients/redis.js';

export interface DeviceBudget {
  deviceIndex: number;
  deviceType: string;
  totalBytes: number;
  usedBytes: number;
  reservedBytes: number;
  availableBytes: number; // totalBytes - max(usedBytes, reservedBytes)
}

export interface WorkerBudget {
  workerId: string;
  devices: DeviceBudget[];
  lastReportAt: string;
  stale: boolean;
}

interface ClusterSummary {
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  reservedBytes: number;
}

/** Shape of the JSON object workers push to Redis. */
interface WorkerMemoryReport {
  devices: Array<{
    deviceIndex: number;
    deviceType: string;
    memoryUsedBytes: number;
    memoryTotalBytes: number;
  }>;
}

const WORKER_MEMORY_SUBKEY = 'memory';

function workerMemoryKey(prefix: string, workerId: string): string {
  return redisKey(prefix, 'workers', workerId, WORKER_MEMORY_SUBKEY);
}

/**
 * Tracks per-worker, per-device VRAM budgets.
 *
 * Workers push JSON memory reports to Redis; this service reads those reports
 * into an in-memory Map, applies in-flight reservations on top, and exposes
 * placement helpers to the control plane.
 */
export class MemoryBudgetService {
  /** keyed by workerId */
  private readonly budgets: Map<string, WorkerBudget> = new Map();

  /**
   * per-device reservations that have been committed locally but may not yet
   * be reflected in the next Redis report.  Keyed as `${workerId}:${deviceIndex}`.
   */
  private readonly reservations: Map<string, number> = new Map();

  constructor(
    private readonly redis: Redis,
    private readonly keyPrefix: string,
    private readonly heartbeatTimeoutSecs: number,
  ) {}

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private reservationKey(workerId: string, deviceIndex: number): string {
    return `${workerId}:${deviceIndex}`;
  }

  private getReservation(workerId: string, deviceIndex: number): number {
    return this.reservations.get(this.reservationKey(workerId, deviceIndex)) ?? 0;
  }

  private isStale(lastReportAt: string): boolean {
    const reportedMs = new Date(lastReportAt).getTime();
    const nowMs = Date.now();
    return nowMs - reportedMs > this.heartbeatTimeoutSecs * 1000;
  }

  private parseReport(raw: string, workerId: string): WorkerBudget | null {
    let report: WorkerMemoryReport;
    try {
      report = JSON.parse(raw) as WorkerMemoryReport;
    } catch {
      return null;
    }

    if (!Array.isArray(report.devices)) return null;

    const lastReportAt = new Date().toISOString();

    const devices: DeviceBudget[] = report.devices.map((d) => {
      const reservedBytes = this.getReservation(workerId, d.deviceIndex);
      const availableBytes = d.memoryTotalBytes - Math.max(d.memoryUsedBytes, reservedBytes);
      return {
        deviceIndex: d.deviceIndex,
        deviceType: d.deviceType,
        totalBytes: d.memoryTotalBytes,
        usedBytes: d.memoryUsedBytes,
        reservedBytes,
        availableBytes: Math.max(0, availableBytes),
      };
    });

    return {
      workerId,
      devices,
      lastReportAt,
      stale: false, // freshly read from Redis — not stale
    };
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Read the memory report for a single worker from Redis and update the local
   * budget.  Returns the refreshed WorkerBudget, or null if no report exists.
   */
  async refreshWorkerBudget(workerId: string): Promise<WorkerBudget | null> {
    const key = workerMemoryKey(this.keyPrefix, workerId);
    const raw = await this.redis.get(key);
    if (!raw) {
      this.budgets.delete(workerId);
      return null;
    }

    const budget = this.parseReport(raw, workerId);
    if (!budget) {
      this.budgets.delete(workerId);
      return null;
    }

    this.budgets.set(workerId, budget);
    return budget;
  }

  /**
   * Scan Redis for all worker memory keys and refresh every worker in one
   * pipeline round-trip.
   */
  async refreshAll(): Promise<void> {
    const pattern = redisKey(this.keyPrefix, 'workers', '*', WORKER_MEMORY_SUBKEY);
    const keys = await this.redis.keys(pattern);
    if (keys.length === 0) {
      this.budgets.clear();
      return;
    }

    const pipeline = this.redis.pipeline();
    for (const key of keys) {
      pipeline.get(key);
    }
    const results = await pipeline.exec();
    if (!results) return;

    // Extract workerIds from the key pattern:
    // <prefix>:workers:<workerId>:memory
    const prefixSegment = redisKey(this.keyPrefix, 'workers') + ':';
    const suffixSegment = ':' + WORKER_MEMORY_SUBKEY;

    const seenWorkers = new Set<string>();

    for (let i = 0; i < results.length; i++) {
      const [err, raw] = results[i];
      if (err || typeof raw !== 'string') continue;

      const key = keys[i];
      // Strip known prefix and suffix to recover workerId
      const inner = key.startsWith(prefixSegment) ? key.slice(prefixSegment.length) : key;
      const workerId = inner.endsWith(suffixSegment)
        ? inner.slice(0, inner.length - suffixSegment.length)
        : inner;

      const budget = this.parseReport(raw, workerId);
      if (budget) {
        this.budgets.set(workerId, budget);
        seenWorkers.add(workerId);
      }
    }

    // Remove budgets for workers no longer present in Redis
    for (const workerId of this.budgets.keys()) {
      if (!seenWorkers.has(workerId)) {
        this.budgets.delete(workerId);
      }
    }
  }

  /** Return the current in-memory budget for a worker, with staleness flag applied. */
  getWorkerBudget(workerId: string): WorkerBudget | null {
    const budget = this.budgets.get(workerId);
    if (!budget) return null;
    return { ...budget, stale: this.isStale(budget.lastReportAt) };
  }

  /** Return all in-memory budgets with staleness flags applied. */
  getAllBudgets(): WorkerBudget[] {
    return Array.from(this.budgets.values()).map((b) => ({
      ...b,
      stale: this.isStale(b.lastReportAt),
    }));
  }

  /**
   * Reserve capacity on a specific device.  The reservation is held in-memory
   * and applied on top of the Redis-reported usedBytes so that subsequent
   * placement decisions account for in-flight allocations before the worker
   * has had a chance to report updated usage.
   */
  reserveCapacity(workerId: string, deviceIndex: number, bytes: number): void {
    const rk = this.reservationKey(workerId, deviceIndex);
    const current = this.reservations.get(rk) ?? 0;
    this.reservations.set(rk, current + bytes);

    // Recompute the in-memory device budget immediately so callers see the
    // updated availableBytes without waiting for the next refreshWorkerBudget.
    this.recomputeDeviceBudget(workerId, deviceIndex);
  }

  /**
   * Release a previously reserved capacity block.  Clamps to zero so stale
   * double-releases cannot produce a negative reservation.
   */
  releaseCapacity(workerId: string, deviceIndex: number, bytes: number): void {
    const rk = this.reservationKey(workerId, deviceIndex);
    const current = this.reservations.get(rk) ?? 0;
    const updated = Math.max(0, current - bytes);

    if (updated === 0) {
      this.reservations.delete(rk);
    } else {
      this.reservations.set(rk, updated);
    }

    this.recomputeDeviceBudget(workerId, deviceIndex);
  }

  /** Aggregate memory figures across every non-stale worker and device. */
  getClusterSummary(): ClusterSummary {
    let totalBytes = 0;
    let usedBytes = 0;
    let availableBytes = 0;
    let reservedBytes = 0;

    for (const budget of this.getAllBudgets()) {
      if (budget.stale) continue;
      for (const device of budget.devices) {
        totalBytes += device.totalBytes;
        usedBytes += device.usedBytes;
        availableBytes += device.availableBytes;
        reservedBytes += device.reservedBytes;
      }
    }

    return { totalBytes, usedBytes, availableBytes, reservedBytes };
  }

  // ---------------------------------------------------------------------------
  // Private mutators
  // ---------------------------------------------------------------------------

  /**
   * After a reservation change, patch the affected DeviceBudget in-place so
   * the Map stays consistent without requiring a full Redis round-trip.
   */
  private recomputeDeviceBudget(workerId: string, deviceIndex: number): void {
    const budget = this.budgets.get(workerId);
    if (!budget) return;

    const device = budget.devices.find((d) => d.deviceIndex === deviceIndex);
    if (!device) return;

    const reservedBytes = this.getReservation(workerId, deviceIndex);
    device.reservedBytes = reservedBytes;
    device.availableBytes = Math.max(0, device.totalBytes - Math.max(device.usedBytes, reservedBytes));
  }
}
