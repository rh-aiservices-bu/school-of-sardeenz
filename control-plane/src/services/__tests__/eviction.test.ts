import { describe, it, expect } from 'vitest';
import { ModelLifecycleState } from '@sardeenz/types';

import { EvictionEngine, LruEvictionStrategy } from '../eviction.js';
import type { ModelState } from '../model-lifecycle.js';

function makeModelState(overrides: Partial<ModelState> & { modelName: string }): ModelState {
  return {
    state: ModelLifecycleState.ACTIVE,
    workerId: 'w1',
    runnerHost: null,
    runnerPort: null,
    runnerId: null,
    deviceIndices: null,
    lastInferenceAt: null,
    stateChangedAt: new Date(Date.now() - 120_000).toISOString(),
    errorMessage: null,
    ...overrides,
  };
}

describe('LruEvictionStrategy', () => {
  const strategy = new LruEvictionStrategy();

  it('selects least recently used models first', () => {
    const candidates = [
      {
        modelName: 'b',
        state: ModelLifecycleState.ACTIVE,
        workerId: 'w1',
        memoryBytes: 8e9,
        lastInferenceAt: '2026-01-01T00:02:00Z',
        pinned: false,
      },
      {
        modelName: 'a',
        state: ModelLifecycleState.ACTIVE,
        workerId: 'w1',
        memoryBytes: 8e9,
        lastInferenceAt: '2026-01-01T00:01:00Z',
        pinned: false,
      },
      {
        modelName: 'c',
        state: ModelLifecycleState.ACTIVE,
        workerId: 'w1',
        memoryBytes: 8e9,
        lastInferenceAt: '2026-01-01T00:03:00Z',
        pinned: false,
      },
    ];

    const victims = strategy.selectVictims(candidates, 10e9);
    expect(victims.map((v) => v.modelName)).toEqual(['a', 'b']);
  });

  it('treats null lastInferenceAt as oldest', () => {
    const candidates = [
      {
        modelName: 'a',
        state: ModelLifecycleState.ACTIVE,
        workerId: 'w1',
        memoryBytes: 8e9,
        lastInferenceAt: '2026-01-01T00:01:00Z',
        pinned: false,
      },
      {
        modelName: 'b',
        state: ModelLifecycleState.ACTIVE,
        workerId: 'w1',
        memoryBytes: 8e9,
        lastInferenceAt: null,
        pinned: false,
      },
    ];

    const victims = strategy.selectVictims(candidates, 5e9);
    expect(victims[0].modelName).toBe('b');
  });
});

/** Uniform 8e9-byte memoryByModel map, keyed by each model's modelName — for tests that aren't
 * exercising size-based selection and just need every candidate to have a non-zero size. */
function uniformMemory(models: ModelState[], bytes = 8e9): Map<string, number> {
  return new Map(models.map((m) => [m.modelName, bytes]));
}

