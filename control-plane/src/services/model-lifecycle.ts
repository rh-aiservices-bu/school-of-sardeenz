import { ModelLifecycleState } from '@sardeenz/types';
import type { Redis } from '../clients/redis.js';
import { redisKey } from '../clients/redis.js';
import { ControlPlaneError } from '../errors.js';
import { stateTransitionsTotal } from '../health/metrics.js';

const VALID_TRANSITIONS: ReadonlyMap<ModelLifecycleState, readonly ModelLifecycleState[]> = new Map(
  [
    [ModelLifecycleState.PENDING, [ModelLifecycleState.STARTING, ModelLifecycleState.ERROR]],
    [ModelLifecycleState.STARTING, [ModelLifecycleState.ACTIVE, ModelLifecycleState.ERROR]],
    [ModelLifecycleState.ACTIVE, [ModelLifecycleState.DRAINING, ModelLifecycleState.ERROR]],
    [
      ModelLifecycleState.DRAINING,
      [ModelLifecycleState.SLEEPING, ModelLifecycleState.STOPPING, ModelLifecycleState.ERROR],
    ],
    [
      ModelLifecycleState.SLEEPING,
      [ModelLifecycleState.STARTING, ModelLifecycleState.STOPPING, ModelLifecycleState.ERROR],
    ],
    [ModelLifecycleState.STOPPING, [ModelLifecycleState.STOPPED, ModelLifecycleState.ERROR]],
    // STOPPED has no outgoing edges on purpose. Under the registry model (#121), a "stopped"
    // model is represented by the *absence* of any Redis lifecycle record for it, not by a
    // persisted STOPPED record: deleting an instance (or the last instance of a stop) removes
    // its Redis key entirely. The read routes synthesize the STOPPED aggregate for a model with
    // zero instances. A STOPPED → STARTING edge would therefore never be exercised on a
    // persisted record — do not add one.
    [ModelLifecycleState.STOPPED, []],
    [ModelLifecycleState.ERROR, [ModelLifecycleState.STOPPED, ModelLifecycleState.STARTING]],
  ],
);

// Aggregate state derivation precedence (#120 / ADR-019): a model can have N instances, each
// with its own lifecycle state. The logical model's state is derived on read as the
// highest-precedence state present across its instances. ACTIVE outranks ERROR deliberately —
// one healthy replica must mask a broken one (M7 acceptance criterion 4).
const AGGREGATE_STATE_PRECEDENCE: readonly ModelLifecycleState[] = [
  ModelLifecycleState.ACTIVE,
  ModelLifecycleState.STARTING,
  ModelLifecycleState.DRAINING,
  ModelLifecycleState.SLEEPING,
  ModelLifecycleState.PENDING,
  ModelLifecycleState.STOPPING,
  ModelLifecycleState.ERROR,
];

/**
 * Derive a logical model's aggregate state from the states of all of its instances.
 *
 * STOPPED instances are excluded before ranking: a STOPPED Redis record is a transient
 * artifact between an instance finishing its stop sequence and the caller deleting its key
 * (see the STOPPED comment on VALID_TRANSITIONS above) — it must not count as a "present" state
 * any more than an already-deleted instance would, or a model whose only instance just stopped
 * would incorrectly fall through every precedence bucket.
 */
export function deriveAggregateState(instances: readonly { state: ModelLifecycleState }[]) {
  const relevant = instances.filter((i) => i.state !== ModelLifecycleState.STOPPED);
  if (relevant.length === 0) return ModelLifecycleState.STOPPED;
  const present = new Set(relevant.map((i) => i.state));
  for (const candidate of AGGREGATE_STATE_PRECEDENCE) {
    if (present.has(candidate)) return candidate;
  }
  // Unreachable given AGGREGATE_STATE_PRECEDENCE covers every non-STOPPED ModelLifecycleState
  // value, but fall back safely rather than returning undefined.
  return ModelLifecycleState.ERROR;
}

export interface InstanceState {
  instanceId: string;
  modelName: string;
  state: ModelLifecycleState;
  workerId: string | null;
  runnerHost: string | null;
  /** Management port (runner-contract API) — used for health/sleep/wake/stop. */
  runnerPort: number | null;
  /**
   * Inference port (`/v1/*`) the proxy targets. May differ from the management port (e.g. vLLM
   * serves its OpenAI API on a separate port). Optional: pre-existing persisted state and runners
   * that serve inference on the management port won't carry it — callers fall back to runnerPort.
   */
  runnerEnginePort?: number | null;
  runnerId: string | null;
  deviceIndices: number[] | null;
  lastInferenceAt: string | null;
  stateChangedAt: string;
  errorMessage: string | null;
}

export function isValidTransition(from: ModelLifecycleState, to: ModelLifecycleState): boolean {
  const allowed = VALID_TRANSITIONS.get(from);
  return allowed !== undefined && allowed.includes(to);
}

