import { WorkerStatus } from '@sardeenz/types';
import type { Redis } from '../clients/redis.js';
import { redisKey } from '../clients/redis.js';

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface WorkerCapability {
  runnerType: string;
  engineName: string;
  supportedModelTypes: string[];
  supportedDeviceTypes: string[];
  supportedSleepLevels: string[];
}

export interface WorkerDevice {
  deviceIndex: number;
  deviceType: string;
  memoryTotalBytes: number;
}

export interface WorkerRecord {
  workerId: string;
  status: WorkerStatus;
  capabilities: WorkerCapability[];
  devices: WorkerDevice[];
  lastHeartbeatAt: string | null;
  joinedAt: string;
  managementUrl: string | null;
}

// ---------------------------------------------------------------------------
// Internal shape of the Redis worker info value
// ---------------------------------------------------------------------------

interface WorkerInfoPayload {
  capabilities: WorkerCapability[];
  devices: WorkerDevice[];
  managementUrl?: string;
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

function parseWorkerInfo(raw: string): WorkerInfoPayload | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'capabilities' in parsed &&
      'devices' in parsed &&
      Array.isArray((parsed as Record<string, unknown>).capabilities) &&
      Array.isArray((parsed as Record<string, unknown>).devices)
    ) {
      return parsed as WorkerInfoPayload;
    }
    return null;
  } catch {
    return null;
  }
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

      const payload = parseWorkerInfo(raw);
      if (!payload) continue;

      const existing = this.workers.get(workerId);
      const record: WorkerRecord = {
        workerId,
        status: existing?.status ?? WorkerStatus.OFFLINE,
        capabilities: payload.capabilities,
        devices: payload.devices,
        lastHeartbeatAt: existing?.lastHeartbeatAt ?? null,
        joinedAt: existing?.joinedAt ?? now,
        managementUrl: payload.managementUrl ?? null,
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
