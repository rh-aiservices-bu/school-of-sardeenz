import { ModelState, Protocol, RoutingMapUpdateType } from '@sardeenz/types';
import { randomUUID } from 'node:crypto';
import type { Redis } from '../clients/redis.js';
import { redisKey } from '../clients/redis.js';
import { ControlPlaneError } from '../errors.js';
import { delaySafe } from '../utils.js';

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
  protocol: Protocol;
  endpoints: RunnerEndpoint[];
  updatedAt: string;
  metadata?: { ownedBy?: string; maxModelLen?: number };
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
const ROUTING_BARRIERS_CHANNEL = 'routing-barriers';
const ROUTING_BARRIER_ACKS = 'routing-barrier-acks';
const PROXY_PRESENCE_PREFIX = 'proxies';
const ROUTING_BARRIER_TIMEOUT_MS = 30_000;

// Shared Lua: encode a RoutingEntry with `endpoints` ALWAYS a JSON array. cjson.encode
// serializes an empty Lua table as `{}`, but the proxy consumer types endpoints as an array
// (RoutingEntry.endpoints: Vec<RunnerEndpoint>, proxy/src/generated/proxy_control_plane.rs:50),
// so `{}` breaks deserialization and the model silently vanishes from the routing map (#79).
// We encode the array separately and splice it in — never string.gsub the encoded body, since
// model names are attacker-influenced and could collide with a replacement pattern.
const LUA_ENCODE_ROUTING_ENTRY = `
  local function encode_routing_entry(entry)
    local eps = entry.endpoints
    local encoded_eps
    if type(eps) ~= 'table' or #eps == 0 then
      encoded_eps = '[]'
    else
      encoded_eps = cjson.encode(eps)
    end
    entry.endpoints = nil
    local body = cjson.encode(entry)
    if body == '{}' then
      return '{"endpoints":' .. encoded_eps .. '}'
    end
    return string.sub(body, 1, -2) .. ',"endpoints":' .. encoded_eps .. '}'
  end
`;

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

  async setModelState(modelName: string, state: ModelState, protocol?: Protocol): Promise<void> {
    const now = new Date().toISOString();
    // Do not HGET/HSET in JavaScript here. A state refresh can race the move cutover Lua
    // mutation and otherwise write a stale endpoints array back over its weight=0 result.
    const luaScript = `
      ${LUA_ENCODE_ROUTING_ENTRY}
      local raw = redis.call('HGET', KEYS[1], ARGV[1])
      local entry
      local existed = raw ~= false and raw ~= nil
      if existed then
        entry = cjson.decode(raw)
      else
        entry = { modelName = ARGV[1], protocol = ARGV[3], endpoints = {} }
      end
      entry.state = ARGV[2]
      if ARGV[3] ~= '' then entry.protocol = ARGV[3] end
      entry.updatedAt = ARGV[4]
      redis.call('HSET', KEYS[1], ARGV[1], encode_routing_entry(entry))
      local updateType = existed and 'MODEL_STATE_CHANGED' or 'MODEL_ADDED'
      redis.call('PUBLISH', KEYS[2], cjson.encode({
        type = updateType, modelName = ARGV[1], state = ARGV[2], timestamp = ARGV[4]
      }))
      return existed and 1 or 0
    `;
    await this.redis.eval(
      luaScript,
      2,
      this.hashKey,
      this.pubsubChannel,
      modelName,
      state,
      // A newly-created routing entry must never carry an empty protocol. Existing entries keep
      // their persisted protocol when callers omit it; new entries use the legacy OpenAI default.
      protocol ?? Protocol.openai,
      now,
    );
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

  async addEndpoint(
    modelName: string,
    endpoint: RunnerEndpoint,
    protocol?: Protocol,
  ): Promise<void> {
    const now = new Date().toISOString();

    const luaScript = `
      ${LUA_ENCODE_ROUTING_ENTRY}
      local raw = redis.call('HGET', KEYS[1], ARGV[1])
      local entry
      if raw then
        entry = cjson.decode(raw)
      else
        entry = { modelName = ARGV[1], state = 'STARTING', protocol = ARGV[5], endpoints = {}, updatedAt = ARGV[3] }
      end
      local ep = cjson.decode(ARGV[2])
      local filtered = {}
      for _, e in ipairs(entry.endpoints) do
        if not (e.host == ep.host and e.port == ep.port) then
          filtered[#filtered + 1] = e
        end
      end
      filtered[#filtered + 1] = ep
      entry.endpoints = filtered
      entry.protocol = ARGV[5]
      entry.updatedAt = ARGV[3]
      redis.call('HSET', KEYS[1], ARGV[1], encode_routing_entry(entry))
      redis.call('PUBLISH', KEYS[2], ARGV[4])
      return 1
    `;

    const update: RoutingMapUpdate = {
      type: RoutingMapUpdateType.ENDPOINT_ADDED,
      modelName,
      endpoint,
      timestamp: now,
    };

    await this.redis.eval(
      luaScript,
      2,
      this.hashKey,
      this.pubsubChannel,
      modelName,
      JSON.stringify(endpoint),
      now,
      JSON.stringify(update),
      protocol ?? 'openai',
    );
  }

  async removeEndpoint(modelName: string, host: string, port: number): Promise<void> {
    const now = new Date().toISOString();

    const luaScript = `
      ${LUA_ENCODE_ROUTING_ENTRY}
      local raw = redis.call('HGET', KEYS[1], ARGV[1])
      if not raw then return nil end
      local entry = cjson.decode(raw)
      local filtered = {}
      local removed = nil
      for _, e in ipairs(entry.endpoints) do
        if e.host == ARGV[2] and e.port == tonumber(ARGV[3]) then
          removed = e
        else
          filtered[#filtered + 1] = e
        end
      end
      entry.endpoints = filtered
      entry.updatedAt = ARGV[4]
      redis.call('HSET', KEYS[1], ARGV[1], encode_routing_entry(entry))
      redis.call('PUBLISH', KEYS[2], ARGV[5])
      return 1
    `;

    const update: RoutingMapUpdate = {
      type: RoutingMapUpdateType.ENDPOINT_REMOVED,
      modelName,
      timestamp: now,
    };

    await this.redis.eval(
      luaScript,
      2,
      this.hashKey,
      this.pubsubChannel,
      modelName,
      host,
      port.toString(),
      now,
      JSON.stringify(update),
    );
  }

  async updateEndpointHealth(
    modelName: string,
    host: string,
    port: number,
    healthy: boolean,
  ): Promise<void> {
    const now = new Date().toISOString();

    const luaScript = `
      ${LUA_ENCODE_ROUTING_ENTRY}
      local raw = redis.call('HGET', KEYS[1], ARGV[1])
      if not raw then return nil end
      local entry = cjson.decode(raw)
      local changed = nil
      for i, e in ipairs(entry.endpoints) do
        if e.host == ARGV[2] and e.port == tonumber(ARGV[3]) then
          e.healthy = ARGV[4] == 'true'
          entry.endpoints[i] = e
          changed = e
          break
        end
      end
      if not changed then return nil end
      entry.updatedAt = ARGV[5]
      redis.call('HSET', KEYS[1], ARGV[1], encode_routing_entry(entry))
      redis.call('PUBLISH', KEYS[2], ARGV[6])
      return 1
    `;

    const update: RoutingMapUpdate = {
      type: RoutingMapUpdateType.ENDPOINT_UPDATED,
      modelName,
      timestamp: now,
    };

    await this.redis.eval(
      luaScript,
      2,
      this.hashKey,
      this.pubsubChannel,
      modelName,
      host,
      port.toString(),
      healthy.toString(),
      now,
      JSON.stringify(update),
    );
  }

  /**
   * Set the traffic weight on a single endpoint of a model's routing entry, without changing
   * its healthy flag. Internal primitive for #120's scripted move (deploy new instance → set
   * the old instance's endpoint weight to 0 to shift traffic → drain → remove) — no HTTP route
   * in M7; the move-model UI (#124) is M8. Mirrors updateEndpointHealth's shape and Lua pattern.
   * No-ops (does not throw) when the routing entry or the specific endpoint is absent, matching
   * updateEndpointHealth's behavior for the same reason: a caller racing a concurrent
   * removeEndpoint shouldn't fail.
   */
  async updateEndpointWeight(
    modelName: string,
    host: string,
    port: number,
    weight: number,
  ): Promise<boolean> {
    if (!Number.isInteger(weight) || weight < 0 || weight > 100) {
      throw ControlPlaneError.invalidRequest('weight must be an integer between 0 and 100');
    }

    const now = new Date().toISOString();

    const luaScript = `
      ${LUA_ENCODE_ROUTING_ENTRY}
      local raw = redis.call('HGET', KEYS[1], ARGV[1])
      if not raw then return nil end
      local entry = cjson.decode(raw)
      local changed = nil
      for i, e in ipairs(entry.endpoints) do
        if e.host == ARGV[2] and e.port == tonumber(ARGV[3]) then
          e.weight = tonumber(ARGV[4])
          entry.endpoints[i] = e
          changed = e
          break
        end
      end
      if not changed then return nil end
      entry.updatedAt = ARGV[5]
      redis.call('HSET', KEYS[1], ARGV[1], encode_routing_entry(entry))
      redis.call('PUBLISH', KEYS[2], ARGV[6])
      return 1
    `;

    const update: RoutingMapUpdate = {
      type: RoutingMapUpdateType.ENDPOINT_UPDATED,
      modelName,
      timestamp: now,
    };

    const updated = await this.redis.eval(
      luaScript,
      2,
      this.hashKey,
      this.pubsubChannel,
      modelName,
      host,
      port.toString(),
      weight.toString(),
      now,
      JSON.stringify(update),
    );
    return updated === 1 || updated === '1';
  }

  /**
   * Remove an endpoint from selection and wait until every traffic-serving proxy has both applied
   * the new map and quiesced requests admitted through the previous entry. TTL'd presence keys
   * keep a just-disconnected process in the barrier until it stops admitting traffic and its lease
   * expires. A timeout is deliberately not rolled back: the caller retains both source and
   * replacement and reconciliation can publish a fresh barrier.
   */
  async cutoverEndpointAndWait(modelName: string, host: string, port: number): Promise<boolean> {
    const cutoverStartedMs = Date.now();
    const now = new Date().toISOString();
    const barrierId = randomUUID();
    const ackKey = redisKey(this.keyPrefix, ROUTING_BARRIER_ACKS, barrierId);
    const barrierChannel = redisKey(this.keyPrefix, ROUTING_BARRIERS_CHANNEL);
    const update: RoutingMapUpdate = {
      type: RoutingMapUpdateType.ENDPOINT_UPDATED,
      modelName,
      timestamp: now,
    };
    const barrier = { barrierId, modelName, timestamp: now };
    const luaScript = `
      ${LUA_ENCODE_ROUTING_ENTRY}
      local raw = redis.call('HGET', KEYS[1], ARGV[1])
      if not raw then return {0, 0} end
      local entry = cjson.decode(raw)
      local changed = nil
      for i, e in ipairs(entry.endpoints) do
        if e.host == ARGV[2] and e.port == tonumber(ARGV[3]) then
          e.weight = 0
          entry.endpoints[i] = e
          changed = e
          break
        end
      end
      if not changed then return {0, 0} end
      entry.updatedAt = ARGV[4]
      redis.call('HSET', KEYS[1], ARGV[1], encode_routing_entry(entry))
      redis.call('PUBLISH', KEYS[2], ARGV[5])
      local subscribers = redis.call('PUBLISH', KEYS[3], ARGV[6])
      return {1, subscribers}
    `;
    const result = (await this.redis.eval(
      luaScript,
      3,
      this.hashKey,
      this.pubsubChannel,
      barrierChannel,
      modelName,
      host,
      port.toString(),
      now,
      JSON.stringify(update),
      JSON.stringify(barrier),
    )) as [number | string, number | string] | null;

    const updated = result?.[0] === 1 || result?.[0] === '1';
    if (!updated) return false;
    // Snapshot every proxy that had declared itself ready before this cutover. A proxy that
    // reconnects afterward loads weight=0 before becoming ready and never selected the old route,
    // so it does not need to acknowledge this generation. A disconnected proxy remains in this
    // snapshot until its short presence TTL expires.
    const presencePattern = redisKey(this.keyPrefix, PROXY_PRESENCE_PREFIX, '*');
    const requiredProxies = new Map<string, string>();
    let cursor = '0';
    do {
      const [nextCursor, keys] = await this.redis.scan(
        cursor,
        'MATCH',
        presencePattern,
        'COUNT',
        100,
      );
      cursor = nextCursor;
      for (const key of keys) {
        const connectedAt = Number(await this.redis.get(key));
        if (Number.isFinite(connectedAt) && connectedAt <= cutoverStartedMs) {
          requiredProxies.set(key.slice(key.lastIndexOf(':') + 1), key);
        }
      }
    } while (cursor !== '0');

    if (requiredProxies.size === 0) {
      // No proxy was serving the old generation. The barrier is vacuously quiescent (a proxy
      // that is still bootstrapping cannot admit inference until after loading this new map).
      return true;
    }

    const signal = AbortSignal.timeout(ROUTING_BARRIER_TIMEOUT_MS);
    try {
      while (!signal.aborted) {
        const acknowledged = new Set(await this.redis.smembers(ackKey));
        let outstanding = 0;
        for (const [proxyId, presenceKey] of requiredProxies) {
          if (acknowledged.has(proxyId)) continue;
          const connectedAt = Number(await this.redis.get(presenceKey));
          // Missing means its TTL elapsed; a newer timestamp means this process reconnected and
          // loaded the current weight-zero map before becoming ready.
          if (Number.isFinite(connectedAt) && connectedAt <= cutoverStartedMs) outstanding += 1;
        }
        if (outstanding === 0) return true;
        await delaySafe(50, signal);
      }
      throw new Error(
        `traffic cutover barrier timed out (${requiredProxies.size} serving proxy acknowledgement(s) required)`,
      );
    } finally {
      // A proxy also TTLs the set when acknowledging. Keep that backstop for a lost DEL reply,
      // but clean successful and timed-out barriers eagerly in the common case.
      await this.redis.del(ackKey).catch(() => {});
    }
  }
}
