import { Redis } from 'ioredis';
import type { Config } from '../config.js';
import { ModelLifecycleState, WorkerStatus } from '@sardeenz/types';
import type { ControlPlaneComponents } from '@sardeenz/types';

type ModelInfo = ControlPlaneComponents['schemas']['ModelInfo'];
type WorkerInfo = ControlPlaneComponents['schemas']['WorkerInfo'];
type WorkerDetail = ControlPlaneComponents['schemas']['WorkerDetail'];
type ClusterStatus = ControlPlaneComponents['schemas']['ClusterStatus'];
type ClusterMemory = ControlPlaneComponents['schemas']['ClusterMemory'];

/**
 * Derive worker status from heartbeat age.  Mirrors the logic in
 * `control-plane/src/services/worker-pool.ts::resolveHeartbeatStatus`.
 */
function resolveHeartbeatStatus(
  lastHeartbeatAt: string | null,
  heartbeatTimeoutSecs: number,
): WorkerStatus {
  if (!lastHeartbeatAt) return WorkerStatus.OFFLINE;

  const hb = new Date(lastHeartbeatAt);
  if (isNaN(hb.getTime())) return WorkerStatus.OFFLINE;

  const ageMs = Date.now() - hb.getTime();
  const timeoutMs = heartbeatTimeoutSecs * 1000;
  const degradedMs = timeoutMs / 2;

  if (ageMs >= timeoutMs) return WorkerStatus.OFFLINE;
  if (ageMs >= degradedMs) return WorkerStatus.DEGRADED;
  return WorkerStatus.ONLINE;
}

export class RedisReader {
  private readonly client: Redis;
  private readonly prefix: string;

  constructor(config: Config) {
    this.client = new Redis(config.redisUrl, {
      maxRetriesPerRequest: 3,
      retryStrategy: (times: number) => Math.min(times * 200, 2000),
    });
    this.prefix = config.redisKeyPrefix;
  }

