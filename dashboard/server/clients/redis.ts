import { Redis } from 'ioredis';
import type { Config } from '../config.js';
import { ModelLifecycleState, WorkerStatus } from '@sardeenz/types';
import type { ControlPlaneComponents } from '@sardeenz/types';

type ModelInfo = ControlPlaneComponents['schemas']['ModelInfo'];
type WorkerInfo = ControlPlaneComponents['schemas']['WorkerInfo'];
type WorkerDetail = ControlPlaneComponents['schemas']['WorkerDetail'];
type ClusterStatus = ControlPlaneComponents['schemas']['ClusterStatus'];
type ClusterMemory = ControlPlaneComponents['schemas']['ClusterMemory'];
type ClusterMemorySummary = ControlPlaneComponents['schemas']['ClusterMemorySummary'];

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
   * Extract `{modelName, instanceId}` from a `{prefix}:models:{modelName}:{instanceId}` key
   * (#120: model state moved from one blob per model to one blob per instance). Neither
   * modelName nor instanceId can contain `:` (see `MODEL_NAME_PATTERN` / `mintInstanceId` in
   * control-plane/src/routes/models.ts), so splitting on the last `:` is unambiguous even though
   * modelName itself may contain other characters.
   */
  private parseInstanceKey(key: string): { modelName: string; instanceId: string } | null {
    const modelsPrefix = `${this.prefix}:models:`;
    if (!key.startsWith(modelsPrefix)) return null;
    const rest = key.slice(modelsPrefix.length);
    const sep = rest.lastIndexOf(':');
    if (sep < 0) return null;
    return { modelName: rest.slice(0, sep), instanceId: rest.slice(sep + 1) };
  }

  async getModelNames(): Promise<string[]> {
    const keys = await this.scanKeys(`${this.prefix}:models:*`);
    const names = new Set<string>();
    for (const key of keys) {
      const parsed = this.parseInstanceKey(key);
      if (parsed) names.add(parsed.modelName);
    }
    return [...names];
  }

  /**
   * Aggregate a logical model's state from the states of all of its instance blobs, mirroring
   * `deriveAggregateState` in control-plane/src/services/model-lifecycle.ts (ACTIVE outranks
   * ERROR — one healthy replica masks a broken one). Duplicated here rather than imported: this
   * is the dashboard BFF's degraded-mode Redis-fallback path, a separate deployable from the
   * control plane.
   */
  private static readonly AGGREGATE_PRECEDENCE: readonly ModelLifecycleState[] = [
    ModelLifecycleState.ACTIVE,
    ModelLifecycleState.STARTING,
    ModelLifecycleState.DRAINING,
    ModelLifecycleState.SLEEPING,
    ModelLifecycleState.PENDING,
    ModelLifecycleState.STOPPING,
    ModelLifecycleState.ERROR,
  ];

  private deriveAggregateState(states: ModelLifecycleState[]): ModelLifecycleState {
    // Explicit Set<ModelLifecycleState> annotation: TS's inferred-predicate narrowing would
    // otherwise type this as Set<Exclude<ModelLifecycleState, 'STOPPED'>>, which rejects the
    // full-enum-typed AGGREGATE_PRECEDENCE candidates below at .has().
    const present: Set<ModelLifecycleState> = new Set(
      states.filter((s) => s !== ModelLifecycleState.STOPPED),
    );
    for (const candidate of RedisReader.AGGREGATE_PRECEDENCE) {
      if (present.has(candidate)) return candidate;
    }
    return ModelLifecycleState.ERROR;
  }

  /**
   * Read a logical model's aggregate state from Redis by scanning all of its instance blobs.
   *
   * The control plane persists each instance's state as a JSON blob at
   * `{prefix}:models:{modelName}:{instanceId}` with the shape defined by
   * `ModelLifecycleService.InstanceState` (instanceId, modelName, state, workerId, runnerHost,
   * runnerPort, runnerId, lastInferenceAt, stateChangedAt, errorMessage). A model with zero
   * instance blobs doesn't exist in this fallback view (nothing to reconstruct from — the
   * PostgreSQL config record isn't reachable from here).
   *
   * Last-inference timestamps are stored separately at
   * `{prefix}:inference:last:{modelName}` — the blob's own `lastInferenceAt` may lag behind, so
   * we prefer the dedicated key when available.
   */
  async getModel(name: string): Promise<ModelInfo | null> {
    const keys = await this.scanKeys(`${this.prefix}:models:${name}:*`);
    if (keys.length === 0) return null;

    const pipeline = this.client.pipeline();
    for (const key of keys) {
      pipeline.get(key);
    }
    const results = await pipeline.exec();
    if (!results) return null;

    const blobs: Record<string, unknown>[] = [];
    for (const [err, raw] of results) {
      if (err || typeof raw !== 'string') continue;
      try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed !== null && typeof parsed === 'object') {
          blobs.push(parsed as Record<string, unknown>);
        }
      } catch {
        // Skip malformed entries
      }
    }
    if (blobs.length === 0) return null;

    const states = blobs.map((blob) => {
      const stateRaw = blob['state'];
      return typeof stateRaw === 'string' &&
        Object.values(ModelLifecycleState).includes(stateRaw as ModelLifecycleState)
        ? (stateRaw as ModelLifecycleState)
        : ModelLifecycleState.ERROR;
    });

    const model: ModelInfo = {
      modelName: name,
      state: this.deriveAggregateState(states),
      // The control plane blobs don't carry runnerType — it's stored in
      // PostgreSQL.  Fall back to 'unknown' for the Redis-only path.
      runnerType: 'unknown',
      instanceCount: blobs.length,
      createdAt:
        typeof blobs[0]['stateChangedAt'] === 'string'
          ? blobs[0]['stateChangedAt']
          : new Date(0).toISOString(),
    };

    // Unambiguous only with exactly one instance.
    if (blobs.length === 1 && typeof blobs[0]['workerId'] === 'string') {
      model.workerId = blobs[0]['workerId'];
    }

    // Prefer the dedicated inference timestamp key over any blob field.
    const inferenceRaw = await this.client.get(`${this.prefix}:inference:last:${name}`);
    const lastInferenceAt =
      inferenceRaw ??
      blobs
        .map((b) => (typeof b['lastInferenceAt'] === 'string' ? b['lastInferenceAt'] : null))
        .find((v): v is string => v !== null) ??
      null;
    if (lastInferenceAt) model.lastInferenceAt = lastInferenceAt;

    return model;
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
    let reservedBytes = 0;
    let measuredUsedBytes = 0;
    let anyMeasured = false;

    for (const w of workers) {
      for (const d of w.devices) {
        totalBytes += d.memoryTotalBytes ?? 0;
        usedBytes += d.memoryUsedBytes ?? 0;
        availableBytes += d.memoryAvailableBytes ?? 0;
        reservedBytes += d.memoryReservedBytes ?? 0;
        if (d.memoryMeasuredUsedBytes != null) {
          anyMeasured = true;
          measuredUsedBytes += d.memoryMeasuredUsedBytes;
        }
      }
    }

    const memory: ClusterMemorySummary = { totalBytes, usedBytes, availableBytes, reservedBytes };
    if (anyMeasured) memory.measuredUsedBytes = measuredUsedBytes;

    return {
      workerCount,
      workersOnline,
      modelCounts: counts,
      memory,
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