export function isTerminalState(state: ModelLifecycleState): boolean {
  return state === ModelLifecycleState.STOPPED;
}

const MODEL_STATE_PREFIX = 'models';

function instanceStateKey(prefix: string, modelName: string, instanceId: string): string {
  return redisKey(prefix, MODEL_STATE_PREFIX, modelName, instanceId);
}

export class ModelLifecycleService {
  constructor(
    private readonly redis: Redis,
    private readonly keyPrefix: string,
  ) {}

  async getInstance(modelName: string, instanceId: string): Promise<InstanceState | null> {
    const raw = await this.redis.get(instanceStateKey(this.keyPrefix, modelName, instanceId));
    if (!raw) return null;
    return JSON.parse(raw) as InstanceState;
  }

  /** All instances of a single model. */
  async getInstancesForModel(modelName: string): Promise<InstanceState[]> {
    const pattern = redisKey(this.keyPrefix, MODEL_STATE_PREFIX, modelName, '*');
    return this.getStatesForPattern(pattern);
  }

  /**
   * Every instance of every model. Anchored to two `:`-delimited segments
   * (`models:{modelName}:{instanceId}`) rather than a bare `models:*` — a single `*` also matches
   * the pre-#120 single-segment key shape `models:{modelName}` (glob `*` matches `:` too), which
   * would surface a stale in-place-upgrade orphan as a phantom instance with `instanceId ===
   * undefined`. Two segments structurally rejects those; see `pruneLegacyInstanceKeys` and
   * ADR-019.
   */
  async getAllInstances(): Promise<InstanceState[]> {
    const pattern = redisKey(this.keyPrefix, MODEL_STATE_PREFIX, '*', '*');
    return this.getStatesForPattern(pattern);
  }

  /**
   * One-time self-heal for a control plane upgraded in place over pre-#120 Redis state: the old
   * lifecycle key shape was `{prefix}:models:{modelName}` (no instance segment). `getAllInstances`
   * now requires a second `:`-delimited segment, so these orphans are invisible to every read
   * path — this broad scan is the only way they're ever found and removed. Returns the modelName
   * portion of each key deleted, so the caller (reconciliation) can log once per key.
   */
  async pruneLegacyInstanceKeys(): Promise<string[]> {
    const broadPattern = redisKey(this.keyPrefix, MODEL_STATE_PREFIX, '*');
    const keys = await this.scanKeys(broadPattern);
    const legacyPrefix = `${redisKey(this.keyPrefix, MODEL_STATE_PREFIX)}:`;
    const removed: string[] = [];
    for (const key of keys) {
      const rest = key.slice(legacyPrefix.length);
      if (rest.includes(':')) continue; // proper {modelName}:{instanceId} key — leave it alone
      await this.redis.del(key);
      removed.push(rest);
    }
    return removed;
  }

  private async getStatesForPattern(pattern: string): Promise<InstanceState[]> {
    const keys = await this.scanKeys(pattern);
    if (keys.length === 0) return [];

    const pipeline = this.redis.pipeline();
    for (const key of keys) {
      pipeline.get(key);
    }
    const results = await pipeline.exec();
    if (!results) return [];

    const states: InstanceState[] = [];
    for (const [err, raw] of results) {
      if (!err && typeof raw === 'string') {
        states.push(JSON.parse(raw) as InstanceState);
      }
    }
    return states;
  }

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

  async createInstance(
    modelName: string,
    instanceId: string,
    workerId?: string | null,
  ): Promise<InstanceState> {
    const key = instanceStateKey(this.keyPrefix, modelName, instanceId);

    const state: InstanceState = {
      instanceId,
      modelName,
      state: ModelLifecycleState.PENDING,
      workerId: workerId ?? null,
      runnerHost: null,
      runnerPort: null,
      runnerEnginePort: null,
      runnerId: null,
      deviceIndices: null,
      lastInferenceAt: null,
      stateChangedAt: new Date().toISOString(),
      errorMessage: null,
    };

    const result = await this.redis.set(key, JSON.stringify(state), 'NX');
    if (!result) {
      // instanceId is a freshly minted UUID-derived id — a collision here means a genuine bug,
      // not a legitimate retry, but the guard is kept for the same reason the pre-#120 code kept
      // it: SET NX makes concurrent create calls for the same key race safely to one winner.
      throw ControlPlaneError.modelAlreadyExists(`${modelName}/${instanceId}`);
    }
    return state;
  }