  /** Scan for all keys matching a pattern and return them. */
  private async scanKeys(pattern: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [nextCursor, batch] = await this.client.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = nextCursor;
      keys.push(...batch);
    } while (cursor !== '0');
    return keys;
  }

  /**
   * Extract model name from a `{prefix}:models:{modelName}` key.
   *
   * The control plane stores each model as a single JSON blob at
   * `{prefix}:models:{modelName}`.  The model name may itself contain
   * colons so we strip the known prefix and return the rest.
   */
  private modelNameFromKey(key: string): string {
    const modelsPrefix = `${this.prefix}:models:`;
    return key.slice(modelsPrefix.length);
  }

  async getModelNames(): Promise<string[]> {
    const keys = await this.scanKeys(`${this.prefix}:models:*`);
    return keys.map((k) => this.modelNameFromKey(k));
  }

  /**
   * Read a single model's state from Redis.
   *
   * The control plane persists model state as a single JSON blob at
   * `{prefix}:models:{modelName}` with the shape defined by
   * `ModelLifecycleService.ModelState` (modelName, state, workerId,
   * runnerHost, runnerPort, runnerId, lastInferenceAt, stateChangedAt,
   * errorMessage).
   *
   * Last-inference timestamps are stored separately at
   * `{prefix}:inference:last:{modelName}` — the blob's own
   * `lastInferenceAt` may lag behind, so we prefer the dedicated key
   * when available.
   */
  async getModel(name: string): Promise<ModelInfo | null> {
    const raw = await this.client.get(`${this.prefix}:models:${name}`);
    if (raw === null) return null;

    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed === null || typeof parsed !== 'object') return null;

      const blob = parsed as Record<string, unknown>;

      // Validate state — fall back to ERROR for unknown values.
      const stateRaw = blob['state'];
      const state =
        typeof stateRaw === 'string' &&
        Object.values(ModelLifecycleState).includes(stateRaw as ModelLifecycleState)
          ? (stateRaw as ModelLifecycleState)
          : ModelLifecycleState.ERROR;

      const model: ModelInfo = {
        modelName: name,
        state,
        // The control plane blob doesn't carry runnerType — it's stored in
        // PostgreSQL.  Fall back to 'unknown' for the Redis-only path.
        runnerType: typeof blob['runnerType'] === 'string' ? blob['runnerType'] : 'unknown',
        createdAt:
          typeof blob['stateChangedAt'] === 'string'
            ? blob['stateChangedAt']
            : new Date(0).toISOString(),
      };

      if (typeof blob['workerId'] === 'string') model.workerId = blob['workerId'];

      // Prefer the dedicated inference timestamp key over the blob field.
      const inferenceRaw = await this.client.get(`${this.prefix}:inference:last:${name}`);
      const lastInferenceAt =
        inferenceRaw ??
        (typeof blob['lastInferenceAt'] === 'string' ? blob['lastInferenceAt'] : null);
      if (lastInferenceAt) model.lastInferenceAt = lastInferenceAt;

      return model;
    } catch {
      return null;
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    const names = await this.getModelNames();
    if (names.length === 0) return [];

    const models = await Promise.all(names.map((n) => this.getModel(n)));
    return models.filter((m): m is ModelInfo => m !== null);
  }

  /**
   * List workers from Redis.
   *
   * The control plane writes two sets of worker keys:
   *
   * 1. Discovery keys written by worker registration:
   *    - `{prefix}:workers:{workerId}:info`  — JSON with capabilities,
   *      devices, and optional managementUrl (no workerId field).
   *    - `{prefix}:workers:{workerId}:heartbeat` — ISO timestamp string.
   *
   * 2. Detail snapshots written by `WorkerPoolService.checkHeartbeats()`:
   *    - `{prefix}:worker:{workerId}:detail` — full WorkerRecord JSON
   *      including workerId, status, capabilities, devices,
   *      lastHeartbeatAt, joinedAt, managementUrl.
   *
   * For listing we prefer the detail snapshots (path 2) because they
   * already include resolved status and workerId.  If no detail
   * snapshots exist we fall back to scanning the info keys (path 1) and
   * deriving status from heartbeat age.
   */
  async listWorkers(): Promise<WorkerInfo[]> {
    // --- Strategy 1: detail snapshots (preferred) --------------------------
    const detailKeys = await this.scanKeys(`${this.prefix}:worker:*:detail`);
    if (detailKeys.length > 0) {
      return this.listWorkersFromDetailKeys(detailKeys);
    }

    // --- Strategy 2: info + heartbeat keys (fallback) ----------------------
    const infoKeys = await this.scanKeys(`${this.prefix}:workers:*:info`);
    if (infoKeys.length === 0) return [];

    return this.listWorkersFromInfoKeys(infoKeys);
  }

  /**
   * Build WorkerInfo list from `{prefix}:worker:{id}:detail` snapshots.
   */
  private async listWorkersFromDetailKeys(detailKeys: string[]): Promise<WorkerInfo[]> {
    const pipeline = this.client.pipeline();
    for (const key of detailKeys) {
      pipeline.get(key);
    }
    const results = await pipeline.exec();
    if (!results) return [];

    const workers: WorkerInfo[] = [];
    for (const [err, raw] of results) {
      if (err || typeof raw !== 'string') continue;
      try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object') continue;
        const obj = parsed as Record<string, unknown>;
        if (typeof obj['workerId'] !== 'string') continue;

        const statusRaw = obj['status'];
        const status =
          typeof statusRaw === 'string' &&
          Object.values(WorkerStatus).includes(statusRaw as WorkerStatus)
            ? (statusRaw as WorkerStatus)
            : WorkerStatus.OFFLINE;

        const devicesRaw = obj['devices'];
        const devices = Array.isArray(devicesRaw) ? (devicesRaw as WorkerInfo['devices']) : [];

        const worker: WorkerInfo = {
          workerId: String(obj['workerId']),
          status,
          devices,
        };

        if (typeof obj['modelCount'] === 'number') worker.modelCount = obj['modelCount'];
        if (typeof obj['lastHeartbeatAt'] === 'string') {
          worker.lastHeartbeatAt = obj['lastHeartbeatAt'];
        }

        workers.push(worker);
      } catch {
        // Skip malformed entries
      }
    }

    return workers;
  }

  /**
   * Build WorkerInfo list from `{prefix}:workers:{id}:info` keys,
   * fetching the companion heartbeat keys to derive status.
   *
   * The info payload has `{ capabilities, devices, managementUrl? }` —
   * workerId is extracted from the key structure, not the payload.
   */
  private async listWorkersFromInfoKeys(infoKeys: string[]): Promise<WorkerInfo[]> {
    // Extract workerIds from key structure: {prefix}:workers:{workerId}:info
    const workerIds: string[] = [];
    const infoSuffix = ':info';
    const workersSegment = `${this.prefix}:workers:`;
    for (const key of infoKeys) {
      if (!key.startsWith(workersSegment) || !key.endsWith(infoSuffix)) continue;
      const workerId = key.slice(workersSegment.length, key.length - infoSuffix.length);
      if (workerId) workerIds.push(workerId);
    }

    if (workerIds.length === 0) return [];

    // Batch-fetch all info blobs and heartbeat timestamps.
    const pipeline = this.client.pipeline();
    for (const key of infoKeys) {
      pipeline.get(key);
    }
    for (const wid of workerIds) {
      pipeline.get(`${this.prefix}:workers:${wid}:heartbeat`);
    }
    const results = await pipeline.exec();
    if (!results) return [];

    const workers: WorkerInfo[] = [];
    const infoCount = infoKeys.length;

    for (let i = 0; i < workerIds.length; i++) {
      const workerId = workerIds[i];
      const [infoErr, infoRaw] = results[i];
      const [hbErr, hbRaw] = results[infoCount + i];

      if (infoErr || typeof infoRaw !== 'string') continue;

      try {
        const parsed: unknown = JSON.parse(infoRaw);
        if (parsed === null || typeof parsed !== 'object') continue;
        const obj = parsed as Record<string, unknown>;

        const devicesRaw = obj['devices'];
        const devices = Array.isArray(devicesRaw) ? (devicesRaw as WorkerInfo['devices']) : [];

        // Derive status from heartbeat age (same logic as control plane).
        const HEARTBEAT_TIMEOUT_SECS = 30;
        const lastHeartbeatAt = !hbErr && typeof hbRaw === 'string' ? hbRaw : null;
        const status = resolveHeartbeatStatus(lastHeartbeatAt, HEARTBEAT_TIMEOUT_SECS);

        const worker: WorkerInfo = {
          workerId,
          status,
          devices,
        };

        if (lastHeartbeatAt) worker.lastHeartbeatAt = lastHeartbeatAt;

        workers.push(worker);
      } catch {
        // Skip malformed entries
      }
    }

    return workers;
  }

  async getClusterStatus(): Promise<Partial<ClusterStatus>> {
    const models = await this.listModels();

    const counts = {
      total: models.length,
      active: 0,
      sleeping: 0,
      starting: 0,
      error: 0,
      other: 0,
    };

    for (const m of models) {
      switch (m.state) {
        case ModelLifecycleState.ACTIVE:
          counts.active++;
          break;
        case ModelLifecycleState.SLEEPING:
          counts.sleeping++;
          break;
        case ModelLifecycleState.STARTING:
          counts.starting++;
          break;
        case ModelLifecycleState.ERROR:
          counts.error++;
          break;
        default:
          counts.other++;
      }
    }

    const workers = await this.listWorkers();
    const workerCount = workers.length;
    const workersOnline = workers.filter((w) => w.status === WorkerStatus.ONLINE).length;

    // Sum memory across all worker devices.  The control plane's
    // worker-pool records may only carry memoryTotalBytes (no used/available
    // breakdown), so default missing fields to 0 to avoid NaN sums.
    let totalBytes = 0;
    let usedBytes = 0;
    let availableBytes = 0;

    for (const w of workers) {
      for (const d of w.devices) {
        totalBytes += d.memoryTotalBytes ?? 0;
        usedBytes += d.memoryUsedBytes ?? 0;
        availableBytes += d.memoryAvailableBytes ?? 0;
      }
    }

    return {
      workerCount,
      workersOnline,
      modelCounts: counts,
      memory: { totalBytes, usedBytes, availableBytes },
    };
  }

  /**
   * Read the per-device cluster memory snapshot written by the control plane's
   * MemoryBudgetService.refreshAll().  Returns the parsed ClusterMemory object
   * or null when no snapshot exists.
   */
  async getClusterMemory(): Promise<ClusterMemory | null> {
    const raw = await this.client.get(`${this.prefix}:cluster:memory`);
    if (raw === null) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed !== null && typeof parsed === 'object') {
        return parsed as ClusterMemory;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Read a single worker's detail record written by the control plane's
   * WorkerPoolService.checkHeartbeats().  Returns the parsed WorkerDetail
   * object or null when no record exists.
   */
  async getWorkerDetail(id: string): Promise<WorkerDetail | null> {
    const raw = await this.client.get(`${this.prefix}:worker:${id}:detail`);
    if (raw === null) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        'workerId' in parsed &&
        typeof (parsed as Record<string, unknown>)['workerId'] === 'string'
      ) {
        return parsed as WorkerDetail;
      }
      return null;
    } catch {
      return null;
    }
  }

  /** Create a dedicated Redis connection for pub/sub. */
  createSubscriber(): Redis {
    return new Redis(this.client.options);
  }

  async isHealthy(): Promise<boolean> {
    try {
      const pong = await this.client.ping();
      return pong === 'PONG';
    } catch {
      return false;
    }
  }

  get keyPrefix(): string {
    return this.prefix;
  }

  close(): void {
    this.client.disconnect();
  }
}
