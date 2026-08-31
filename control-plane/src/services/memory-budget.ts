import type { WorkerAgentComponents } from '@sardeenz/types';
import { DeviceType } from '@sardeenz/types';
import type { Redis } from '../clients/redis.js';
import { redisKey } from '../clients/redis.js';

// Doctrine (#163 measured-only round): measured device memory IS usedBytes — there is no
// separate ledger figure and no user-facing "reserved" number. In-flight placement holds (an
// instance that has been placed but hasn't reported usage yet) are an INTERNAL scheduling detail:
// they shift `availableBytes` down so placement doesn't double-book a device, but they are never
// exposed as a field on DeviceBudget, ClusterSummary, or anywhere downstream. The `reservations`
// map and reserveCapacity/releaseInstanceReservations/clearWorkerReservations below still exist
// and behave exactly as before — only their visibility changed, not their mechanics.
export interface DeviceBudget {
  deviceIndex: number;
  deviceType: string;
  totalBytes: number;
  /** Measured device memory in use, in bytes (NVML `memoryUsedBytes`, stub-simulated without
   *  NVML). Includes memory consumed by processes outside Sardeenz's control. */
  usedBytes: number;
  /** max(0, totalBytes - usedBytes - internal placement holds). Holds are not exposed as a
   *  separate field — see the doctrine note above. */
  availableBytes: number;
  /** Device product name from NVML (e.g. "NVIDIA GeForce RTX 4070 Ti"). Absent when unavailable. */
  deviceName?: string;
  /** GPU utilization percentage at report time. Absent when unavailable. */
  utilizationPercent?: number;
  /** GPU temperature in degrees Celsius at report time. Absent when unavailable. */
  temperatureC?: number;
  /** Measured kvcached pool state for this device (prealloc/used/free partition). Absent when no
   *  kvcached pool is reported for the device. Telemetry only — never feeds placement math. */
  kvCache?: {
    totalBytes: number;
    usedBytes: number;
    preallocBytes: number;
    freeBytes: number;
  };
}

/** Measured bytes attributed to one instance on one device (NVML process-list attribution). */
export interface InstanceMeasurement {
  instanceId: string;
  modelName: string;
  deviceIndex: number;
  measuredUsedBytes: number;
}

export interface WorkerBudget {
  workerId: string;
  devices: DeviceBudget[];
  lastReportAt: string;
  stale: boolean;
  /** Per-instance measured bytes from this worker's last report. Telemetry only. */
  instanceMeasurements?: InstanceMeasurement[];
}

interface ClusterSummary {
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
}

/** Shape of the JSON object workers push to Redis. */
type WorkerMemoryReport = WorkerAgentComponents['schemas']['WorkerMemoryReport'];
type WorkerDeviceMemory = WorkerAgentComponents['schemas']['WorkerDeviceMemory'];
type InstanceMemoryMeasurement = WorkerAgentComponents['schemas']['InstanceMemoryMeasurement'];

const WORKER_MEMORY_SUBKEY = 'memory';

function workerMemoryKey(prefix: string, workerId: string): string {
  return redisKey(prefix, 'workers', workerId, WORKER_MEMORY_SUBKEY);
}

