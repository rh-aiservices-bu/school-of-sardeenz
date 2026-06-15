import { Redis } from 'ioredis';
import type { Config } from '../config.js';
import { ModelLifecycleState, WorkerStatus } from '@sardeenz/types';
import type { ControlPlaneComponents } from '@sardeenz/types';

type ModelInfo = ControlPlaneComponents['schemas']['ModelInfo'];
type WorkerInfo = ControlPlaneComponents['schemas']['WorkerInfo'];
type WorkerDetail = ControlPlaneComponents['schemas']['WorkerDetail'];
type ClusterStatus = ControlPlaneComponents['schemas']['ClusterStatus'];
type ClusterMemory = ControlPlaneComponents['schemas']['ClusterMemory'];

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

  /** Extract model name from a `{prefix}:models:state:{modelName}` key. */
  private modelNameFromKey(key: string): string {
    const statePrefix = `${this.prefix}:models:state:`;
    return key.slice(statePrefix.length);
  }

  async getModelNames(): Promise<string[]> {
    const keys = await this.scanKeys(`${this.prefix}:models:state:*`);
    return keys.map((k) => this.modelNameFromKey(k));
  }

  async getModel(name: string): Promise<ModelInfo | null> {
    const stateRaw = await this.client.get(`${this.prefix}:models:state:${name}`);
    if (stateRaw === null) {
      return null;
    }

    const [workerId, memoryRaw, requiredMemoryRaw, runnerType, pinnedRaw, createdAt, lastInferenceAt] =
      await Promise.all([
        this.client.get(`${this.prefix}:models:worker:${name}`),
        this.client.get(`${this.prefix}:models:memory:${name}`),
        this.client.get(`${this.prefix}:models:required-memory:${name}`),
        this.client.get(`${this.prefix}:models:runner-type:${name}`),
        this.client.get(`${this.prefix}:models:pinned:${name}`),
        this.client.get(`${this.prefix}:models:created-at:${name}`),
        this.client.get(`${this.prefix}:inference:last:${name}`),
      ]);

    const state = Object.values(ModelLifecycleState).includes(stateRaw as ModelLifecycleState)
      ? (stateRaw as ModelLifecycleState)
      : ModelLifecycleState.ERROR;

    const model: ModelInfo = {
      modelName: name,
      state,
      runnerType: runnerType ?? 'unknown',
      createdAt: createdAt ?? new Date(0).toISOString(),
    };

    if (workerId) model.workerId = workerId;
    if (memoryRaw !== null) model.currentMemory = parseInt(memoryRaw, 10);
    if (requiredMemoryRaw !== null) model.requiredMemory = parseInt(requiredMemoryRaw, 10);
    if (pinnedRaw !== null) model.pinned = pinnedRaw === 'true';
    if (lastInferenceAt) model.lastInferenceAt = lastInferenceAt;

    return model;
  }

  async listModels(): Promise<ModelInfo[]> {
    const names = await this.getModelNames();
    if (names.length === 0) return [];

    const models = await Promise.all(names.map((n) => this.getModel(n)));
    return models.filter((m): m is ModelInfo => m !== null);
  }

  async listWorkers(): Promise<WorkerInfo[]> {
    const keys = await this.scanKeys(`${this.prefix}:workers:*`);
    const workers: WorkerInfo[] = [];

    for (const key of keys) {
      const raw = await this.client.get(key);
      if (raw === null) continue;
      try {
        const parsed: unknown = JSON.parse(raw);
        if (
          parsed !== null &&
          typeof parsed === 'object' &&
          'workerId' in parsed &&
          typeof (parsed as Record<string, unknown>)['workerId'] === 'string'
        ) {
          const obj = parsed as Record<string, unknown>;
          const statusRaw = obj['status'];
          const status =
            typeof statusRaw === 'string' &&
            Object.values(WorkerStatus).includes(statusRaw as WorkerStatus)
              ? (statusRaw as WorkerStatus)
              : WorkerStatus.OFFLINE;

          const devicesRaw = obj['devices'];
          const devices = Array.isArray(devicesRaw)
            ? (devicesRaw as WorkerInfo['devices'])
            : [];

          const worker: WorkerInfo = {
            workerId: obj['workerId'] as string,
            status,
            devices,
          };

          if (typeof obj['modelCount'] === 'number') worker.modelCount = obj['modelCount'];
          if (typeof obj['lastHeartbeatAt'] === 'string') {
            worker.lastHeartbeatAt = obj['lastHeartbeatAt'];
          }

          workers.push(worker);
        }
      } catch {
        // Skip malformed worker entries
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

    // Sum memory across all worker devices
    let totalBytes = 0;
    let usedBytes = 0;
    let availableBytes = 0;

    for (const w of workers) {
      for (const d of w.devices) {
        totalBytes += d.memoryTotalBytes;
        usedBytes += d.memoryUsedBytes;
        availableBytes += d.memoryAvailableBytes;
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
