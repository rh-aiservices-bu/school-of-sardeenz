import { describe, it, expect } from 'vitest';
import { ModelLifecycleState } from '@sardeenz/types';
import { updateModelListData } from '../../hooks/useModels';
import type { ModelInfo } from '../../api/client';

const existing: ModelInfo = {
  modelName: 'existing',
  state: ModelLifecycleState.ACTIVE,
  runnerType: 'vllm',
  instanceCount: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
};

const appendPending = (models: ModelInfo[]): ModelInfo[] => [
  ...models,
  {
    modelName: 'new-model',
    state: ModelLifecycleState.PENDING,
    runnerType: 'vllm',
    instanceCount: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
  },
];

describe('updateModelListData', () => {
  it('applies the updater to list-shaped cache entries', () => {
    const result = updateModelListData({ models: [existing] }, appendPending);
    expect(result?.models.map((m) => m.modelName)).toEqual(['existing', 'new-model']);
  });

  it('preserves other fields on the list entry (e.g. redis-fallback marker)', () => {
    const old = { models: [existing], source: 'redis-fallback' } as never;
    const result = updateModelListData(old, appendPending) as { source?: string };
    expect(result.source).toBe('redis-fallback');
  });

  // Regression: the ['models'] prefix also matches ['models', name] detail queries whose data is a
  // single ModelDetail with no `.models` array. Spreading that undefined threw "models is not
  // iterable"; such entries must be returned untouched.
  it('leaves a detail-shaped entry (no models array) untouched and does not throw', () => {
    const detail = { modelName: 'existing', state: ModelLifecycleState.ACTIVE } as never;
    const result = updateModelListData(detail, appendPending);
    expect(result).toBe(detail);
  });

  it('passes through undefined', () => {
    expect(updateModelListData(undefined, appendPending)).toBeUndefined();
  });
});
