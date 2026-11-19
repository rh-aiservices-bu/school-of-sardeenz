import { ModelLifecycleState, Protocol, ClusterEventType } from '@sardeenz/types';
import type { Redis } from '../clients/redis.js';
import { redisKey } from '../clients/redis.js';
import { ControlPlaneError } from '../errors.js';
import { stateTransitionsTotal } from '../health/metrics.js';
import type { ClusterEvent, ClusterEventLogger, ClusterEventSink } from './cluster-events.js';

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
    // A stopped model is normally represented by the absence of a Redis record, so there is no
    // STOPPED → STARTING edge. ERROR is the sole repair edge: a failed teardown can discover
    // only after stopModel settled that its worker identity is unavailable; retaining ERROR
    // preserves observable placement bookkeeping for reconciliation.
    [ModelLifecycleState.STOPPED, [ModelLifecycleState.ERROR]],
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
  /**
   * Protocol family of this instance's runner (from catalog metadata at deploy). Read by
   * refreshModelRoutingState so every routing entry carries a protocol without a catalog lookup
   * on the sleep/wake/reconcile paths. Optional/back-compat: legacy instances predate it; readers
   * default to openai.
   */
  protocol?: Protocol;
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
  /**
   * A POST /runners request was sent but its reply was lost.  The worker may still own a
   * runner, so this ERROR record and its capacity hold must be retained for reconciliation.
   */
  runnerStartAmbiguous?: boolean;
}

export function isValidTransition(from: ModelLifecycleState, to: ModelLifecycleState): boolean {
  const allowed = VALID_TRANSITIONS.get(from);
  return allowed !== undefined && allowed.includes(to);
}

export function isTerminalState(state: ModelLifecycleState): boolean {
  return state === ModelLifecycleState.STOPPED;
}

const MODEL_STATE_PREFIX = 'models';
const MOVE_OPERATION_PREFIX = 'move-operations';

export type MoveOperationPhase =
  | 'REPLACEMENT_STARTING'
  | 'REPLACEMENT_READY'
  | 'CUTTING_OVER'
  | 'SOURCE_DRAINING'
  | 'REPLACEMENT_CLEANUP';

/** Durable move transaction state. Redis, rather than process memory, owns admission/recovery. */
export interface MoveOperation {
  operationId: string;
  modelName: string;
  sourceInstanceId: string;
  replacementInstanceId: string;
  targetWorkerId: string;
  targetDeviceIndices: number[];
  phase: MoveOperationPhase;
  createdAt: string;
  updatedAt: string;
  errorMessage?: string;
}

function instanceStateKey(prefix: string, modelName: string, instanceId: string): string {
  return redisKey(prefix, MODEL_STATE_PREFIX, modelName, instanceId);
}

/**
 * What happened to the runner that backed an instance record, stated by the call site that drops the
 * record (#286). Required so no call site can silently discard the bookkeeping of a possibly-live
 * process: the compiler enumerates every site, and the two "we did not confirm a stop" values are
 * audited with a `RUNNER_ORPHANED` cluster event.
 *
 * - 'runner-stopped'     the worker acknowledged the stop (DELETE 2xx or 404 — already gone)
 * - 'runner-absent'      the worker answered "no runner for this instance" (probe/lookup 404)
 * - 'not-dispatched'     no POST /runners was ever sent for this record
 * - 'worker-unreachable' best-effort cleanup of a dead/unknown worker — the runner's fate is unknown
 * - 'operator-forced'    an explicit ?force=true stop/delete dropped the record on purpose
 */
export type RunnerDisposition =
  'runner-stopped' | 'runner-absent' | 'not-dispatched' | 'worker-unreachable' | 'operator-forced';

