import { describe, it, expect } from 'vitest';
import { ModelLifecycleState } from '@sardeenz/types';
import type { ClusterMemory, ModelInfo } from '../../../api/client';
import {
  compareKeys,
  compositeKey,
  deployableModels,
  filterModels,
  gpuKeyForDevices,
  groupKeys,
  groupModels,
  MULTI_GPU_KEY,
  UNKNOWN_GPU_KEY,
  UNKNOWN_WORKER_KEY,
  workerKey,
} from '../../../pages/Playground/sidebarGroups';

const model = (
  modelName: string,
  extra: Partial<ModelInfo> = {},
  state = ModelLifecycleState.ACTIVE,
): ModelInfo => ({
  modelName,
  state,
  runnerType: 'vllm',
  instanceCount: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  ...extra,
});

const memory = (
  workers: { workerId: string; models: { modelName: string; deviceIndices?: number[] }[] }[],
): ClusterMemory => ({
  workers: workers.map((w) => ({
    workerId: w.workerId,
    devices: [],
    models: w.models.map((m) => ({ ...m, state: ModelLifecycleState.ACTIVE })),
  })),
  summary: { totalBytes: 0, usedBytes: 0, availableBytes: 0 },
});

describe('sidebarGroups', () => {
  it('deployableModels keeps ACTIVE and SLEEPING only', () => {
    const models = [
      model('a'),
      model('b', {}, ModelLifecycleState.SLEEPING),
      model('c', {}, ModelLifecycleState.STARTING),
      model('d', {}, ModelLifecycleState.STOPPED),
    ];
    expect(deployableModels(models).map((m) => m.modelName)).toEqual(['a', 'b']);
  });

  it('filterModels matches configuration name and display name, case-insensitively', () => {
    const models = [model('llama-8b', { displayName: 'Llama 3' }), model('mistral')];
    expect(filterModels(models, '').length).toBe(2);
    expect(filterModels(models, 'LLAMA 3').map((m) => m.modelName)).toEqual(['llama-8b']);
    expect(filterModels(models, 'mist').map((m) => m.modelName)).toEqual(['mistral']);
    expect(filterModels(models, 'zzz')).toEqual([]);
  });

  it('gpuKeyForDevices maps device lists to keys', () => {
    expect(gpuKeyForDevices(undefined)).toBe(UNKNOWN_GPU_KEY);
    expect(gpuKeyForDevices([])).toBe(UNKNOWN_GPU_KEY);
    expect(gpuKeyForDevices([2])).toBe('gpu-2');
    expect(gpuKeyForDevices([0, 1])).toBe(MULTI_GPU_KEY);
  });

  it('compareKeys sorts numerically with multi-gpu then unknown last', () => {
    const keys = [UNKNOWN_GPU_KEY, 'gpu-10', MULTI_GPU_KEY, 'gpu-2', 'gpu-0'];
    expect([...keys].sort(compareKeys)).toEqual([
      'gpu-0',
      'gpu-2',
      'gpu-10',
      MULTI_GPU_KEY,
      UNKNOWN_GPU_KEY,
    ]);
  });

  it('single worker: flat GPU groups from the memory report', () => {
    const models = [model('a'), model('b'), model('tp')];
    const grouping = groupModels(
      models,
      memory([
        {
          workerId: 'w1',
          models: [
            { modelName: 'a', deviceIndices: [1] },
            { modelName: 'b', deviceIndices: [0] },
            { modelName: 'tp', deviceIndices: [0, 1] },
          ],
        },
      ]),
    );
    expect(grouping.isClusterMode).toBe(false);
    expect(Array.from(grouping.byGpu.keys())).toEqual(['gpu-0', 'gpu-1', MULTI_GPU_KEY]);
    expect(grouping.byGpu.get('gpu-0')?.map((m) => m.modelName)).toEqual(['b']);
    expect(groupKeys(grouping)).toEqual(['gpu-0', 'gpu-1', MULTI_GPU_KEY]);
  });

  it('falls back to workerIds and the unplaced group without a memory entry', () => {
    const models = [model('a', { workerIds: ['w1'] }), model('orphan')];
    const grouping = groupModels(models, undefined);
    expect(grouping.isClusterMode).toBe(true);
    expect(Array.from(grouping.byWorker.keys())).toEqual(['w1', UNKNOWN_WORKER_KEY]);
    expect(
      grouping.byWorker
        .get('w1')
        ?.get(UNKNOWN_GPU_KEY)
        ?.map((m) => m.modelName),
    ).toEqual(['a']);
  });

  it('multiple workers: two-level worker → GPU grouping with composite keys', () => {
    const models = [model('a'), model('b')];
    const grouping = groupModels(
      models,
      memory([
        { workerId: 'w2', models: [{ modelName: 'b', deviceIndices: [0] }] },
        {
          workerId: 'w1',
          models: [
            { modelName: 'a', deviceIndices: [0] },
            { modelName: 'b', deviceIndices: [1] },
          ],
        },
      ]),
    );
    expect(grouping.isClusterMode).toBe(true);
    expect(grouping.byGpu.size).toBe(0);
    expect(Array.from(grouping.byWorker.keys())).toEqual(['w1', 'w2']);
    expect(groupKeys(grouping)).toEqual([
      workerKey('w1'),
      compositeKey('w1', 'gpu-0'),
      compositeKey('w1', 'gpu-1'),
      workerKey('w2'),
      compositeKey('w2', 'gpu-0'),
    ]);
  });

  it('dedupes a model with several instances on the same worker and GPU', () => {
    const grouping = groupModels(
      [model('a', { instanceCount: 2 })],
      memory([
        {
          workerId: 'w1',
          models: [
            { modelName: 'a', deviceIndices: [0] },
            { modelName: 'a', deviceIndices: [0] },
          ],
        },
      ]),
    );
    expect(grouping.byGpu.get('gpu-0')?.length).toBe(1);
  });
});