/** One non-negative-integer field of a kvCache block. */
function nonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * Validate a worker-reported kvCache block (issue #165). Returns the block, or undefined when
 * it is malformed (dropped, with a warning via the caller's prefix) — telemetry-tolerant policy:
 * a bad kvcached reading never rejects the surrounding device/report.
 */
function validateKVCacheBlock(
  raw: unknown,
  warnPrefix: string,
): { totalBytes: number; usedBytes: number; preallocBytes: number; freeBytes: number } | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    console.warn(`${warnPrefix} — must be an object, core report kept`);
    return undefined;
  }
  const kv = raw as Record<string, unknown>;
  const totalBytes = kv.totalBytes;
  const usedBytes = kv.usedBytes;
  const preallocBytes = kv.preallocBytes;
  const freeBytes = kv.freeBytes;
  if (!nonNegativeInt(totalBytes)) {
    console.warn(`${warnPrefix}.totalBytes — must be an integer >= 0, core report kept`);
    return undefined;
  }
  if (!nonNegativeInt(usedBytes)) {
    console.warn(`${warnPrefix}.usedBytes — must be an integer >= 0, core report kept`);
    return undefined;
  }
  if (!nonNegativeInt(preallocBytes)) {
    console.warn(`${warnPrefix}.preallocBytes — must be an integer >= 0, core report kept`);
    return undefined;
  }
  if (!nonNegativeInt(freeBytes)) {
    console.warn(`${warnPrefix}.freeBytes — must be an integer >= 0, core report kept`);
    return undefined;
  }
  return { totalBytes, usedBytes, preallocBytes, freeBytes };
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
   * per-device reservations, keyed as `${workerId}:${deviceIndex}` -> (instanceId -> bytes).
   * Reservations are held per-instance (#120) so that co-located instances — including two
   * replicas of the same model on the same device — do not clobber each other's reservation,
   * and so one instance's reservation can be released explicitly (on stop/evict/worker loss)
   * without affecting other instances on that device.
   */
  private readonly reservations: Map<string, Map<string, number>> = new Map();

  constructor(
    private readonly redis: Redis,
    private readonly keyPrefix: string,
    // Staleness horizon for memory reports — not worker liveness. Sized to tolerate legitimate
    // in-memory ageing between reconciliation refreshes on top of the worker's report cadence
    // (see the construction site in index.ts); worker ONLINE/OFFLINE keeps the strict timeout.
    private readonly staleAfterSecs: number,
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
    return nowMs - reportedMs > this.staleAfterSecs * 1000;
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

    // Telemetry-tolerant: deviceName/utilizationPercent/temperatureC are optional NVML extras
    // and, unlike the ledger fields above, a malformed value is dropped (with a warning) rather
    // than rejecting the whole device/report — a bad NVML reading must never take down
    // placement/eviction math.
    let deviceName: string | undefined;
    if (d.deviceName !== undefined) {
      if (typeof d.deviceName === 'string' && d.deviceName.length > 0) {
        deviceName = d.deviceName;
      } else {
        console.warn(
          `[memory-budget] parseReport dropped workerId=${workerId}: ${field}.deviceName — must be a non-empty string, core report kept`,
        );
      }
    }

    let utilizationPercent: number | undefined;
    if (d.utilizationPercent !== undefined) {
      if (
        typeof d.utilizationPercent === 'number' &&
        Number.isInteger(d.utilizationPercent) &&
        d.utilizationPercent >= 0 &&
        d.utilizationPercent <= 100
      ) {
        utilizationPercent = d.utilizationPercent;
      } else {
        console.warn(
          `[memory-budget] parseReport dropped workerId=${workerId}: ${field}.utilizationPercent — must be an integer in [0, 100], core report kept`,
        );
      }
    }

    let temperatureC: number | undefined;
    if (d.temperatureC !== undefined) {
      if (typeof d.temperatureC === 'number' && Number.isInteger(d.temperatureC)) {
        temperatureC = d.temperatureC;
      } else {
        console.warn(
          `[memory-budget] parseReport dropped workerId=${workerId}: ${field}.temperatureC — must be an integer, core report kept`,
        );
      }
    }

    // Telemetry-tolerant, like the NVML extras above: a malformed kvCache block (issue #165) is
    // dropped (with a warning) rather than rejecting the device — kvcached pool telemetry must
    // never take down placement/eviction math.
    const kvCache =
      d.kvCache === undefined
        ? undefined
        : validateKVCacheBlock(d.kvCache, `[memory-budget] parseReport dropped workerId=${workerId}: ${field}.kvCache`);

    return {
      deviceIndex: d.deviceIndex,
      deviceType: d.deviceType,
      memoryUsedBytes: d.memoryUsedBytes,
      memoryTotalBytes: d.memoryTotalBytes,
      ...(deviceName !== undefined ? { deviceName } : {}),
      ...(utilizationPercent !== undefined ? { utilizationPercent } : {}),
      ...(temperatureC !== undefined ? { temperatureC } : {}),
      ...(kvCache !== undefined ? { kvCache } : {}),
    };
  }

  /**
   * Validate a single `instances[]` measurement entry. Telemetry-tolerant like the optional
   * device fields above: a malformed entry is dropped (with a warning) rather than rejecting the
   * whole report.
   */
  private validateInstanceMeasurement(
    raw: unknown,
    workerId: string,
    index: number,
  ): InstanceMemoryMeasurement | null {
    const field = `instances[${index}]`;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      console.warn(
        `[memory-budget] parseReport dropped workerId=${workerId}: ${field} — must be an object`,
      );
      return null;
    }
    const m = raw as Record<string, unknown>;

    if (typeof m.instanceId !== 'string' || m.instanceId.length === 0) {
      console.warn(
        `[memory-budget] parseReport dropped workerId=${workerId}: ${field}.instanceId — must be a non-empty string`,
      );
      return null;
    }
    if (typeof m.modelName !== 'string' || m.modelName.length === 0) {
      console.warn(
        `[memory-budget] parseReport dropped workerId=${workerId}: ${field}.modelName — must be a non-empty string`,
      );
      return null;
    }
    if (
      !(typeof m.deviceIndex === 'number' && Number.isInteger(m.deviceIndex) && m.deviceIndex >= 0)
    ) {
      console.warn(
        `[memory-budget] parseReport dropped workerId=${workerId}: ${field}.deviceIndex — must be an integer >= 0`,
      );
      return null;
    }
    if (
      !(
        typeof m.memoryUsedBytes === 'number' &&
        Number.isInteger(m.memoryUsedBytes) &&
        m.memoryUsedBytes >= 0
      )
    ) {
      console.warn(
        `[memory-budget] parseReport dropped workerId=${workerId}: ${field}.memoryUsedBytes — must be an integer >= 0`,
      );
      return null;
    }

    return {
      instanceId: m.instanceId,
      modelName: m.modelName,
      deviceIndex: m.deviceIndex,
      memoryUsedBytes: m.memoryUsedBytes,
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

    // Telemetry-tolerant, like the optional device fields: `instances` as a whole is optional,
    // and a malformed `instances` (wrong type, or individual bad entries) is dropped without
    // rejecting the core report — the ledger fields above have already been validated by this
    // point.
    let instanceMeasurements: InstanceMemoryMeasurement[] | undefined;
    if (report.instances !== undefined) {
      if (!Array.isArray(report.instances)) {
        console.warn(
          `[memory-budget] parseReport dropped workerId=${workerId}: instances — must be an array, core report kept`,
        );
      } else {
        const validated: InstanceMemoryMeasurement[] = [];
        for (let i = 0; i < report.instances.length; i++) {
          const measurement = this.validateInstanceMeasurement(report.instances[i], workerId, i);
          if (measurement) validated.push(measurement);
        }
        instanceMeasurements = validated;
      }
    }

    const lastReportAt =
      typeof report.reportedAt === 'string' ? report.reportedAt : new Date().toISOString();

    const devices: DeviceBudget[] = validatedDevices.map((d) => {
      // "reservedBytes" here is the internal placement hold (see the doctrine note at the top of
      // the file) — it shifts availableBytes but is never exposed as a field.
      const heldBytes = this.getReservation(workerId, d.deviceIndex);
      const availableBytes = d.memoryTotalBytes - d.memoryUsedBytes - heldBytes;
      return {
        deviceIndex: d.deviceIndex,
        deviceType: d.deviceType,
        totalBytes: d.memoryTotalBytes,
        usedBytes: d.memoryUsedBytes,
        availableBytes: Math.max(0, availableBytes),
        ...(d.deviceName !== undefined ? { deviceName: d.deviceName } : {}),
        ...(d.utilizationPercent !== undefined ? { utilizationPercent: d.utilizationPercent } : {}),
        ...(d.temperatureC !== undefined ? { temperatureC: d.temperatureC } : {}),
        ...(d.kvCache !== undefined ? { kvCache: d.kvCache } : {}),
      };
    });

    return {
      workerId,
      devices,
      lastReportAt,
      stale: false, // freshly read from Redis — not stale
      ...(instanceMeasurements !== undefined
        ? {
            instanceMeasurements: instanceMeasurements.map((m) => ({
              instanceId: m.instanceId,
              modelName: m.modelName,
              deviceIndex: m.deviceIndex,
              measuredUsedBytes: m.memoryUsedBytes,
            })),
          }
        : {}),
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
        ...(d.deviceName !== undefined ? { deviceName: d.deviceName } : {}),
        ...(d.utilizationPercent !== undefined ? { utilizationPercent: d.utilizationPercent } : {}),
        ...(d.temperatureC !== undefined ? { temperatureC: d.temperatureC } : {}),
        ...(d.kvCache !== undefined ? { kvCache: d.kvCache } : {}),
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
   * Reserve capacity on a specific device for a specific instance. Idempotent: calling
   * this again for the same (workerId, deviceIndex, instanceId) sets the reservation
   * to `bytes` rather than accumulating it.
   *
   * The reservation is held in-memory and applied on top of the Redis-reported
   * usedBytes so that subsequent placement decisions account for in-flight
   * allocations before the worker has had a chance to report updated usage.
   */
  reserveCapacity(workerId: string, deviceIndex: number, instanceId: string, bytes: number): void {
    const rk = this.reservationKey(workerId, deviceIndex);
    let perInstance = this.reservations.get(rk);
    if (!perInstance) {
      perInstance = new Map();
      this.reservations.set(rk, perInstance);
    }
    perInstance.set(instanceId, bytes);

    // Recompute the in-memory device budget immediately so callers see the
    // updated availableBytes without waiting for the next refreshWorkerBudget.
    this.recomputeDeviceBudget(workerId, deviceIndex);
  }

  /**
   * Release all reservations held by an instance, across every device on every worker.
   * Called on terminal lifecycle transitions (stop, evict) so an instance's reserved
   * capacity is never leaked once it is no longer running or about to run.
   */
  releaseInstanceReservations(instanceId: string): void {
    for (const [rk, perInstance] of this.reservations) {
      if (!perInstance.has(instanceId)) continue;
      perInstance.delete(instanceId);
      if (perInstance.size === 0) {
        this.reservations.delete(rk);
      }

      const sepIndex = rk.lastIndexOf(':');
      const workerId = rk.slice(0, sepIndex);
      const deviceIndex = Number(rk.slice(sepIndex + 1));
      this.recomputeDeviceBudget(workerId, deviceIndex);
    }
  }

  /**
   * Aggregate memory figures across every non-stale worker and device. `usedBytes` is measured
   * (NVML), `availableBytes` already nets out internal placement holds — neither holds nor a
   * separate "measured" figure are exposed here (see the doctrine note at the top of the file).
   */
  getClusterSummary(): ClusterSummary {
    let totalBytes = 0;
    let usedBytes = 0;
    let availableBytes = 0;

    for (const budget of this.getAllBudgets()) {
      if (budget.stale) continue;
      for (const device of budget.devices) {
        totalBytes += device.totalBytes;
        usedBytes += device.usedBytes;
        availableBytes += device.availableBytes;
      }
    }

    return { totalBytes, usedBytes, availableBytes };
  }

  /**
   * Aggregate measured bytes by instanceId across every non-stale worker/device. Telemetry only
   * — used by the models routes to populate `currentMemory`, never by placement/eviction.
   */
  getMeasuredByInstance(): Map<string, number> {
    const byInstance = new Map<string, number>();
    for (const budget of this.getAllBudgets()) {
      if (budget.stale) continue;
      for (const measurement of budget.instanceMeasurements ?? []) {
        byInstance.set(
          measurement.instanceId,
          (byInstance.get(measurement.instanceId) ?? 0) + measurement.measuredUsedBytes,
        );
      }
    }
    return byInstance;
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

    // Internal placement hold only — not stored as a field on DeviceBudget (doctrine note above).
    const heldBytes = this.getReservation(workerId, deviceIndex);
    device.availableBytes = Math.max(0, device.totalBytes - device.usedBytes - heldBytes);
  }
}
