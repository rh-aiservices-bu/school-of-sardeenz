import { ModelLifecycleState } from '@sardeenz/types';
import type { Redis } from '../clients/redis.js';
import { redisKey } from '../clients/redis.js';
import { ControlPlaneError } from '../errors.js';
import { stateTransitionsTotal } from '../health/metrics.js';

const VALID_TRANSITIONS: ReadonlyMap<ModelLifecycleState, readonly ModelLifecycleState[]> = new Map([
  [ModelLifecycleState.PENDING, [ModelLifecycleState.STARTING, ModelLifecycleState.ERROR]],
  [ModelLifecycleState.STARTING, [ModelLifecycleState.ACTIVE, ModelLifecycleState.ERROR]],
  [ModelLifecycleState.ACTIVE, [ModelLifecycleState.DRAINING, ModelLifecycleState.ERROR]],
  [
    ModelLifecycleState.DRAINING,
    [
      ModelLifecycleState.SLEEPING,
      ModelLifecycleState.STOPPING,
      ModelLifecycleState.ERROR,
    ],
  ],
  [
    ModelLifecycleState.SLEEPING,
    [ModelLifecycleState.STARTING, ModelLifecycleState.STOPPING, ModelLifecycleState.ERROR],
  ],
  [ModelLifecycleState.STOPPING, [ModelLifecycleState.STOPPED, ModelLifecycleState.ERROR]],
  [ModelLifecycleState.STOPPED, []],
  [
    ModelLifecycleState.ERROR,
    [ModelLifecycleState.STOPPED, ModelLifecycleState.STARTING],
  ],
]);

export interface ModelState {
  modelName: string;
  state: ModelLifecycleState;
  workerId: string | null;
  runnerHost: string | null;
  runnerPort: number | null;
  runnerId: string | null;
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
    const keys = await this.redis.keys(pattern);
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

  async createModel(
    modelName: string,
    workerId?: string | null,
  ): Promise<ModelState> {
    const key = modelStateKey(this.keyPrefix, modelName);
    const existing = await this.redis.get(key);
    if (existing) {
      throw ControlPlaneError.modelAlreadyExists(modelName);
    }

    const state: ModelState = {
      modelName,
      state: ModelLifecycleState.PENDING,
      workerId: workerId ?? null,
      runnerHost: null,
      runnerPort: null,
      runnerId: null,
      lastInferenceAt: null,
      stateChangedAt: new Date().toISOString(),
      errorMessage: null,
    };

    await this.redis.set(key, JSON.stringify(state));
    return state;
  }

  async transition(
    modelName: string,
    to: ModelLifecycleState,
    updates?: Partial<Pick<ModelState, 'workerId' | 'runnerHost' | 'runnerPort' | 'runnerId' | 'errorMessage'>>,
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
      return encoded
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

      const newState = JSON.parse(result as string) as ModelState;

      stateTransitionsTotal.inc({ from: newState.state === to ? 'unknown' : '', to });

      return newState;
    } catch (err) {
      if (err instanceof Error && err.message.includes('INVALID_TRANSITION')) {
        const parts = err.message.split(':');
        throw ControlPlaneError.invalidState(modelName, parts[1] ?? 'unknown', `transition to ${to}`);
      }
      throw err;
    }
  }

  async removeModel(modelName: string): Promise<void> {
    const key = modelStateKey(this.keyPrefix, modelName);
    await this.redis.del(key);
  }

  async updateLastInference(modelName: string): Promise<void> {
    const key = modelStateKey(this.keyPrefix, modelName);
    const raw = await this.redis.get(key);
    if (!raw) return;
    const state = JSON.parse(raw) as ModelState;
    state.lastInferenceAt = new Date().toISOString();
    await this.redis.set(key, JSON.stringify(state));
  }
}