describe('EvictionEngine', () => {
  it('excludes pinned models', () => {
    const engine = new EvictionEngine();
    const models: ModelState[] = [
      makeModelState({ modelName: 'pinned-model' }),
      makeModelState({ modelName: 'unpinned-model', lastInferenceAt: '2026-01-01T00:01:00Z' }),
    ];

    const victims = engine.selectVictims(
      models,
      new Set(['pinned-model']),
      8e9,
      undefined,
      uniformMemory(models),
    );
    expect(victims).toHaveLength(1);
    expect(victims[0].modelName).toBe('unpinned-model');
  });

  it('excludes models that are too new (minActiveTimeSecs)', () => {
    const engine = new EvictionEngine(undefined, {
      maxPerCycle: 3,
      minActiveTimeSecs: 300,
      circuitBreakerThreshold: 5,
      circuitBreakerWindowSecs: 60,
    });

    const models: ModelState[] = [
      makeModelState({
        modelName: 'new-model',
        stateChangedAt: new Date().toISOString(),
      }),
    ];

    const victims = engine.selectVictims(models, new Set(), 8e9);
    expect(victims).toHaveLength(0);
  });

  it('respects maxPerCycle limit', () => {
    const engine = new EvictionEngine(undefined, {
      maxPerCycle: 1,
      minActiveTimeSecs: 0,
      circuitBreakerThreshold: 10,
      circuitBreakerWindowSecs: 60,
    });

    const models: ModelState[] = [
      makeModelState({ modelName: 'a', lastInferenceAt: '2026-01-01T00:01:00Z' }),
      makeModelState({ modelName: 'b', lastInferenceAt: '2026-01-01T00:02:00Z' }),
      makeModelState({ modelName: 'c', lastInferenceAt: '2026-01-01T00:03:00Z' }),
    ];

    const victims = engine.selectVictims(
      models,
      new Set(),
      100e9,
      undefined,
      uniformMemory(models),
    );
    expect(victims).toHaveLength(1);
  });

  it('only evicts ACTIVE or SLEEPING models', () => {
    const engine = new EvictionEngine();
    const models: ModelState[] = [
      makeModelState({ modelName: 'active', state: ModelLifecycleState.ACTIVE }),
      makeModelState({ modelName: 'sleeping', state: ModelLifecycleState.SLEEPING }),
      makeModelState({ modelName: 'starting', state: ModelLifecycleState.STARTING }),
      makeModelState({ modelName: 'pending', state: ModelLifecycleState.PENDING }),
    ];

    const victims = engine.selectVictims(
      models,
      new Set(),
      100e9,
      undefined,
      uniformMemory(models),
    );
    const names = victims.map((v) => v.modelName);
    expect(names).toContain('active');
    expect(names).toContain('sleeping');
    expect(names).not.toContain('starting');
    expect(names).not.toContain('pending');
  });

  it('filters by target worker when specified', () => {
    const engine = new EvictionEngine();
    const models: ModelState[] = [
      makeModelState({ modelName: 'on-w1', workerId: 'w1' }),
      makeModelState({ modelName: 'on-w2', workerId: 'w2' }),
    ];

    const victims = engine.selectVictims(
      models,
      new Set(),
      8e9,
      new Set(['w1']),
      uniformMemory(models),
    );
    expect(victims).toHaveLength(1);
    expect(victims[0].modelName).toBe('on-w1');
  });

  it('filters by target worker set with multiple workers', () => {
    const engine = new EvictionEngine();
    const models: ModelState[] = [
      makeModelState({ modelName: 'on-w1', workerId: 'w1' }),
      makeModelState({ modelName: 'on-w2', workerId: 'w2' }),
      makeModelState({ modelName: 'on-w3', workerId: 'w3' }),
    ];

    const victims = engine.selectVictims(
      models,
      new Set(),
      100e9,
      new Set(['w1', 'w2']),
      uniformMemory(models),
    );
    const names = victims.map((v) => v.modelName);
    expect(names).toContain('on-w1');
    expect(names).toContain('on-w2');
    expect(names).not.toContain('on-w3');
  });

  it('excludes candidates with zero or unknown memoryBytes', () => {
    const engine = new EvictionEngine();
    const models: ModelState[] = [
      makeModelState({ modelName: 'zero-size', lastInferenceAt: '2026-01-01T00:01:00Z' }),
      makeModelState({ modelName: 'sized', lastInferenceAt: '2026-01-01T00:02:00Z' }),
    ];
    // memoryByModel omits 'zero-size' entirely — mirrors a stale/missing record, which maps to 0.
    const memoryByModel = new Map([['sized', 8e9]]);

    const victims = engine.selectVictims(models, new Set(), 8e9, undefined, memoryByModel);

    expect(victims.map((v) => v.modelName)).toEqual(['sized']);
  });

  it('selects victims from a mix of zero-size and sized candidates', () => {
    const engine = new EvictionEngine();
    const models: ModelState[] = [
      makeModelState({ modelName: 'zero-size', lastInferenceAt: '2026-01-01T00:01:00Z' }),
      makeModelState({ modelName: 'sized-a', lastInferenceAt: '2026-01-01T00:02:00Z' }),
      makeModelState({ modelName: 'sized-b', lastInferenceAt: '2026-01-01T00:03:00Z' }),
    ];
    const memoryByModel = new Map([
      ['zero-size', 0],
      ['sized-a', 4e9],
      ['sized-b', 4e9],
    ]);

    const victims = engine.selectVictims(models, new Set(), 8e9, undefined, memoryByModel);

    expect(victims.map((v) => v.modelName)).toEqual(['sized-a', 'sized-b']);
  });

  it('returns empty when all candidates have zero memoryBytes', () => {
    const engine = new EvictionEngine();
    const models: ModelState[] = [
      makeModelState({ modelName: 'a', lastInferenceAt: '2026-01-01T00:01:00Z' }),
      makeModelState({ modelName: 'b', lastInferenceAt: '2026-01-01T00:02:00Z' }),
    ];
    const memoryByModel = new Map([
      ['a', 0],
      ['b', 0],
    ]);

    const victims = engine.selectVictims(models, new Set(), 8e9, undefined, memoryByModel);

    expect(victims).toHaveLength(0);
  });

  it('returns empty array when circuit breaker is open', () => {
    const engine = new EvictionEngine(undefined, {
      maxPerCycle: 3,
      minActiveTimeSecs: 0,
      circuitBreakerThreshold: 2,
      circuitBreakerWindowSecs: 60,
    });

    engine.recordEviction('test');
    engine.recordEviction('test');

    const models: ModelState[] = [makeModelState({ modelName: 'a' })];

    const victims = engine.selectVictims(models, new Set(), 8e9);
    expect(victims).toHaveLength(0);
  });
});
