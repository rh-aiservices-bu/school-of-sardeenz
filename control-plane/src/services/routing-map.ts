import { ModelState, Protocol, RoutingMapUpdateType } from '@sardeenz/types';
import type { Redis } from '../clients/redis.js';
import { redisKey } from '../clients/redis.js';
import { ControlPlaneError } from '../errors.js';

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
    const entry = await this.getEntry(modelName);
    const now = new Date().toISOString();

    const updated: RoutingEntry = entry
      ? { ...entry, state, ...(protocol ? { protocol } : {}), updatedAt: now }
      : { modelName, state, protocol: protocol ?? Protocol.openai, endpoints: [], updatedAt: now };

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
}
