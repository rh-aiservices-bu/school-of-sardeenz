import type { WorkerAgentComponents } from '@sardeenz/types';
import { DeviceType } from '@sardeenz/types';
import type { Redis } from '../clients/redis.js';
import { redisKey } from '../clients/redis.js';

export interface DeviceBudget {
  deviceIndex: number;
  deviceType: string;
  totalBytes: number;
  usedBytes: number;
  reservedBytes: number;
  availableBytes: number; // totalBytes - usedBytes - reservedBytes
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
type WorkerMemoryReport = WorkerAgentComponents['schemas']['WorkerMemoryReport'];
type WorkerDeviceMemory = WorkerAgentComponents['schemas']['WorkerDeviceMemory'];

const WORKER_MEMORY_SUBKEY = 'memory';

function workerMemoryKey(prefix: string, workerId: string): string {
  return redisKey(prefix, 'workers', workerId, WORKER_MEMORY_SUBKEY);
}

function isEnumValue<T extends string>(v: unknown, enumObj: Record<string, T>): v is T {
  const values: string[] = Object.values(enumObj);
  return typeof v === 'string' && values.includes(v);
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
   * per-device reservations, keyed as `${workerId}:${deviceIndex}` -> (modelName -> bytes).
   * Reservations are held per-model so that co-located models on the same device do not
   * clobber each other's reservation, and so a model's reservation can be released
   * explicitly (on stop/evict/worker loss) without affecting other models on that device.
   */
  private readonly reservations: Map<string, Map<string, number>> = new Map();

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
    const perModel = this.reservations.get(this.reservationKey(workerId, deviceIndex));
    if (!perModel) return 0;
    let total = 0;
    for (const bytes of perModel.values()) {
      total += bytes;
    }
    return total;
  }

  private isStale(lastReportAt: string): boolean {
    const reportedMs = new Date(lastReportAt).getTime();
    const nowMs = Date.now();
    return nowMs - reportedMs > this.heartbeatTimeoutSecs * 1000;
  }

  private validateDevice(raw: unknown, workerId: string, index: number): WorkerDeviceMemory | null {
    const field = `devices[${index}]`;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      console.warn(
        `[memory-budget] parseReport rejected workerId=${workerId}: ${field} — must be an object`,
      );
      return null;
    }
    const d = raw as Record<string, unknown>;

    if (
      !(typeof d.deviceIndex === 'number' && Number.isInteger(d.deviceIndex) && d.deviceIndex >= 0)
    ) {
      console.warn(
        `[memory-budget] parseReport rejected workerId=${workerId}: ${field}.deviceIndex — must be an integer >= 0`,
      );
      return null;
    }
    if (!isEnumValue(d.deviceType, DeviceType)) {
      console.warn(
        `[memory-budget] parseReport rejected workerId=${workerId}: ${field}.deviceType — must be a valid DeviceType value`,
      );
      return null;
    }
    if (
      !(
        typeof d.memoryUsedBytes === 'number' &&
        Number.isInteger(d.memoryUsedBytes) &&
        d.memoryUsedBytes >= 0
      )
    ) {
      console.warn(
        `[memory-budget] parseReport rejected workerId=${workerId}: ${field}.memoryUsedBytes — must be an integer >= 0`,
      );
      return null;
    }
    if (
      !(
        typeof d.memoryTotalBytes === 'number' &&
        Number.isInteger(d.memoryTotalBytes) &&
        d.memoryTotalBytes >= 0
      )
    ) {
      console.warn(
        `[memory-budget] parseReport rejected workerId=${workerId}: ${field}.memoryTotalBytes — must be an integer >= 0`,
      );
      return null;
    }

