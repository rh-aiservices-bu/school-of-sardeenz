import { describe, it, expect } from 'vitest';
import { ModelLifecycleState } from '@sardeenz/types';
import { groupWorkerPlacement, isClusterEmpty, type MemoryWorker } from '../../utils/placement';

function device(deviceIndex: number) {
  return {
    deviceIndex,
    deviceType: 'CUDA',
    memoryTotalBytes: 1000,
    memoryUsedBytes: 500,
    memoryAvailableBytes: 500,
  };
}

describe('groupWorkerPlacement', () => {
  it('places single-device models under the matching GPU', () => {
    const worker: MemoryWorker = {
      workerId: 'w1',
      status: 'ONLINE',
      devices: [device(0), device(1)],
      models: [
        { modelName: 'model-a', state: ModelLifecycleState.ACTIVE, deviceIndices: [0] },
        { modelName: 'model-b', state: ModelLifecycleState.ACTIVE, deviceIndices: [1] },
      ],
    } as unknown as MemoryWorker;

    const placement = groupWorkerPlacement(worker);

    expect(placement.byDevice.find((d) => d.deviceIndex === 0)?.models.map((m) => m.modelName)).toEqual([
      'model-a',
    ]);
    expect(placement.byDevice.find((d) => d.deviceIndex === 1)?.models.map((m) => m.modelName)).toEqual([
      'model-b',
    ]);
    expect(placement.tensorParallel).toEqual([]);
    expect(placement.unplaced).toEqual([]);
    expect(placement.placementUntracked).toBe(false);
  });

  it('groups a tensor-parallel model once, not repeated per device', () => {
    const worker: MemoryWorker = {
      workerId: 'w1',
      status: 'ONLINE',
      devices: [device(0), device(1)],
      models: [
        { modelName: 'model-tp', state: ModelLifecycleState.ACTIVE, deviceIndices: [0, 1] },
      ],
    } as unknown as MemoryWorker;

    const placement = groupWorkerPlacement(worker);

    expect(placement.tensorParallel.map((m) => m.modelName)).toEqual(['model-tp']);
    expect(placement.byDevice.every((d) => d.models.length === 0)).toBe(true);
    expect(placement.unplaced).toEqual([]);
  });

  it('groups a model with no deviceIndices as unplaced when the worker has other attribution', () => {
    const worker: MemoryWorker = {
      workerId: 'w1',
      status: 'ONLINE',
      devices: [device(0)],
      models: [
        { modelName: 'model-a', state: ModelLifecycleState.ACTIVE, deviceIndices: [0] },
        { modelName: 'model-legacy', state: ModelLifecycleState.ACTIVE },
      ],
    } as unknown as MemoryWorker;

    const placement = groupWorkerPlacement(worker);

    expect(placement.unplaced.map((m) => m.modelName)).toEqual(['model-legacy']);
    expect(placement.placementUntracked).toBe(false);
  });

  it('marks the worker placementUntracked when no model has deviceIndices', () => {
    const worker: MemoryWorker = {
      workerId: 'w1',
      status: 'ONLINE',
      devices: [device(0)],
      models: [
        { modelName: 'model-legacy-a', state: ModelLifecycleState.ACTIVE },
        { modelName: 'model-legacy-b', state: ModelLifecycleState.SLEEPING },
      ],
    } as unknown as MemoryWorker;

    const placement = groupWorkerPlacement(worker);

    expect(placement.placementUntracked).toBe(true);
    expect(placement.unplaced).toEqual([]);
  });

  it('leaves byDevice entries empty for devices with no placed models', () => {
    const worker: MemoryWorker = {
      workerId: 'w1',
      status: 'ONLINE',
      devices: [device(0), device(1)],
      models: [{ modelName: 'model-a', state: ModelLifecycleState.ACTIVE, deviceIndices: [0] }],
    } as unknown as MemoryWorker;

    const placement = groupWorkerPlacement(worker);

    expect(placement.byDevice.find((d) => d.deviceIndex === 1)?.models).toEqual([]);
  });
});

describe('isClusterEmpty', () => {
  it('is true for undefined memory', () => {
    expect(isClusterEmpty(undefined)).toBe(true);
  });

  it('is true for a cluster with no workers', () => {
    expect(isClusterEmpty({ workers: [], summary: {} } as never)).toBe(true);
  });

  it('is false when at least one worker is present', () => {
    expect(
      isClusterEmpty({
        workers: [{ workerId: 'w1', status: 'ONLINE', devices: [], models: [] }],
        summary: {},
      } as never),
    ).toBe(false);
  });
});