  async transition(
    modelName: string,
    instanceId: string,
    to: ModelLifecycleState,
    updates?: Partial<
      Pick<
        InstanceState,
        | 'workerId'
        | 'runnerHost'
        | 'runnerPort'
        | 'runnerEnginePort'
        | 'runnerId'
        | 'deviceIndices'
        | 'errorMessage'
      >
    >,
  ): Promise<InstanceState> {
    const key = instanceStateKey(this.keyPrefix, modelName, instanceId);

    const luaScript = `
      local raw = redis.call('GET', KEYS[1])
      if not raw then
        return nil
      end
      local state = cjson.decode(raw)
      local currentState = state['state']
      local targetState = ARGV[1]
      local updatesJson = ARGV[2]
      local validTransitions = cjson.decode(ARGV[3])

      local allowed = validTransitions[currentState]
      if not allowed then
        return redis.error('INVALID_TRANSITION:' .. currentState .. ':' .. targetState)
      end

      local found = false
      for _, v in ipairs(allowed) do
        if v == targetState then
          found = true
          break
        end
      end
      if not found then
        return redis.error('INVALID_TRANSITION:' .. currentState .. ':' .. targetState)
      end

      state['state'] = targetState
      state['stateChangedAt'] = ARGV[4]

      if updatesJson ~= '{}' then
        local upd = cjson.decode(updatesJson)
        for k, v in pairs(upd) do
          state[k] = v
        end
      end

      if targetState ~= 'ERROR' then
        state['errorMessage'] = cjson.null
      end

      -- #79 audit: cjson encodes an empty Lua table as {}; deviceIndices is a JSON array on the
      -- consumer side. Force [] only when the field is present but empty (rare); null and
      -- non-empty arrays round-trip correctly, so the common path stays cjson.encode(state).
      local dev = state['deviceIndices']
      local encoded
      if type(dev) == 'table' and #dev == 0 then
        state['deviceIndices'] = nil
        local body = cjson.encode(state)
        encoded = string.sub(body, 1, -2) .. ',"deviceIndices":[]}'
      else
        encoded = cjson.encode(state)
      end
      redis.call('SET', KEYS[1], encoded)
      return currentState .. '|' .. encoded
    `;

    const transitionsMap: Record<string, string[]> = {};
    for (const [from, tos] of VALID_TRANSITIONS) {
      transitionsMap[from] = [...tos];
    }

    try {
      const result = await this.redis.eval(
        luaScript,
        1,
        key,
        to,
        JSON.stringify(updates ?? {}),
        JSON.stringify(transitionsMap),
        new Date().toISOString(),
      );

      if (!result) {
        throw ControlPlaneError.modelNotFound(`${modelName}/${instanceId}`);
      }

      const raw = result as string;
      const separatorIndex = raw.indexOf('|');
      const fromState = raw.slice(0, separatorIndex);
      const newState = JSON.parse(raw.slice(separatorIndex + 1)) as InstanceState;

      stateTransitionsTotal.inc({ from: fromState, to });

      return newState;
    } catch (err) {
      if (err instanceof Error && err.message.includes('INVALID_TRANSITION')) {
        const parts = err.message.split(':');
        throw ControlPlaneError.invalidState(
          `${modelName}/${instanceId}`,
          parts[1] ?? 'unknown',
          `transition to ${to}`,
        );
      }
      throw err;
    }
  }

  /**
   * Persist the runner placement (runnerId/host/port) without performing a state
   * transition. Deploy orchestration calls this as soon as the worker places the
   * runner, so logs are addressable during STARTING — before the ACTIVE transition
   * (which also writes these fields) has happened.
   */
  async setRunnerEndpoint(
    modelName: string,
    instanceId: string,
    endpoint: { runnerId: string; host: string; port: number; enginePort?: number },
  ): Promise<void> {
    const key = instanceStateKey(this.keyPrefix, modelName, instanceId);
    const state = await this.getInstance(modelName, instanceId);
    if (!state) {
      throw ControlPlaneError.modelNotFound(`${modelName}/${instanceId}`);
    }

    state.runnerId = endpoint.runnerId;
    state.runnerHost = endpoint.host;
    state.runnerPort = endpoint.port;
    state.runnerEnginePort = endpoint.enginePort ?? endpoint.port;

    await this.redis.set(key, JSON.stringify(state));
  }

  async removeInstance(modelName: string, instanceId: string): Promise<void> {
    const key = instanceStateKey(this.keyPrefix, modelName, instanceId);
    await this.redis.del(key);
  }

  async getLastInferenceTimestamps(modelNames: string[]): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    if (modelNames.length === 0) return result;

    const pipeline = this.redis.pipeline();
    for (const name of modelNames) {
      pipeline.get(redisKey(this.keyPrefix, 'inference', 'last', name));
    }
    const replies = await pipeline.exec();
    if (!replies) return result;

    for (let i = 0; i < modelNames.length; i++) {
      const [err, raw] = replies[i];
      if (!err && typeof raw === 'string') {
        result.set(modelNames[i], raw);
      }
    }
    return result;
  }
}