    return {
      deviceIndex: d.deviceIndex,
      deviceType: d.deviceType,
      memoryUsedBytes: d.memoryUsedBytes,
      memoryTotalBytes: d.memoryTotalBytes,
    };
  }

  private parseReport(raw: string, workerId: string): WorkerBudget | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.warn(
        `[memory-budget] parseReport rejected workerId=${workerId}: payload — invalid JSON`,
      );
      return null;
    }

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.warn(
        `[memory-budget] parseReport rejected workerId=${workerId}: payload — must be an object`,
      );
      return null;
    }
    const report = parsed as Record<string, unknown> & Partial<WorkerMemoryReport>;

    if (!Array.isArray(report.devices)) {
      console.warn(
        `[memory-budget] parseReport rejected workerId=${workerId}: devices — must be an array`,
      );
      return null;
    }

    const validatedDevices: WorkerDeviceMemory[] = [];
    for (let i = 0; i < report.devices.length; i++) {
      const device = this.validateDevice(report.devices[i], workerId, i);
      if (!device) return null;
      validatedDevices.push(device);
    }

    const lastReportAt =
      typeof report.reportedAt === 'string' ? report.reportedAt : new Date().toISOString();

    const devices: DeviceBudget[] = validatedDevices.map((d) => {
      const reservedBytes = this.getReservation(workerId, d.deviceIndex);
      const availableBytes = d.memoryTotalBytes - d.memoryUsedBytes - reservedBytes;
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
   * budget. Reservations are preserved across refreshes — they are only cleared
   * explicitly via releaseModelReservations or clearWorkerReservations.
   * Returns the refreshed WorkerBudget, or null if no report exists.
   */
  async refreshWorkerBudget(workerId: string): Promise<WorkerBudget | null> {
    const key = workerMemoryKey(this.keyPrefix, workerId);
    const raw = await this.redis.get(key);
    if (!raw) {
      this.budgets.delete(workerId);
      this.clearWorkerReservations(workerId);
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
   * pipeline round-trip. Reservations are preserved across refreshes — they are
   * only cleared explicitly via releaseModelReservations or clearWorkerReservations.
   *
   * After refreshing, writes a per-device memory snapshot to
   * `{prefix}:cluster:memory` so the dashboard BFF can serve stale data
   * when the control plane is unreachable.
   */
  async refreshAll(): Promise<void> {
    const pattern = redisKey(this.keyPrefix, 'workers', '*', WORKER_MEMORY_SUBKEY);
    const keys = await this.scanKeys(pattern);
    if (keys.length === 0) {
      this.budgets.clear();
      this.reservations.clear();
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

    // Remove budgets for workers no longer present in Redis, and clear their reservations —
    // a vanished worker can no longer report usage that would ever satisfy them.
    for (const workerId of this.budgets.keys()) {
      if (!seenWorkers.has(workerId)) {
        this.budgets.delete(workerId);
        this.clearWorkerReservations(workerId);
      }
    }

    // Persist a per-device memory snapshot for BFF fallback reads.
    await this.writeClusterMemorySnapshot();
  }

  /**
   * Write a per-device memory breakdown to Redis for dashboard BFF fallback.
   * Key: `{prefix}:cluster:memory`
   * TTL: 300 seconds (gives BFF up to 5 minutes of stale data).
   */
  private async writeClusterMemorySnapshot(): Promise<void> {
    const budgets = this.getAllBudgets();
    const workers = budgets.map((b) => ({
      workerId: b.workerId,
      devices: b.devices.map((d) => ({
        deviceIndex: d.deviceIndex,
        deviceType: d.deviceType,
        memoryTotalBytes: d.totalBytes,
        memoryUsedBytes: d.usedBytes,
        memoryAvailableBytes: d.availableBytes,
        memoryReservedBytes: d.reservedBytes,
      })),
    }));

    const summary = this.getClusterSummary();
    const snapshot = { workers, summary };

    const key = redisKey(this.keyPrefix, 'cluster', 'memory');
    await this.redis.set(key, JSON.stringify(snapshot), 'EX', 300);
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
   * Reserve capacity on a specific device for a specific model. Idempotent: calling
   * this again for the same (workerId, deviceIndex, modelName) sets the reservation
   * to `bytes` rather than accumulating it.
   *
   * The reservation is held in-memory and applied on top of the Redis-reported
   * usedBytes so that subsequent placement decisions account for in-flight
   * allocations before the worker has had a chance to report updated usage.
   */
  reserveCapacity(workerId: string, deviceIndex: number, modelName: string, bytes: number): void {
    const rk = this.reservationKey(workerId, deviceIndex);
    let perModel = this.reservations.get(rk);
    if (!perModel) {
      perModel = new Map();
      this.reservations.set(rk, perModel);
    }
    perModel.set(modelName, bytes);

    // Recompute the in-memory device budget immediately so callers see the
    // updated availableBytes without waiting for the next refreshWorkerBudget.
    this.recomputeDeviceBudget(workerId, deviceIndex);
  }

  /**
   * Release all reservations held by a model, across every device on every worker.
   * Called on terminal lifecycle transitions (stop, evict) so a model's reserved
   * capacity is never leaked once it is no longer running or about to run.
   */
  releaseModelReservations(modelName: string): void {
    for (const [rk, perModel] of this.reservations) {
      if (!perModel.has(modelName)) continue;
      perModel.delete(modelName);
      if (perModel.size === 0) {
        this.reservations.delete(rk);
      }

      const sepIndex = rk.lastIndexOf(':');
      const workerId = rk.slice(0, sepIndex);
      const deviceIndex = Number(rk.slice(sepIndex + 1));
      this.recomputeDeviceBudget(workerId, deviceIndex);
    }
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

  private async scanKeys(pattern: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [nextCursor, batch] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = nextCursor;
      keys.push(...batch);
    } while (cursor !== '0');
    return keys;
  }

  /**
   * Clear every reservation held on any device for the given worker. Called when a
   * worker is removed (heartbeat lost, report vanished) so its reservations don't
   * linger and block placement forever.
   */
  clearWorkerReservations(workerId: string): void {
    const prefix = `${workerId}:`;
    for (const key of this.reservations.keys()) {
      if (!key.startsWith(prefix)) continue;
      this.reservations.delete(key);

      const deviceIndex = Number(key.slice(prefix.length));
      this.recomputeDeviceBudget(workerId, deviceIndex);
    }
  }

  private recomputeDeviceBudget(workerId: string, deviceIndex: number): void {
    const budget = this.budgets.get(workerId);
    if (!budget) return;

    const device = budget.devices.find((d) => d.deviceIndex === deviceIndex);
    if (!device) return;

    const reservedBytes = this.getReservation(workerId, deviceIndex);
    device.reservedBytes = reservedBytes;
    device.availableBytes = Math.max(0, device.totalBytes - device.usedBytes - reservedBytes);
  }
}
