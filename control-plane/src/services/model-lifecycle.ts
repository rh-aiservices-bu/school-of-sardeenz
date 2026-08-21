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
    [ModelLifecycleState.STOPPED, []],
    [ModelLifecycleState.ERROR, [ModelLifecycleState.STOPPED, ModelLifecycleState.STARTING]],
  ],
);

export interface ModelState {
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

function modelStateKey(prefix: string, modelName: string): string {
  return redisKey(prefix, MODEL_STATE_PREFIX, modelName);
}

export class ModelLifecycleService {
  constructor(
    private readonly redis: Redis,
    private readonly keyPrefix: string,
  ) {}

  async getState(modelName: string): Promise<ModelState | null> {
    const raw = await this.redis.get(modelStateKey(this.keyPrefix, modelName));
    if (!raw) return null;
    return JSON.parse(raw) as ModelState;
  }

  async getAllStates(): Promise<ModelState[]> {
    const pattern = redisKey(this.keyPrefix, MODEL_STATE_PREFIX, '*');
    const keys = await this.scanKeys(pattern);
    if (keys.length === 0) return [];

    const pipeline = this.redis.pipeline();
    for (const key of keys) {
      pipeline.get(key);
    }
    const results = await pipeline.exec();
    if (!results) return [];

    const states: ModelState[] = [];
    for (const [err, raw] of results) {
      if (!err && typeof raw === 'string') {
        states.push(JSON.parse(raw) as ModelState);
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

  async createModel(modelName: string, workerId?: string | null): Promise<ModelState> {
    const key = modelStateKey(this.keyPrefix, modelName);

    const state: ModelState = {
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
      throw ControlPlaneError.modelAlreadyExists(modelName);
    }
    return state;
  }

  async transition(
    modelName: string,
    to: ModelLifecycleState,
    updates?: Partial<
      Pick<
        ModelState,
        | 'workerId'
        | 'runnerHost'
        | 'runnerPort'
        | 'runnerEnginePort'
        | 'runnerId'
        | 'deviceIndices'
        | 'errorMessage'
      >
    >,
  ): Promise<ModelState> {
    const key = modelStateKey(this.keyPrefix, modelName);

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

      local encoded = cjson.encode(state)
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
        throw ControlPlaneError.modelNotFound(modelName);
      }

      const raw = result as string;
      const separatorIndex = raw.indexOf('|');
      const fromState = raw.slice(0, separatorIndex);
      const newState = JSON.parse(raw.slice(separatorIndex + 1)) as ModelState;

      stateTransitionsTotal.inc({ from: fromState, to });

      return newState;
    } catch (err) {
      if (err instanceof Error && err.message.includes('INVALID_TRANSITION')) {
        const parts = err.message.split(':');
        throw ControlPlaneError.invalidState(
          modelName,
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
    endpoint: { runnerId: string; host: string; port: number; enginePort?: number },
  ): Promise<void> {
    const key = modelStateKey(this.keyPrefix, modelName);
    const state = await this.getState(modelName);
    if (!state) {
      throw ControlPlaneError.modelNotFound(modelName);
    }

    state.runnerId = endpoint.runnerId;
    state.runnerHost = endpoint.host;
    state.runnerPort = endpoint.port;
    state.runnerEnginePort = endpoint.enginePort ?? endpoint.port;

    await this.redis.set(key, JSON.stringify(state));
  }

  async removeModel(modelName: string): Promise<void> {
    const key = modelStateKey(this.keyPrefix, modelName);
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
