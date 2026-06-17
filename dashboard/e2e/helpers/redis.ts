/**
 * Redis test helper for E2E tests.
 *
 * Connects to the compose-managed Redis (Valkey) at redis://127.0.0.1:6379
 * and provides helpers to seed state and publish events through the same
 * key patterns and channels the BFF reads from.
 *
 * Each test gets a unique key prefix to prevent cross-test contamination.
 */

import { Redis } from 'ioredis';

const REDIS_URL = 'redis://127.0.0.1:6379';

// ---------------------------------------------------------------------------
// Seed data shapes (match what the control plane writes to Redis)
// ---------------------------------------------------------------------------

export interface SeedModelState {
  modelName: string;
  state: string;
  workerId?: string;
  runnerType?: string;
  stateChangedAt?: string;
  lastInferenceAt?: string;
  errorMessage?: string;
}

export interface SeedDeviceInfo {
  deviceIndex: number;
  deviceType: string;
  memoryTotalBytes: number;
  memoryUsedBytes: number;
  memoryAvailableBytes: number;
  memoryReservedBytes?: number;
}

export interface SeedWorkerDetail {
  workerId: string;
  status: string;
  devices: SeedDeviceInfo[];
  capabilities?: unknown;
  lastHeartbeatAt?: string;
  joinedAt?: string;
  managementUrl?: string;
  modelCount?: number;
}

export interface SeedClusterMemory {
  workers: Array<{
    workerId: string;
    devices: SeedDeviceInfo[];
    models?: Array<{
      modelName: string;
      state: string;
      memoryUsedBytes?: number;
      deviceIndices?: number[];
    }>;
  }>;
}

export interface SeedClusterEvent {
  type: string;
  timestamp: string;
  modelName?: string;
  workerId?: string;
  state?: string;
  previousState?: string;
  message?: string;
  data?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// RedisTestHelper
// ---------------------------------------------------------------------------

export class RedisTestHelper {
  private client: Redis;
  private readonly prefix: string;

  constructor(prefix: string) {
    this.prefix = prefix;
    this.client = new Redis(REDIS_URL, {
      maxRetriesPerRequest: 3,
      retryStrategy: (times: number) => Math.min(times * 200, 2000),
      lazyConnect: true,
    });
  }

  async connect(): Promise<void> {
    await this.client.connect();
  }

  get keyPrefix(): string {
    return this.prefix;
  }

  /**
   * Seed a model state blob at `{prefix}:models:{modelName}`.
   * Matches the shape written by the CP's ModelLifecycleService.
   */
  async seedModel(model: SeedModelState): Promise<void> {
    const blob = {
      modelName: model.modelName,
      state: model.state,
      workerId: model.workerId ?? null,
      runnerType: model.runnerType ?? 'vllm',
      stateChangedAt: model.stateChangedAt ?? new Date().toISOString(),
      lastInferenceAt: model.lastInferenceAt ?? null,
      errorMessage: model.errorMessage ?? null,
    };
    await this.client.set(`${this.prefix}:models:${model.modelName}`, JSON.stringify(blob));
  }

  /**
   * Seed a worker detail snapshot at `{prefix}:worker:{workerId}:detail`.
   * This is the strategy-1 key that RedisReader.listWorkers() prefers.
   */
  async seedWorkerDetail(detail: SeedWorkerDetail): Promise<void> {
    const blob = {
      workerId: detail.workerId,
      status: detail.status,
      devices: detail.devices,
      capabilities: detail.capabilities ?? {},
      lastHeartbeatAt: detail.lastHeartbeatAt ?? new Date().toISOString(),
      joinedAt: detail.joinedAt ?? new Date().toISOString(),
      managementUrl: detail.managementUrl,
      modelCount: detail.modelCount ?? 0,
    };
    await this.client.set(`${this.prefix}:worker:${detail.workerId}:detail`, JSON.stringify(blob));
  }

  /**
   * Seed the cluster memory snapshot at `{prefix}:cluster:memory`.
   * Matches the shape written by the CP's MemoryBudgetService.
   */
  async seedClusterMemory(memory: SeedClusterMemory): Promise<void> {
    await this.client.set(`${this.prefix}:cluster:memory`, JSON.stringify(memory));
  }

  /**
   * Publish a ClusterEvent to the `{prefix}:cluster-events` channel.
   * The BFF SSE route subscribes to this channel and streams events
   * to the frontend.
   */
  async publishClusterEvent(event: SeedClusterEvent): Promise<void> {
    await this.client.publish(`${this.prefix}:cluster-events`, JSON.stringify(event));
  }

  /**
   * Delete all keys matching `{prefix}:*`.
   */
  async flushTestKeys(): Promise<void> {
    let cursor = '0';
    do {
      const [nextCursor, keys] = await this.client.scan(
        cursor,
        'MATCH',
        `${this.prefix}:*`,
        'COUNT',
        100,
      );
      cursor = nextCursor;
      if (keys.length > 0) await this.client.del(...keys);
    } while (cursor !== '0');
  }

  async close(): Promise<void> {
    await this.flushTestKeys();
    this.client.disconnect();
  }
}

/**
 * Generate a unique key prefix for a test run.
 * Uses timestamp + random suffix to prevent collisions.
 */
export function generateTestPrefix(): string {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  return `e2e-${ts}-${rand}`;
}
