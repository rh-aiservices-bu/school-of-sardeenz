import { describe, it, expect, vi } from 'vitest';
import { ModelLifecycleState } from '@sardeenz/types';

import {
  isValidTransition,
  isTerminalState,
  deriveAggregateState,
  ModelLifecycleService,
  type InstanceState,
} from '../model-lifecycle.js';
import type { Redis } from '../../clients/redis.js';

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

describe('ModelLifecycleService move leases', () => {
  it('uses NX/PX acquire and token-safe release', async () => {
    const set = vi.fn().mockResolvedValue('OK');
    const evalScript = vi.fn().mockResolvedValue(1);
    const redis = {
      set,
      eval: evalScript,
    } as unknown as Redis;
    const service = new ModelLifecycleService(redis, 'test');

    await expect(service.acquireMoveLease('m1', 'owner-a', 12_000)).resolves.toBe(true);
    await service.releaseMoveLease('m1', 'owner-a');

    expect(set).toHaveBeenCalledWith('test:moves:m1', 'owner-a', 'PX', 12_000, 'NX');
    expect(evalScript).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('GET', KEYS[1])"),
      1,
      'test:moves:m1',
      'owner-a',
    );
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

    await service.removeInstance('my-model', 'inst-a');
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
