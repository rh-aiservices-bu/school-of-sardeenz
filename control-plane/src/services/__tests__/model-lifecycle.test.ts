import { describe, it, expect, vi } from 'vitest';
import type { Mock } from 'vitest';
import { ModelLifecycleState } from '@sardeenz/types';

import {
  isValidTransition,
  isTerminalState,
  deriveAggregateState,
  ModelLifecycleService,
  type InstanceState,
} from '../model-lifecycle.js';
import type { Redis } from '../../clients/redis.js';
import { ControlPlaneError, StateConflictError } from '../../errors.js';

describe('isValidTransition', () => {
  const validTransitions: [ModelLifecycleState, ModelLifecycleState][] = [
    [ModelLifecycleState.PENDING, ModelLifecycleState.STARTING],
    [ModelLifecycleState.PENDING, ModelLifecycleState.ERROR],
    [ModelLifecycleState.STARTING, ModelLifecycleState.ACTIVE],
    [ModelLifecycleState.STARTING, ModelLifecycleState.ERROR],
    [ModelLifecycleState.ACTIVE, ModelLifecycleState.DRAINING],
    [ModelLifecycleState.ACTIVE, ModelLifecycleState.ERROR],
    [ModelLifecycleState.DRAINING, ModelLifecycleState.SLEEPING],
    [ModelLifecycleState.DRAINING, ModelLifecycleState.STOPPING],
    [ModelLifecycleState.DRAINING, ModelLifecycleState.ERROR],
    [ModelLifecycleState.SLEEPING, ModelLifecycleState.STARTING],
    [ModelLifecycleState.SLEEPING, ModelLifecycleState.STOPPING],
    [ModelLifecycleState.SLEEPING, ModelLifecycleState.ERROR],
    [ModelLifecycleState.STOPPING, ModelLifecycleState.STOPPED],
    [ModelLifecycleState.STOPPING, ModelLifecycleState.ERROR],
    [ModelLifecycleState.ERROR, ModelLifecycleState.STOPPED],
    [ModelLifecycleState.ERROR, ModelLifecycleState.STARTING],
    // Retains an ambiguous teardown for reconciliation instead of leaving a STOPPED key that
    // blocks start forever.
    [ModelLifecycleState.STOPPED, ModelLifecycleState.ERROR],
  ];

  for (const [from, to] of validTransitions) {
    it(`allows ${from} → ${to}`, () => {
      expect(isValidTransition(from, to)).toBe(true);
    });
  }

  const invalidTransitions: [ModelLifecycleState, ModelLifecycleState][] = [
    [ModelLifecycleState.PENDING, ModelLifecycleState.ACTIVE],
    [ModelLifecycleState.PENDING, ModelLifecycleState.SLEEPING],
    [ModelLifecycleState.ACTIVE, ModelLifecycleState.SLEEPING],
    [ModelLifecycleState.ACTIVE, ModelLifecycleState.STARTING],
    [ModelLifecycleState.SLEEPING, ModelLifecycleState.ACTIVE],
    [ModelLifecycleState.STOPPED, ModelLifecycleState.STARTING],
    [ModelLifecycleState.STOPPED, ModelLifecycleState.ACTIVE],
  ];

  for (const [from, to] of invalidTransitions) {
    it(`rejects ${from} → ${to}`, () => {
      expect(isValidTransition(from, to)).toBe(false);
    });
  }
});

describe('isTerminalState', () => {
  it('STOPPED is terminal', () => {
    expect(isTerminalState(ModelLifecycleState.STOPPED)).toBe(true);
  });

  it('ACTIVE is not terminal', () => {
    expect(isTerminalState(ModelLifecycleState.ACTIVE)).toBe(false);
  });

  it('ERROR is not terminal', () => {
    expect(isTerminalState(ModelLifecycleState.ERROR)).toBe(false);
  });
});

