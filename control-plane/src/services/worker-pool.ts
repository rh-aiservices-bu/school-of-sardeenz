import type { WorkerAgentComponents } from '@sardeenz/types';
import { WorkerStatus, DeviceType, ModelType, SleepLevel } from '@sardeenz/types';
import type { Redis } from '../clients/redis.js';
import { redisKey } from '../clients/redis.js';

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export type WorkerCapability = WorkerAgentComponents['schemas']['WorkerCapability'];
export type WorkerDevice = WorkerAgentComponents['schemas']['WorkerDeviceInfo'];
type WorkerInfoPayload = WorkerAgentComponents['schemas']['WorkerInfo'];

export interface WorkerRecord {
  workerId: string;
  status: WorkerStatus;
  capabilities: WorkerCapability[];
  devices: WorkerDevice[];
  lastHeartbeatAt: string | null;
  joinedAt: string;
  managementUrl: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INFO_SUFFIX = 'info';
const HEARTBEAT_SUFFIX = 'heartbeat';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the workerId from a Redis key of the form
 * `sardeenz:workers:{workerId}:info`.
 */
function extractWorkerIdFromInfoKey(key: string): string | null {
  // Strip any leading keyPrefix added by the ioredis client (none in this
  // repo — keyPrefix is always '') then parse the fixed structure.
  const parts = key.split(':');
  // Expected: ['sardeenz', 'workers', workerId, 'info']
  if (parts.length < 4 || parts[parts.length - 1] !== INFO_SUFFIX) return null;
  // The workerId may itself contain colons, so rejoin the middle segments.
  return parts.slice(2, parts.length - 1).join(':');
}

function rejectWorkerInfo(workerId: string, field: string, reason: string): null {
  console.warn(`[worker-pool] parseWorkerInfo rejected workerId=${workerId}: ${field} — ${reason}`);
  return null;
}

function isNonNegativeInteger(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

function isEnumValue<T extends string>(v: unknown, enumObj: Record<string, T>): v is T {
  const values: string[] = Object.values(enumObj);
  return typeof v === 'string' && values.includes(v);
}

function isEnumArray<T extends string>(v: unknown, enumObj: Record<string, T>): v is T[] {
  if (!Array.isArray(v) || v.length === 0) return false;
  return v.every((item) => isEnumValue(item, enumObj));
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function validateCapability(
  raw: unknown,
  workerId: string,
  index: number,
): WorkerCapability | null {
  const field = `capabilities[${index}]`;
  if (!isPlainObject(raw)) return rejectWorkerInfo(workerId, field, 'must be an object');

  if (typeof raw.runnerType !== 'string' || raw.runnerType.length === 0) {
    return rejectWorkerInfo(workerId, `${field}.runnerType`, 'must be a non-empty string');
  }
  if (typeof raw.engineName !== 'string') {
    return rejectWorkerInfo(workerId, `${field}.engineName`, 'must be a string');
  }
  if (!isEnumArray(raw.supportedModelTypes, ModelType)) {
    return rejectWorkerInfo(
      workerId,
      `${field}.supportedModelTypes`,
      'must be a non-empty array of valid ModelType values',
    );
  }
  if (!isEnumArray(raw.supportedDeviceTypes, DeviceType)) {
    return rejectWorkerInfo(
      workerId,
      `${field}.supportedDeviceTypes`,
      'must be a non-empty array of valid DeviceType values',
    );
  }
  if (!isEnumArray(raw.supportedSleepLevels, SleepLevel)) {
    return rejectWorkerInfo(
      workerId,
      `${field}.supportedSleepLevels`,
      'must be a non-empty array of valid SleepLevel values',
    );
  }
  if (raw.engineVersion !== undefined && typeof raw.engineVersion !== 'string') {
    return rejectWorkerInfo(workerId, `${field}.engineVersion`, 'must be a string if present');
  }
  if (
    raw.maxTensorParallelism !== undefined &&
    !(isNonNegativeInteger(raw.maxTensorParallelism) && raw.maxTensorParallelism >= 1)
  ) {
    return rejectWorkerInfo(
      workerId,
      `${field}.maxTensorParallelism`,
      'must be an integer >= 1 if present',
    );
  }
  if (raw.kvCacheElasticSharing !== undefined && typeof raw.kvCacheElasticSharing !== 'boolean') {
    return rejectWorkerInfo(
      workerId,
      `${field}.kvCacheElasticSharing`,
      'must be a boolean if present',
    );
  }
  if (raw.features !== undefined && !isPlainObject(raw.features)) {
    return rejectWorkerInfo(workerId, `${field}.features`, 'must be an object if present');
  }

  return {
    runnerType: raw.runnerType,
    engineName: raw.engineName,
    supportedModelTypes: raw.supportedModelTypes,
    supportedDeviceTypes: raw.supportedDeviceTypes,
    supportedSleepLevels: raw.supportedSleepLevels,
    engineVersion: raw.engineVersion,
    maxTensorParallelism: isNonNegativeInteger(raw.maxTensorParallelism)
      ? raw.maxTensorParallelism
      : 1,
    kvCacheElasticSharing:
      typeof raw.kvCacheElasticSharing === 'boolean' ? raw.kvCacheElasticSharing : false,
    features: raw.features,
  };
}

function validateDevice(raw: unknown, workerId: string, index: number): WorkerDevice | null {
  const field = `devices[${index}]`;
  if (!isPlainObject(raw)) return rejectWorkerInfo(workerId, field, 'must be an object');

  if (!isNonNegativeInteger(raw.deviceIndex)) {
    return rejectWorkerInfo(workerId, `${field}.deviceIndex`, 'must be an integer >= 0');
  }
  if (!isEnumValue(raw.deviceType, DeviceType)) {
    return rejectWorkerInfo(workerId, `${field}.deviceType`, 'must be a valid DeviceType value');
  }
  if (!isNonNegativeInteger(raw.memoryTotalBytes)) {
    return rejectWorkerInfo(workerId, `${field}.memoryTotalBytes`, 'must be an integer >= 0');
  }

  return {
    deviceIndex: raw.deviceIndex,
    deviceType: raw.deviceType,
    memoryTotalBytes: raw.memoryTotalBytes,
  };
}

function parseWorkerInfo(raw: string, workerId: string): WorkerInfoPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return rejectWorkerInfo(workerId, 'payload', 'invalid JSON');
  }

  if (!isPlainObject(parsed)) {
    return rejectWorkerInfo(workerId, 'payload', 'must be an object');
  }

  if (typeof parsed.managementUrl !== 'string' || parsed.managementUrl.length === 0) {
    return rejectWorkerInfo(workerId, 'managementUrl', 'must be a non-empty string');
  }

  if (!Array.isArray(parsed.capabilities) || parsed.capabilities.length === 0) {
    return rejectWorkerInfo(workerId, 'capabilities', 'must be a non-empty array');
  }

  const capabilities: WorkerCapability[] = [];
  for (let i = 0; i < parsed.capabilities.length; i++) {
    const capability = validateCapability(parsed.capabilities[i], workerId, i);
    if (!capability) return null;
    capabilities.push(capability);
  }

  if (!Array.isArray(parsed.devices)) {
    return rejectWorkerInfo(workerId, 'devices', 'must be an array');
  }

  if (parsed.devices.length === 0) {
    console.warn(
      `[worker-pool] parseWorkerInfo workerId=${workerId}: devices — empty array accepted`,
    );
  }

  const devices: WorkerDevice[] = [];
  for (let i = 0; i < parsed.devices.length; i++) {
    const device = validateDevice(parsed.devices[i], workerId, i);
    if (!device) return null;
    devices.push(device);
  }

  return { capabilities, devices, managementUrl: parsed.managementUrl };
}

function parseHeartbeatTimestamp(raw: string): Date | null {
  const ts = new Date(raw);
  return isNaN(ts.getTime()) ? null : ts;
}

function resolveHeartbeatStatus(
  lastHeartbeatAt: string | null,
  heartbeatTimeoutSecs: number,
): WorkerStatus {
  if (!lastHeartbeatAt) return WorkerStatus.OFFLINE;

  const hb = parseHeartbeatTimestamp(lastHeartbeatAt);
  if (!hb) return WorkerStatus.OFFLINE;

  const ageMs = Date.now() - hb.getTime();
  const timeoutMs = heartbeatTimeoutSecs * 1000;
  const degradedMs = timeoutMs / 2;

  if (ageMs >= timeoutMs) return WorkerStatus.OFFLINE;
  if (ageMs >= degradedMs) return WorkerStatus.DEGRADED;
  return WorkerStatus.ONLINE;
}

// ---------------------------------------------------------------------------
// WorkerPoolService
// ---------------------------------------------------------------------------

export class WorkerPoolService {
  private readonly workers: Map<string, WorkerRecord> = new Map();