export class ModelLifecycleService {
  constructor(
    private readonly redis: Redis,
    private readonly keyPrefix: string,
    /** Audit channel for record drops that were not preceded by a confirmed runner stop (#286). */
    private readonly events?: ClusterEventSink,
    /** Audit log line for the same case; optional so unit tests need only inject what they assert. */
    private readonly logger?: ClusterEventLogger,
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
   *
   * `strict` turns a partially-read result into a rejection. Read paths default to the tolerant
   * behavior (one unreadable record must not blind the caller to the rest), but a caller that
   * decides what to *kill* from the absence of a record must not confuse "no record" with "could
   * not read the record" — `reconcileUnclaimedRunners` reads strictly (#286 review).
   */
  async getAllInstances(options?: { strict?: boolean }): Promise<InstanceState[]> {
    const pattern = redisKey(this.keyPrefix, MODEL_STATE_PREFIX, '*', '*');
    return this.getStatesForPattern(pattern, options?.strict ?? false);
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

  private async getStatesForPattern(pattern: string, strict = false): Promise<InstanceState[]> {
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
      if (err) {
        // Strict callers treat any per-key failure as inconclusive rather than as a missing
        // record (see getAllInstances). Tolerant callers skip it: the alternative is one bad key
        // hiding every other instance from the caller.
        if (strict) {
          throw new Error(`Instance-state read failed for one key: ${err.message}`, {
            cause: err,
          });
        }
        continue;
      }
      if (typeof raw === 'string') {
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
    protocol?: Protocol,
  ): Promise<InstanceState> {
    const key = instanceStateKey(this.keyPrefix, modelName, instanceId);

    const state: InstanceState = {
      instanceId,
      modelName,
      state: ModelLifecycleState.PENDING,
      protocol: protocol ?? Protocol.openai,
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
        | 'runnerStartAmbiguous'
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
        return redis.error_reply('INVALID_TRANSITION:' .. currentState .. ':' .. targetState)
      end

      local found = false
      for _, v in ipairs(allowed) do
        if v == targetState then
          found = true
          break
        end
      end
      if not found then
        return redis.error_reply('INVALID_TRANSITION:' .. currentState .. ':' .. targetState)
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

  /**
   * Drop one instance record, but never silently when the runner's fate is unconfirmed (#286).
   *
   * The disposition is a required argument: the type system, not review discipline, is what keeps a
   * new teardown path from deleting the bookkeeping of a live process. `'worker-unreachable'` and
   * `'operator-forced'` are audited — a `RUNNER_ORPHANED` cluster event (and one structured error
   * line) when the record actually claims a worker/runner — because those are the two shapes that
   * can produce a serving process with no record. Publishing is fire-and-forget and cannot fail a
   * removal: the reverse sweep (reconciliation `reconcileUnclaimedRunners`) is the recovery
   * mechanism, not an exception thrown inside a failure handler.
   *
   * Missing record → return (idempotent; every existing caller depends on this).
   *
   * The one throw surface is the stored record itself: a value `getInstance` cannot parse (corrupt
   * Redis state) rejects out of the GET, before the `DEL`, so the record survives and the caller
   * sees the parse error. Against the previous atomic `DEL` this is new — a path that could never
   * fail on Redis content (e.g. the force-stop `Promise.all` in routes/models.ts) can now throw
   * here. Practically unreachable (Redis does not truncate and every writer uses `JSON.stringify`);
   * documented rather than swallowed so corruption stays visible.
   */
  async removeInstance(
    modelName: string,
    instanceId: string,
    disposition: RunnerDisposition,
  ): Promise<void> {
    const key = instanceStateKey(this.keyPrefix, modelName, instanceId);
    const state = await this.getInstance(modelName, instanceId);
    if (!state) return;

    const audited = disposition === 'worker-unreachable' || disposition === 'operator-forced';
    // `?? null` keeps legacy records (fields absent rather than null) from being read as "claims a
    // worker" — a record that never carried either identity has nothing to leak.
    const claimsRunner = (state.workerId ?? null) !== null || (state.runnerId ?? null) !== null;

    // The DEL comes first: both the log line and the event assert that the record *was* dropped,
    // so publishing before a DEL that then fails would report a drop that did not happen (the
    // record survives, still claims its runner, and the reverse sweep will not touch it).
    await this.redis.del(key);

    if (audited && claimsRunner) {
      this.logger?.error(
        {
          modelName,
          instanceId,
          workerId: state.workerId,
          runnerId: state.runnerId,
          disposition,
        },
        'Instance record dropped without a confirmed runner stop',
      );
      const event: ClusterEvent = {
        type: ClusterEventType.RUNNER_ORPHANED,
        modelName,
        ...(state.workerId ? { workerId: state.workerId } : {}),
        timestamp: new Date().toISOString(),
        message: 'Instance record dropped without a confirmed runner stop',
        data: { instanceId, runnerId: state.runnerId, disposition, reason: 'record-dropped' },
      };
      // Audit only — a broken publisher must never keep a record alive or throw out of a failure
      // handler, but it must never be silent either: without a log line an injected sink that does
      // not log its own failures would lose the orphan trace entirely.
      const logPublishFailure = (err: unknown): void => {
        this.logger?.error(
          { err, modelName, instanceId, disposition, event: event.type },
          'Failed to publish RUNNER_ORPHANED cluster event',
        );
      };
      try {
        // Covers both a synchronous throw and an asynchronous rejection from an injected publisher.
        void Promise.resolve(this.events?.publish(event)).catch(logPublishFailure);
      } catch (err) {
        logPublishFailure(err);
      }
    }
  }

  /**
   * Atomically create the durable transaction fence for one logical model. Unlike the retired
   * time-limited move lease, this record cannot expire halfway through a large deployment; the
   * leader reconciliation loop resumes and removes it only after one side is safely cleaned up.
   */
  async createMoveOperation(operation: MoveOperation): Promise<boolean> {
    const key = redisKey(this.keyPrefix, MOVE_OPERATION_PREFIX, operation.modelName);
    const result = await this.redis.set(key, JSON.stringify(operation), 'NX');
    return result === 'OK';
  }

  async getMoveOperation(modelName: string): Promise<MoveOperation | null> {
    const key = redisKey(this.keyPrefix, MOVE_OPERATION_PREFIX, modelName);
    const raw = await this.redis.get(key);
    return raw ? (JSON.parse(raw) as MoveOperation) : null;
  }

  async getAllMoveOperations(): Promise<MoveOperation[]> {
    const pattern = redisKey(this.keyPrefix, MOVE_OPERATION_PREFIX, '*');
    const keys = await this.scanKeys(pattern);
    if (keys.length === 0) return [];
    const pipeline = this.redis.pipeline();
    for (const key of keys) pipeline.get(key);
    const results = await pipeline.exec();
    if (!results) return [];
    return results.flatMap(([err, raw]) =>
      !err && typeof raw === 'string' ? [JSON.parse(raw) as MoveOperation] : [],
    );
  }

  async updateMoveOperation(
    modelName: string,
    operationId: string,
    updates: Partial<Pick<MoveOperation, 'phase' | 'errorMessage'>>,
  ): Promise<MoveOperation | null> {
    const key = redisKey(this.keyPrefix, MOVE_OPERATION_PREFIX, modelName);
    const luaScript = `
      local raw = redis.call('GET', KEYS[1])
      if not raw then return nil end
      local operation = cjson.decode(raw)
      if operation['operationId'] ~= ARGV[1] then return nil end
      local updates = cjson.decode(ARGV[2])
      if updates['phase'] and updates['phase'] ~= operation['phase'] then
        local allowed = {
          REPLACEMENT_STARTING = { REPLACEMENT_READY = true, REPLACEMENT_CLEANUP = true },
          REPLACEMENT_READY = { CUTTING_OVER = true, REPLACEMENT_CLEANUP = true },
          CUTTING_OVER = { SOURCE_DRAINING = true, REPLACEMENT_CLEANUP = true }
        }
        local from = allowed[operation['phase']]
        if not from or not from[updates['phase']] then return nil end
      end
      for k, v in pairs(updates) do operation[k] = v end
      operation['updatedAt'] = ARGV[3]
      local encoded = cjson.encode(operation)
      redis.call('SET', KEYS[1], encoded)
      return encoded
    `;
    const raw = await this.redis.eval(
      luaScript,
      1,
      key,
      operationId,
      JSON.stringify(updates),
      new Date().toISOString(),
    );
    return raw ? (JSON.parse(raw as string) as MoveOperation) : null;
  }

  async removeMoveOperation(modelName: string, operationId: string): Promise<boolean> {
    const key = redisKey(this.keyPrefix, MOVE_OPERATION_PREFIX, modelName);
    const removed = await this.redis.eval(
      `local raw = redis.call('GET', KEYS[1])
       if not raw then return 0 end
       local operation = cjson.decode(raw)
       if operation['operationId'] ~= ARGV[1] then return 0 end
       return redis.call('DEL', KEYS[1])`,
      1,
      key,
      operationId,
    );
    return removed === 1 || removed === '1';
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
