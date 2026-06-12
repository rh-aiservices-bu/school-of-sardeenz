import { ModelState, RoutingMapUpdateType } from '@sardeenz/types';
import type { Redis } from '../clients/redis.js';
import { redisKey } from '../clients/redis.js';

export interface RunnerEndpoint {
  host: string;
  port: number;
  weight: number;
  healthy: boolean;
  runnerId?: string;
}

export interface RoutingEntry {
  modelName: string;
  state: ModelState;
  endpoints: RunnerEndpoint[];
  updatedAt: string;
  metadata?: { ownedBy?: string; maxModelLen?: number; engineType?: string };
}

export interface RoutingMapUpdate {
  type: RoutingMapUpdateType;
  modelName: string;
  state?: ModelState;
  endpoint?: RunnerEndpoint;
  timestamp: string;
}

const ROUTING_MAP_FIELD = 'routing-map';
const ROUTING_UPDATES_CHANNEL = 'routing-updates';

export class RoutingMapService {
  private readonly hashKey: string;
  private readonly pubsubChannel: string;

  constructor(
    private readonly redis: Redis,
    private readonly keyPrefix: string,
  ) {
    this.hashKey = redisKey(keyPrefix, ROUTING_MAP_FIELD);
    this.pubsubChannel = redisKey(keyPrefix, ROUTING_UPDATES_CHANNEL);
  }

  async getRoutingMap(): Promise<Record<string, RoutingEntry>> {
    const raw = await this.redis.hgetall(this.hashKey);
    const result: Record<string, RoutingEntry> = {};
    for (const [modelName, json] of Object.entries(raw)) {
      result[modelName] = JSON.parse(json) as RoutingEntry;
    }
    return result;
  }

  async getEntry(modelName: string): Promise<RoutingEntry | null> {
    const raw = await this.redis.hget(this.hashKey, modelName);
    if (!raw) return null;
    return JSON.parse(raw) as RoutingEntry;
  }

  async setModelState(modelName: string, state: ModelState): Promise<void> {
    const entry = await this.getEntry(modelName);
    const now = new Date().toISOString();

    const updated: RoutingEntry = entry
      ? { ...entry, state, updatedAt: now }
      : { modelName, state, endpoints: [], updatedAt: now };

    const update: RoutingMapUpdate = {
      type: entry ? RoutingMapUpdateType.MODEL_STATE_CHANGED : RoutingMapUpdateType.MODEL_ADDED,
      modelName,
      state,
      timestamp: now,
    };

    await this.redis
      .multi()
      .hset(this.hashKey, modelName, JSON.stringify(updated))
      .publish(this.pubsubChannel, JSON.stringify(update))
      .exec();
  }

  async removeModel(modelName: string): Promise<void> {
    const now = new Date().toISOString();
    const update: RoutingMapUpdate = {
      type: RoutingMapUpdateType.MODEL_REMOVED,
      modelName,
      timestamp: now,
    };

    await this.redis
      .multi()
      .hdel(this.hashKey, modelName)
      .publish(this.pubsubChannel, JSON.stringify(update))
      .exec();
  }

  async addEndpoint(modelName: string, endpoint: RunnerEndpoint): Promise<void> {
    const entry = await this.getEntry(modelName);
    const now = new Date().toISOString();

    const baseEntry: RoutingEntry = entry ?? {
      modelName,
      state: ModelState.STARTING,
      endpoints: [],
      updatedAt: now,
    };

    const endpoints = baseEntry.endpoints.filter(
      (e) => !(e.host === endpoint.host && e.port === endpoint.port),
    );
    endpoints.push(endpoint);

    const updated: RoutingEntry = { ...baseEntry, endpoints, updatedAt: now };
    const update: RoutingMapUpdate = {
      type: RoutingMapUpdateType.ENDPOINT_ADDED,
      modelName,
      endpoint,
      timestamp: now,
    };

    await this.redis
      .multi()
      .hset(this.hashKey, modelName, JSON.stringify(updated))
      .publish(this.pubsubChannel, JSON.stringify(update))
      .exec();
  }

  async removeEndpoint(modelName: string, host: string, port: number): Promise<void> {
    const entry = await this.getEntry(modelName);
    if (!entry) return;

    const now = new Date().toISOString();
    const removed = entry.endpoints.find((e) => e.host === host && e.port === port);
    const endpoints = entry.endpoints.filter((e) => !(e.host === host && e.port === port));
    const updated: RoutingEntry = { ...entry, endpoints, updatedAt: now };

    const update: RoutingMapUpdate = {
      type: RoutingMapUpdateType.ENDPOINT_REMOVED,
      modelName,
      ...(removed ? { endpoint: removed } : {}),
      timestamp: now,
    };

    await this.redis
      .multi()
      .hset(this.hashKey, modelName, JSON.stringify(updated))
      .publish(this.pubsubChannel, JSON.stringify(update))
      .exec();
  }

  async updateEndpointHealth(modelName: string, host: string, port: number, healthy: boolean): Promise<void> {
    const entry = await this.getEntry(modelName);
    if (!entry) return;

    const now = new Date().toISOString();
    let changed: RunnerEndpoint | undefined;

    const endpoints = entry.endpoints.map((e) => {
      if (e.host === host && e.port === port) {
        changed = { ...e, healthy };
        return changed;
      }
      return e;
    });

    if (!changed) return;

    const updated: RoutingEntry = { ...entry, endpoints, updatedAt: now };
    const update: RoutingMapUpdate = {
      type: RoutingMapUpdateType.ENDPOINT_UPDATED,
      modelName,
      endpoint: changed,
      timestamp: now,
    };

    await this.redis
      .multi()
      .hset(this.hashKey, modelName, JSON.stringify(updated))
      .publish(this.pubsubChannel, JSON.stringify(update))
      .exec();
  }
}