describe('deriveAggregateState', () => {
  it('returns STOPPED for an empty instance set', () => {
    expect(deriveAggregateState([])).toBe(ModelLifecycleState.STOPPED);
  });

  it('returns STOPPED when every instance is (transiently) STOPPED', () => {
    expect(
      deriveAggregateState([
        { state: ModelLifecycleState.STOPPED },
        { state: ModelLifecycleState.STOPPED },
      ]),
    ).toBe(ModelLifecycleState.STOPPED);
  });

  it('ACTIVE beats ERROR — a healthy replica masks a broken one (M7 acceptance criterion 4)', () => {
    expect(
      deriveAggregateState([
        { state: ModelLifecycleState.ACTIVE },
        { state: ModelLifecycleState.ERROR },
      ]),
    ).toBe(ModelLifecycleState.ACTIVE);
  });

  it('all SLEEPING → SLEEPING', () => {
    expect(
      deriveAggregateState([
        { state: ModelLifecycleState.SLEEPING },
        { state: ModelLifecycleState.SLEEPING },
      ]),
    ).toBe(ModelLifecycleState.SLEEPING);
  });

  it('STARTING beats SLEEPING', () => {
    expect(
      deriveAggregateState([
        { state: ModelLifecycleState.STARTING },
        { state: ModelLifecycleState.SLEEPING },
      ]),
    ).toBe(ModelLifecycleState.STARTING);
  });

  it('STOPPING beats ERROR', () => {
    expect(
      deriveAggregateState([
        { state: ModelLifecycleState.ERROR },
        { state: ModelLifecycleState.STOPPING },
      ]),
    ).toBe(ModelLifecycleState.STOPPING);
  });

  it('honors the full precedence order ACTIVE > STARTING > DRAINING > SLEEPING > PENDING > STOPPING > ERROR', () => {
    const order = [
      ModelLifecycleState.ACTIVE,
      ModelLifecycleState.STARTING,
      ModelLifecycleState.DRAINING,
      ModelLifecycleState.SLEEPING,
      ModelLifecycleState.PENDING,
      ModelLifecycleState.STOPPING,
      ModelLifecycleState.ERROR,
    ];
    for (let i = 0; i < order.length; i++) {
      const instances = order.slice(i).map((state) => ({ state }));
      expect(deriveAggregateState(instances)).toBe(order[i]);
    }
  });
});

