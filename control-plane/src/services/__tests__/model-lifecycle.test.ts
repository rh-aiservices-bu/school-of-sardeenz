import { describe, it, expect, vi } from 'vitest';
import { ModelLifecycleState } from '@sardeenz/types';

import { isValidTransition, isTerminalState, ModelLifecycleService, type ModelState } from '../model-lifecycle.js';
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
    [ModelLifecycleState.STOPPED, ModelLifecycleState.ERROR],
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

describe('ModelLifecycleService.createModel', () => {
  it('initialises deviceIndices to null', async () => {
    const redis = {
      set: vi.fn().mockResolvedValue('OK'),
    } as unknown as Redis;

    const service = new ModelLifecycleService(redis, 'test');
    const state = await service.createModel('my-model');
    expect(state.deviceIndices).toBeNull();

    const storedJson = (redis.set as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
    const stored = JSON.parse(storedJson) as ModelState;
    expect(stored.deviceIndices).toBeNull();
  });
});

describe('ModelLifecycleService.transition with deviceIndices', () => {
  it('passes deviceIndices to Redis eval updates', async () => {
    const resultState: ModelState = {
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
      eval: vi.fn().mockResolvedValue(
        `${ModelLifecycleState.PENDING}|${JSON.stringify(resultState)}`,
      ),
    } as unknown as Redis;

    const service = new ModelLifecycleService(redis, 'test');
    const result = await service.transition('my-model', ModelLifecycleState.STARTING, {
      workerId: 'w1',
      deviceIndices: [0, 2],
    });

    expect(result.deviceIndices).toEqual([0, 2]);
    expect(result.workerId).toBe('w1');
    expect(result.state).toBe(ModelLifecycleState.STARTING);

    const updatesArg = (redis.eval as ReturnType<typeof vi.fn>).mock.calls[0]?.[4] as string;
    const updates = JSON.parse(updatesArg) as Record<string, unknown>;
    expect(updates.deviceIndices).toEqual([0, 2]);
  });
});

describe('ModelLifecycleService.getLastInferenceTimestamps', () => {
  function makeMockRedis(data: Record<string, string>): Redis {
    return {
      pipeline: () => ({
        get: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue(
          Object.keys(data).length > 0
            ? Object.values(data).map((v) => [null, v])
            : [],
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