  constructor(
    private readonly redis: Redis,
    private readonly keyPrefix: string,
    private readonly heartbeatTimeoutSecs: number,
  ) {}

  // -------------------------------------------------------------------------
  // Key builders
  // -------------------------------------------------------------------------

  private infoKey(workerId: string): string {
    return redisKey(this.keyPrefix, 'workers', workerId, INFO_SUFFIX);
  }

  private heartbeatKey(workerId: string): string {
    return redisKey(this.keyPrefix, 'workers', workerId, HEARTBEAT_SUFFIX);
  }

  private infoScanPattern(): string {
    return redisKey(this.keyPrefix, 'workers', '*', INFO_SUFFIX);
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Scan Redis for all `sardeenz:workers:*:info` keys and populate the
   * in-memory registry. Existing records are replaced on re-discovery.
   */
  async discoverWorkers(): Promise<void> {
    const pattern = this.infoScanPattern();
    const infoKeys = await this.scanKeys(pattern);

    if (infoKeys.length === 0) return;

    // Batch-fetch all info blobs.
    const infoPipeline = this.redis.pipeline();
    for (const key of infoKeys) {
      infoPipeline.get(key);
    }
    const infoResults = await infoPipeline.exec();
    if (!infoResults) return;

    const now = new Date().toISOString();
    const discoveredWorkerIds: string[] = [];

    for (let i = 0; i < infoKeys.length; i++) {
      const key = infoKeys[i];
      const [err, raw] = infoResults[i];
      if (err || typeof raw !== 'string') continue;

      const workerId = extractWorkerIdFromInfoKey(key);
      if (!workerId) continue;

      const payload = parseWorkerInfo(raw, workerId);
      if (!payload) continue;

      const existing = this.workers.get(workerId);
      const record: WorkerRecord = {
        workerId,
        status: existing?.status ?? WorkerStatus.OFFLINE,
        capabilities: payload.capabilities,
        devices: payload.devices,
        lastHeartbeatAt: existing?.lastHeartbeatAt ?? null,
        joinedAt: existing?.joinedAt ?? now,
        managementUrl: payload.managementUrl,
      };
      this.workers.set(workerId, record);
      discoveredWorkerIds.push(workerId);
    }

    // Batch-fetch heartbeats for all discovered workers so status is accurate
    // immediately after discovery (avoids a separate checkHeartbeats() call).
    if (discoveredWorkerIds.length > 0) {
      const hbPipeline = this.redis.pipeline();
      for (const workerId of discoveredWorkerIds) {
        hbPipeline.get(this.heartbeatKey(workerId));
      }
      const hbResults = await hbPipeline.exec();
      if (hbResults) {
        for (let i = 0; i < discoveredWorkerIds.length; i++) {
          const workerId = discoveredWorkerIds[i];
          const [err, raw] = hbResults[i];
          const record = this.workers.get(workerId);
          if (!record) continue;

          const lastHeartbeatAt = !err && typeof raw === 'string' ? raw : null;

          record.lastHeartbeatAt = lastHeartbeatAt;
          record.status = resolveHeartbeatStatus(lastHeartbeatAt, this.heartbeatTimeoutSecs);
        }
      }
    }
  }

  /**
   * Return the WorkerRecord for a given worker, or null if not registered.
   */
  getWorker(workerId: string): WorkerRecord | null {
    return this.workers.get(workerId) ?? null;
  }

  /**
   * Return all registered WorkerRecords.
   */
  getAllWorkers(): WorkerRecord[] {
    return Array.from(this.workers.values());
  }

  /**
   * Read heartbeat timestamps from Redis for all known workers and update
   * their status to ONLINE / DEGRADED / OFFLINE based on age.
   *
   * After updating statuses, writes each worker's full record to Redis under
   * `{prefix}:worker:{workerId}:detail` so the dashboard BFF can serve stale
   * worker detail when the control plane is unreachable.
   */
  async checkHeartbeats(): Promise<void> {
    const workerIds = Array.from(this.workers.keys());
    if (workerIds.length === 0) return;

    const pipeline = this.redis.pipeline();
    for (const workerId of workerIds) {
      pipeline.get(this.heartbeatKey(workerId));
    }
    const results = await pipeline.exec();
    if (!results) return;

    for (let i = 0; i < workerIds.length; i++) {
      const workerId = workerIds[i];
      const record = this.workers.get(workerId);
      if (!record) continue;

      const [err, raw] = results[i];
      const lastHeartbeatAt = !err && typeof raw === 'string' ? raw : null;

      record.lastHeartbeatAt = lastHeartbeatAt;
      record.status = resolveHeartbeatStatus(lastHeartbeatAt, this.heartbeatTimeoutSecs);
    }

    // Persist individual worker records for BFF fallback reads.
    await this.writeWorkerDetailSnapshots(workerIds);
  }

  /**
   * Write each worker's full record to Redis for dashboard BFF fallback.
   * Key: `{prefix}:worker:{workerId}:detail`
   * TTL: 120 seconds — dead workers expire quickly so stale data doesn't linger.
   */
  private async writeWorkerDetailSnapshots(workerIds: string[]): Promise<void> {
    if (workerIds.length === 0) return;

    const writePipeline = this.redis.pipeline();
    for (const workerId of workerIds) {
      const record = this.workers.get(workerId);
      if (!record) continue;
      const key = redisKey(this.keyPrefix, 'worker', workerId, 'detail');
      writePipeline.set(key, JSON.stringify(record), 'EX', 120);
    }
    await writePipeline.exec();
  }

  /**
   * Return all workers currently in OFFLINE status.
   */
  getDeadWorkers(): WorkerRecord[] {
    return Array.from(this.workers.values()).filter((w) => w.status === WorkerStatus.OFFLINE);
  }

  /**
   * Remove a worker from the in-memory registry. Does not touch Redis.
   */
  removeWorker(workerId: string): void {
    this.workers.delete(workerId);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Full scan of Redis keys matching `pattern`, using SCAN to avoid blocking.
   */
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
}