describe('ModelLifecycleService.createInstance', () => {
  it('initialises deviceIndices to null and stamps modelName/instanceId', async () => {
    const redis = {
      set: vi.fn().mockResolvedValue('OK'),
    } as unknown as Redis;

    const service = new ModelLifecycleService(redis, 'test');
    const state = await service.createInstance('my-model', 'inst-aaa111');
    expect(state.deviceIndices).toBeNull();
    expect(state.modelName).toBe('my-model');
    expect(state.instanceId).toBe('inst-aaa111');

    const storedJson = (redis.set as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
    const stored = JSON.parse(storedJson) as InstanceState;
    expect(stored.deviceIndices).toBeNull();
    expect(stored.instanceId).toBe('inst-aaa111');
  });
});

describe('ModelLifecycleService durable move operations', () => {
  it('uses a non-expiring NX record as the transaction and admission fence', async () => {
    const set = vi.fn().mockResolvedValue('OK');
    const redis = { set } as unknown as Redis;
    const service = new ModelLifecycleService(redis, 'test');

    const operation = {
      operationId: 'move-1',
      modelName: 'm1',
      sourceInstanceId: 'inst-source',
      replacementInstanceId: 'inst-replacement',
      targetWorkerId: 'worker-2',
      targetDeviceIndices: [1],
      phase: 'REPLACEMENT_STARTING' as const,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };
    await expect(service.createMoveOperation(operation)).resolves.toBe(true);

    expect(set).toHaveBeenCalledWith('test:move-operations:m1', JSON.stringify(operation), 'NX');
  });
});

describe('ModelLifecycleService instance-keyed round trips', () => {
  it('two instances of one model coexist under distinct keys', async () => {
    const store = new Map<string, string>();
    const redis = {
      set: vi.fn((key: string, value: string) => {
        store.set(key, value);
        return 'OK';
      }),
      get: vi.fn((key: string) => store.get(key) ?? null),
      del: vi.fn((key: string) => {
        store.delete(key);
        return 1;
      }),
      scan: vi.fn((_cursor: string, _match: string, pattern: string) => {
        const keys = [...store.keys()].filter((k) => {
          const re = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
          return re.test(k);
        });
        return ['0', keys];
      }),
      pipeline: () => {
        const gets: string[] = [];
        return {
          get: (key: string) => {
            gets.push(key);
            return { get: vi.fn(), exec: vi.fn() };
          },
          exec: () => gets.map((k) => [null, store.get(k) ?? null]),
        };
      },
    } as unknown as Redis;

    const service = new ModelLifecycleService(redis, 'test');
    await service.createInstance('my-model', 'inst-a');
    await service.createInstance('my-model', 'inst-b');

    const a = await service.getInstance('my-model', 'inst-a');
    const b = await service.getInstance('my-model', 'inst-b');
    expect(a?.instanceId).toBe('inst-a');
    expect(b?.instanceId).toBe('inst-b');

    const forModel = await service.getInstancesForModel('my-model');
    expect(forModel.map((i) => i.instanceId).sort()).toEqual(['inst-a', 'inst-b']);

    const all = await service.getAllInstances();
    expect(all.map((i) => i.instanceId).sort()).toEqual(['inst-a', 'inst-b']);

    await service.removeInstance('my-model', 'inst-a', 'runner-stopped');
    expect(await service.getInstance('my-model', 'inst-a')).toBeNull();
    expect(await service.getInstance('my-model', 'inst-b')).not.toBeNull();
  });
});

// Shared by the legacy-key tests below: a minimal in-memory Redis whose `scan` mimics real SCAN
// MATCH glob semantics (`*` matches across `:` too), the same behavior that made getAllInstances'
// old bare `models:*` pattern also match pre-#120 single-segment keys (boundary review MEDIUM-1 /
// LOW-1, ADR-019 point 12).
function buildMockRedisStore(seed: Record<string, string> = {}): {
  redis: Redis;
  store: Map<string, string>;
} {
  const store = new Map<string, string>(Object.entries(seed));
  const redis = {
    set: vi.fn((key: string, value: string) => {
      store.set(key, value);
      return 'OK';
    }),
    get: vi.fn((key: string) => store.get(key) ?? null),
    del: vi.fn((key: string) => {
      const existed = store.delete(key);
      return existed ? 1 : 0;
    }),
    scan: vi.fn((_cursor: string, _match: string, pattern: string) => {
      const keys = [...store.keys()].filter((k) => {
        const re = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
        return re.test(k);
      });
      return ['0', keys];
    }),
    pipeline: () => {
      const gets: string[] = [];
      return {
        get: (key: string) => {
          gets.push(key);
          return { get: vi.fn(), exec: vi.fn() };
        },
        exec: () => gets.map((k) => [null, store.get(k) ?? null]),
      };
    },
  } as unknown as Redis;
  return { redis, store };
}

describe('getAllInstances legacy-key boundary (boundary review MEDIUM-1 / LOW-1)', () => {
  it('excludes a pre-#120 single-segment legacy key (models:{modelName}, no instanceId)', async () => {
    const legacyBlob = JSON.stringify({
      modelName: 'legacy-model',
      state: ModelLifecycleState.ACTIVE,
      // no instanceId — this is the old ModelState shape.
    });
    const { redis } = buildMockRedisStore({
      'test:models:legacy-model': legacyBlob,
    });
    const service = new ModelLifecycleService(redis, 'test');
    await service.createInstance('my-model', 'inst-a');

    const all = await service.getAllInstances();

    // Only the proper two-segment instance key shows up — the legacy single-segment key is
    // structurally invisible now (getAllInstances requires models:*:*, not a bare models:*).
    expect(all.map((i) => i.instanceId)).toEqual(['inst-a']);
    expect(all.some((i) => i.instanceId === undefined)).toBe(false);
  });

  it('getInstancesForModel never matched the legacy key shape either (pre-existing, unchanged)', async () => {
    const legacyBlob = JSON.stringify({
      modelName: 'legacy-model',
      state: ModelLifecycleState.ACTIVE,
    });
    const { redis } = buildMockRedisStore({
      'test:models:legacy-model': legacyBlob,
    });
    const service = new ModelLifecycleService(redis, 'test');

    const forModel = await service.getInstancesForModel('legacy-model');

    expect(forModel).toEqual([]);
  });
});

describe('getAllInstances strict read (#286 review)', () => {
  const RECORD = JSON.stringify({
    instanceId: 'inst-a',
    modelName: 'model-a',
    state: ModelLifecycleState.ACTIVE,
    workerId: 'w1',
  });

  /** `scan` returns two instance keys; `exec` returns whatever the case hands it. */
  function buildServiceWith(results: Array<[Error | null, string | null]>): ModelLifecycleService {
    const redis = {
      scan: vi
        .fn()
        .mockResolvedValue(['0', ['test:models:model-a:inst-a', 'test:models:b:inst-b']]),
      pipeline: () => ({
        get: vi.fn(),
        exec: vi.fn().mockResolvedValue(results),
      }),
    } as unknown as Redis;
    return new ModelLifecycleService(redis, 'test');
  }

  it('rejects instead of returning a partial set when a key cannot be read', async () => {
    const service = buildServiceWith([
      [null, RECORD],
      [new Error('LOADING Redis is loading the dataset in memory'), null],
    ]);

    await expect(service.getAllInstances({ strict: true })).rejects.toThrow(
      'Instance-state read failed for one key',
    );
  });

  it('skips the unreadable key for read-only callers that only display state', async () => {
    const service = buildServiceWith([
      [null, RECORD],
      [new Error('LOADING Redis is loading the dataset in memory'), null],
    ]);

    const all = await service.getAllInstances();

    expect(all.map((i) => i.instanceId)).toEqual(['inst-a']);
  });
});

describe('ModelLifecycleService.pruneLegacyInstanceKeys', () => {
  it('deletes a legacy single-segment key and returns its modelName', async () => {
    const legacyBlob = JSON.stringify({
      modelName: 'legacy-model',
      state: ModelLifecycleState.ACTIVE,
    });
    const { redis, store } = buildMockRedisStore({
      'test:models:legacy-model': legacyBlob,
    });
    const service = new ModelLifecycleService(redis, 'test');

    const removed = await service.pruneLegacyInstanceKeys();

    expect(removed).toEqual(['legacy-model']);
    expect(store.has('test:models:legacy-model')).toBe(false);
  });

  it('leaves proper {modelName}:{instanceId} keys untouched', async () => {
    const { redis, store } = buildMockRedisStore();
    const service = new ModelLifecycleService(redis, 'test');
    await service.createInstance('my-model', 'inst-a');

    const removed = await service.pruneLegacyInstanceKeys();

    expect(removed).toEqual([]);
    expect(store.has('test:models:my-model:inst-a')).toBe(true);
  });

  it('a list read after pruning agrees with a per-model detail read (no more list/detail disagreement)', async () => {
    const legacyBlob = JSON.stringify({
      modelName: 'legacy-model',
      state: ModelLifecycleState.ACTIVE,
    });
    const { redis } = buildMockRedisStore({
      'test:models:legacy-model': legacyBlob,
    });
    const service = new ModelLifecycleService(redis, 'test');

    await service.pruneLegacyInstanceKeys();

    const all = await service.getAllInstances();
    const forModel = await service.getInstancesForModel('legacy-model');
    expect(all.filter((i) => i.modelName === 'legacy-model')).toEqual([]);
    expect(forModel).toEqual([]);
  });
});

describe('ModelLifecycleService.transition with deviceIndices', () => {
  it('passes deviceIndices to Redis eval updates, scoped to one instance', async () => {
    const resultState: InstanceState = {
      instanceId: 'inst-1',
      modelName: 'my-model',
      state: ModelLifecycleState.STARTING,
      workerId: 'w1',
      runnerHost: null,
      runnerPort: null,
      runnerId: null,
      deviceIndices: [0, 2],
      lastInferenceAt: null,
      stateChangedAt: '2026-01-01T00:00:00.000Z',
      errorMessage: null,
    };

    const redis = {
      eval: vi
        .fn()
        .mockResolvedValue(`${ModelLifecycleState.PENDING}|${JSON.stringify(resultState)}`),
    } as unknown as Redis;

    const service = new ModelLifecycleService(redis, 'test');
    const result = await service.transition('my-model', 'inst-1', ModelLifecycleState.STARTING, {
      workerId: 'w1',
      deviceIndices: [0, 2],
    });

    expect(result.deviceIndices).toEqual([0, 2]);
    expect(result.workerId).toBe('w1');
    expect(result.state).toBe(ModelLifecycleState.STARTING);

    const updatesArg = (redis.eval as ReturnType<typeof vi.fn>).mock.calls[0]?.[4] as string;
    const updates = JSON.parse(updatesArg) as Record<string, unknown>;
    expect(updates.deviceIndices).toEqual([0, 2]);

    // redis.eval(script, numKeys, key, ...) — the instance key is argument index 2.
    const key = (redis.eval as ReturnType<typeof vi.fn>).mock.calls[0]?.[2] as string;
    expect(key).toContain('my-model');
    expect(key).toContain('inst-1');
  });

  it('maps an INVALID_TRANSITION CAS loss to StateConflictError (still 409 INVALID_STATE on the wire)', async () => {
    const redis = {
      eval: vi.fn().mockRejectedValue(new Error('INVALID_TRANSITION:SLEEPING:ACTIVE')),
    } as unknown as Redis;

    const service = new ModelLifecycleService(redis, 'test');

    const err = await service
      .transition('my-model', 'inst-1', ModelLifecycleState.STARTING)
      .then(() => null)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(StateConflictError);
    expect(err).toBeInstanceOf(ControlPlaneError);
    const conflict = err as StateConflictError;
    expect(conflict.name).toBe('StateConflictError');
    expect(conflict.code).toBe('INVALID_STATE');
    expect(conflict.statusCode).toBe(409);
    expect(conflict.details?.currentState).toBe('SLEEPING');
    expect(conflict.message).toBe(
      'Cannot transition to STARTING model my-model/inst-1: current state is SLEEPING',
    );
    expect(conflict.toResponse()).toEqual({
      error: 'Cannot transition to STARTING model my-model/inst-1: current state is SLEEPING',
      code: 'INVALID_STATE',
      details: {
        modelName: 'my-model/inst-1',
        currentState: 'SLEEPING',
        action: 'transition to STARTING',
      },
    });
  });
});

describe('ModelLifecycleService.setRunnerEndpoint', () => {
  it('persists runnerId/host/port without changing state', async () => {
    const existing: InstanceState = {
      instanceId: 'inst-1',
      modelName: 'my-model',
      state: ModelLifecycleState.STARTING,
      workerId: 'w1',
      runnerHost: null,
      runnerPort: null,
      runnerId: null,
      deviceIndices: [0],
      lastInferenceAt: null,
      stateChangedAt: '2026-01-01T00:00:00.000Z',
      errorMessage: null,
    };

    const redis = {
      get: vi.fn().mockResolvedValue(JSON.stringify(existing)),
      set: vi.fn().mockResolvedValue('OK'),
    } as unknown as Redis;

    const service = new ModelLifecycleService(redis, 'test');
    await service.setRunnerEndpoint('my-model', 'inst-1', {
      runnerId: 'runner-1',
      host: '10.0.0.5',
      port: 9000,
    });

    const setCalls = (redis.set as ReturnType<typeof vi.fn>).mock.calls;
    expect(setCalls).toHaveLength(1);
    const [key, storedJson] = setCalls[0] as [string, string];
    expect(key).toContain('my-model');
    expect(key).toContain('inst-1');
    const stored = JSON.parse(storedJson) as InstanceState;
    expect(stored.runnerId).toBe('runner-1');
    expect(stored.runnerHost).toBe('10.0.0.5');
    expect(stored.runnerPort).toBe(9000);
    // No distinct engine port supplied → falls back to the management port.
    expect(stored.runnerEnginePort).toBe(9000);
    // State itself is untouched — no transition happened.
    expect(stored.state).toBe(ModelLifecycleState.STARTING);
    expect(stored.stateChangedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('throws modelNotFound when the instance does not exist', async () => {
    const redis = {
      get: vi.fn().mockResolvedValue(null),
    } as unknown as Redis;

    const service = new ModelLifecycleService(redis, 'test');
    await expect(
      service.setRunnerEndpoint('missing-model', 'inst-x', {
        runnerId: 'r1',
        host: 'h',
        port: 1,
      }),
    ).rejects.toThrow('Model not found');
  });
});

describe('ModelLifecycleService.getLastInferenceTimestamps', () => {
  function makeMockRedis(data: Record<string, string>): Redis {
    return {
      pipeline: () => ({
        get: vi.fn().mockReturnThis(),
        exec: vi
          .fn()
          .mockResolvedValue(
            Object.keys(data).length > 0 ? Object.values(data).map((v) => [null, v]) : [],
          ),
      }),
    } as unknown as Redis;
  }

  it('returns empty map for empty model list', async () => {
    const redis = makeMockRedis({});
    const service = new ModelLifecycleService(redis, 'test');
    const result = await service.getLastInferenceTimestamps([]);
    expect(result.size).toBe(0);
  });

  it('returns timestamps for models that have inference data', async () => {
    const ts1 = '2026-06-15T10:00:00.000Z';
    const ts2 = '2026-06-15T11:00:00.000Z';
    const redis = {
      pipeline: () => {
        const calls: string[] = [];
        return {
          get: vi.fn((key: string) => {
            calls.push(key);
            return { get: vi.fn().mockReturnThis(), exec: vi.fn() };
          }),
          exec: vi.fn().mockResolvedValue([
            [null, ts1],
            [null, null],
            [null, ts2],
          ]),
        };
      },
    } as unknown as Redis;
    const service = new ModelLifecycleService(redis, 'test');
    const result = await service.getLastInferenceTimestamps(['model-a', 'model-b', 'model-c']);
    expect(result.size).toBe(2);
    expect(result.get('model-a')).toBe(ts1);
    expect(result.has('model-b')).toBe(false);
    expect(result.get('model-c')).toBe(ts2);
  });

  it('returns empty map when no models have inference data', async () => {
    const redis = {
      pipeline: () => ({
        get: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue([
          [null, null],
          [null, null],
        ]),
      }),
    } as unknown as Redis;
    const service = new ModelLifecycleService(redis, 'test');
    const result = await service.getLastInferenceTimestamps(['model-a', 'model-b']);
    expect(result.size).toBe(0);
  });
});

describe('ModelLifecycleService.removeInstance disposition boundary (#286)', () => {
  const MODEL = 'teardown-model';
  const INSTANCE = 'inst-teardown';
  const KEY = `test:models:${MODEL}:${INSTANCE}`;

  function record(overrides: Partial<InstanceState> = {}): string {
    return JSON.stringify({
      instanceId: INSTANCE,
      modelName: MODEL,
      state: ModelLifecycleState.ACTIVE,
      workerId: 'worker-1',
      runnerHost: '10.0.0.1',
      runnerPort: 8000,
      runnerId: 'runner-1',
      deviceIndices: [0],
      lastInferenceAt: null,
      stateChangedAt: new Date().toISOString(),
      errorMessage: null,
      ...overrides,
    });
  }

  function buildService(seed: Record<string, string>) {
    const { redis, store } = buildMockRedisStore(seed);
    const events = { publish: vi.fn<(event: unknown) => Promise<void>>(() => Promise.resolve()) };
    const logger = { error: vi.fn() };
    const service = new ModelLifecycleService(redis, 'test', events, logger);
    return { service, store, events, logger };
  }

  it('is a no-op for a missing record and publishes nothing', async () => {
    const { service, events, logger } = buildService({});

    await expect(
      service.removeInstance(MODEL, INSTANCE, 'operator-forced'),
    ).resolves.toBeUndefined();

    expect(events.publish).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('deletes silently for a confirmed stop', async () => {
    const { service, store, events, logger } = buildService({ [KEY]: record() });

    await service.removeInstance(MODEL, INSTANCE, 'runner-stopped');

    expect(store.has(KEY)).toBe(false);
    expect(events.publish).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('deletes silently for a runner the worker proved absent', async () => {
    const { service, store, events } = buildService({ [KEY]: record() });

    await service.removeInstance(MODEL, INSTANCE, 'runner-absent');

    expect(store.has(KEY)).toBe(false);
    expect(events.publish).not.toHaveBeenCalled();
  });

  it("audits an 'operator-forced' drop of a record that claims a runner", async () => {
    const { service, store, events, logger } = buildService({ [KEY]: record() });

    await service.removeInstance(MODEL, INSTANCE, 'operator-forced');

    expect(store.has(KEY)).toBe(false);
    expect(logger.error).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith(
      {
        modelName: MODEL,
        instanceId: INSTANCE,
        workerId: 'worker-1',
        runnerId: 'runner-1',
        disposition: 'operator-forced',
      },
      'Instance record dropped without a confirmed runner stop',
    );
    expect(events.publish).toHaveBeenCalledOnce();
    expect(events.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'RUNNER_ORPHANED',
        modelName: MODEL,
        workerId: 'worker-1',
        message: 'Instance record dropped without a confirmed runner stop',
        data: {
          instanceId: INSTANCE,
          runnerId: 'runner-1',
          disposition: 'operator-forced',
          reason: 'record-dropped',
        },
      }),
    );
  });

  it("audits 'worker-unreachable' with a workerId but no runnerId", async () => {
    const { service, store, events } = buildService({
      [KEY]: record({ runnerId: null, runnerHost: null, runnerPort: null }),
    });

    await service.removeInstance(MODEL, INSTANCE, 'worker-unreachable');

    expect(store.has(KEY)).toBe(false);
    expect(events.publish).toHaveBeenCalledOnce();
    expect(events.publish.mock.calls[0]?.[0]).toMatchObject({
      type: 'RUNNER_ORPHANED',
      workerId: 'worker-1',
      data: { instanceId: INSTANCE, disposition: 'worker-unreachable', reason: 'record-dropped' },
    });
  });

  it("deletes silently for 'worker-unreachable' when the record claims neither identity", async () => {
    const { service, store, events, logger } = buildService({
      [KEY]: record({ workerId: null, runnerId: null }),
    });

    await service.removeInstance(MODEL, INSTANCE, 'worker-unreachable');

    expect(store.has(KEY)).toBe(false);
    expect(events.publish).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('publishes nothing when the DEL fails: no record was dropped', async () => {
    const { redis, store } = buildMockRedisStore({ [KEY]: record() });
    const events = { publish: vi.fn(() => Promise.resolve()) };
    const logger = { error: vi.fn() };
    const service = new ModelLifecycleService(redis, 'test', events, logger);
    (redis.del as unknown as Mock).mockRejectedValueOnce(new Error('redis unavailable'));

    await expect(service.removeInstance(MODEL, INSTANCE, 'operator-forced')).rejects.toThrow(
      'redis unavailable',
    );

    // The event and the log both claim a drop; neither may happen when the drop did not.
    expect(store.has(KEY)).toBe(true);
    expect(events.publish).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('publishes once, after the record is gone, on a confirmed forced drop', async () => {
    const { service, store, events } = buildService({ [KEY]: record() });

    await service.removeInstance(MODEL, INSTANCE, 'operator-forced');

    expect(store.has(KEY)).toBe(false);
    expect(events.publish).toHaveBeenCalledOnce();
  });

  it('never fails the removal when the publisher rejects, and logs the failed event', async () => {
    const { redis, store } = buildMockRedisStore({ [KEY]: record() });
    const events = { publish: vi.fn(() => Promise.reject(new Error('redis down'))) };
    const logger = { error: vi.fn() };
    const service = new ModelLifecycleService(redis, 'test', events, logger);

    await expect(
      service.removeInstance(MODEL, INSTANCE, 'operator-forced'),
    ).resolves.toBeUndefined();

    expect(store.has(KEY)).toBe(false);
    expect(events.publish).toHaveBeenCalledOnce();
    // One line for the audited drop, one for the event that never reached the sink.
    expect(logger.error).toHaveBeenCalledTimes(2);
    const publishFailure = logger.error.mock.calls.find(
      (call) => call[1] === 'Failed to publish RUNNER_ORPHANED cluster event',
    );
    expect(publishFailure?.[0]).toMatchObject({
      modelName: MODEL,
      instanceId: INSTANCE,
      disposition: 'operator-forced',
      event: 'RUNNER_ORPHANED',
    });
    expect((publishFailure?.[0] as { err: unknown } | undefined)?.err).toHaveProperty(
      'message',
      'redis down',
    );
  });

  it('never fails the removal when the publisher throws synchronously, and logs it', async () => {
    const { redis, store } = buildMockRedisStore({ [KEY]: record() });
    const events = {
      publish: vi.fn(() => {
        throw new Error('publisher exploded');
      }),
    };
    const logger = { error: vi.fn() };
    const service = new ModelLifecycleService(redis, 'test', events, logger);

    await expect(
      service.removeInstance(MODEL, INSTANCE, 'operator-forced'),
    ).resolves.toBeUndefined();

    expect(store.has(KEY)).toBe(false);
    const publishFailure = logger.error.mock.calls.find(
      (call) => call[1] === 'Failed to publish RUNNER_ORPHANED cluster event',
    );
    expect(publishFailure?.[0]).toMatchObject({ disposition: 'operator-forced' });
    expect((publishFailure?.[0] as { err: unknown } | undefined)?.err).toHaveProperty(
      'message',
      'publisher exploded',
    );
  });

  it('deletes without a publisher injected', async () => {
    const { redis, store } = buildMockRedisStore({ [KEY]: record() });
    const service = new ModelLifecycleService(redis, 'test');

    await expect(
      service.removeInstance(MODEL, INSTANCE, 'operator-forced'),
    ).resolves.toBeUndefined();

    expect(store.has(KEY)).toBe(false);
  });
});
