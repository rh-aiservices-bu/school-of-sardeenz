/**
 * Pure-logic tests for ModelsPlacementPanel's attribution/bar-data helpers (#163 — v1
 * GpuMemoryPanel port). Kept separate from the component per the project's established
 * convention of testing logic directly rather than rendering PatternFly/nivo.
 */
import { describe, it, expect } from 'vitest';
import { ModelLifecycleState, type ControlPlaneComponents } from '@sardeenz/types';
import {
  attributeModelsToDevice,
  buildDeviceBarData,
  buildKvcacheData,
  summarizeWorkerVram,
  SLEEPING_PATTERN_ID,
  KVCACHE_COLORS,
} from '../../utils/gpuMemoryPanel';

type DeviceInfo = ControlPlaneComponents['schemas']['DeviceInfo'];
type WorkerModelInfo = ControlPlaneComponents['schemas']['WorkerModelInfo'];

function makeDevice(overrides?: Partial<DeviceInfo>): DeviceInfo {
  return {
    deviceIndex: 0,
    deviceType: 'CUDA',
    memoryTotalBytes: 16 * 1024 ** 3,
    memoryUsedBytes: 8 * 1024 ** 3,
    memoryAvailableBytes: 8 * 1024 ** 3,
    ...overrides,
  };
}

function makeModel(overrides?: Partial<WorkerModelInfo>): WorkerModelInfo {
  return {
    modelName: 'llama-3-8b',
    state: ModelLifecycleState.ACTIVE,
    ...overrides,
  };
}

describe('attributeModelsToDevice', () => {
  it('attributes a model to the device it names via deviceIndices', () => {
    const device = makeDevice({ deviceIndex: 1 });
    const models = [
      makeModel({ deviceIndices: [1], memoryUsedBytes: 4 * 1024 ** 3 }),
      makeModel({ modelName: 'other', deviceIndices: [0], memoryUsedBytes: 2 * 1024 ** 3 }),
    ];
    const attributed = attributeModelsToDevice(device, 2, models);
    expect(attributed).toHaveLength(1);
    expect(attributed[0].modelName).toBe('llama-3-8b');
    expect(attributed[0].bytes).toBe(4 * 1024 ** 3);
  });

  it('splits a tensor-parallel model evenly across the devices it names', () => {
    const device = makeDevice({ deviceIndex: 0 });
    const models = [makeModel({ deviceIndices: [0, 1], memoryUsedBytes: 8 * 1024 ** 3 })];
    const attributed = attributeModelsToDevice(device, 2, models);
    expect(attributed[0].bytes).toBe(4 * 1024 ** 3);
  });

  it('falls back to attributing every model when the worker has exactly one device and no model carries deviceIndices', () => {
    const device = makeDevice();
    const models = [makeModel({ memoryUsedBytes: 3 * 1024 ** 3 })];
    const attributed = attributeModelsToDevice(device, 1, models);
    expect(attributed).toHaveLength(1);
  });

  it('attributes nothing when the worker has multiple devices and no model carries deviceIndices', () => {
    const device = makeDevice();
    const models = [makeModel({ memoryUsedBytes: 3 * 1024 ** 3 })];
    const attributed = attributeModelsToDevice(device, 2, models);
    expect(attributed).toHaveLength(0);
  });

  it('returns an empty array when there are no models', () => {
    expect(attributeModelsToDevice(makeDevice(), 1, undefined)).toEqual([]);
    expect(attributeModelsToDevice(makeDevice(), 1, [])).toEqual([]);
  });

  it('marks a SLEEPING model as sleeping and builds a unique key from instanceId', () => {
    const device = makeDevice();
    const models = [
      makeModel({ instanceId: 'inst-a', state: ModelLifecycleState.SLEEPING }),
      makeModel({ instanceId: 'inst-b', state: ModelLifecycleState.ACTIVE }),
    ];
    const attributed = attributeModelsToDevice(device, 1, models);
    const sleeping = attributed.find((m) => m.instanceId === 'inst-a');
    const active = attributed.find((m) => m.instanceId === 'inst-b');
    expect(sleeping?.sleeping).toBe(true);
    expect(sleeping?.key).toBe('llama-3-8b#inst-a');
    expect(active?.sleeping).toBe(false);
  });
});

describe('buildDeviceBarData', () => {
  it('assigns Other to used bytes not accounted for by any attributed model', () => {
    const device = makeDevice({ memoryUsedBytes: 8 * 1024 ** 3 });
    const attributed = attributeModelsToDevice(device, 1, [
      makeModel({ memoryUsedBytes: 5 * 1024 ** 3 }),
    ]);
    const bar = buildDeviceBarData(device, attributed);
    expect(bar.otherBytes).toBe(3 * 1024 ** 3);
    expect(bar.keys).toContain('Other');
  });

  it('clamps Other to 0 when attributed models exceed the device used bytes (never negative)', () => {
    const device = makeDevice({ memoryUsedBytes: 4 * 1024 ** 3 });
    const attributed = attributeModelsToDevice(device, 1, [
      makeModel({ memoryUsedBytes: 10 * 1024 ** 3 }),
    ]);
    const bar = buildDeviceBarData(device, attributed);
    expect(bar.otherBytes).toBe(0);
    expect(bar.keys).not.toContain('Other');
  });

  it('computes Free as total minus used, clamped to 0', () => {
    const device = makeDevice({
      memoryTotalBytes: 16 * 1024 ** 3,
      memoryUsedBytes: 16 * 1024 ** 3,
    });
    const bar = buildDeviceBarData(device, []);
    expect(bar.freeBytes).toBe(0);

    const device2 = makeDevice({
      memoryTotalBytes: 16 * 1024 ** 3,
      memoryUsedBytes: 6 * 1024 ** 3,
    });
    const bar2 = buildDeviceBarData(device2, []);
    expect(bar2.freeBytes).toBe(10 * 1024 ** 3);
  });

  it('omits models with 0 attributed bytes from the rendered entries', () => {
    const device = makeDevice();
    const attributed = attributeModelsToDevice(device, 1, [
      makeModel({ modelName: 'zero-model', memoryUsedBytes: 0 }),
      makeModel({ modelName: 'real-model', memoryUsedBytes: 2 * 1024 ** 3 }),
    ]);
    const bar = buildDeviceBarData(device, attributed);
    expect(bar.entries.map((e) => e.modelName)).toEqual(['real-model']);
  });

  it('adds a sleeping-pattern fill entry for sleeping models only', () => {
    const device = makeDevice();
    const attributed = attributeModelsToDevice(device, 1, [
      makeModel({
        modelName: 'sleepy',
        instanceId: 'i1',
        state: ModelLifecycleState.SLEEPING,
        memoryUsedBytes: 2 * 1024 ** 3,
      }),
      makeModel({
        modelName: 'awake',
        instanceId: 'i2',
        state: ModelLifecycleState.ACTIVE,
        memoryUsedBytes: 2 * 1024 ** 3,
      }),
    ]);
    const bar = buildDeviceBarData(device, attributed);
    expect(bar.fill).toHaveLength(1);
    expect(bar.fill[0].id).toBe(SLEEPING_PATTERN_ID);
    expect(bar.fill[0].match.id).toBe('sleepy#i1');
  });

  it('orders entries by modelName then instanceId for stable rendering', () => {
    const device = makeDevice();
    const attributed = attributeModelsToDevice(device, 1, [
      makeModel({ modelName: 'b-model', instanceId: 'x', memoryUsedBytes: 1024 }),
      makeModel({ modelName: 'a-model', instanceId: 'y', memoryUsedBytes: 1024 }),
    ]);
    const bar = buildDeviceBarData(device, attributed);
    expect(bar.entries.map((e) => e.modelName)).toEqual(['a-model', 'b-model']);
  });

  it('every model gets a distinct color key mapped in bar.colors', () => {
    const device = makeDevice();
    const attributed = attributeModelsToDevice(device, 1, [
      makeModel({ modelName: 'model-a', memoryUsedBytes: 1024 }),
    ]);
    const bar = buildDeviceBarData(device, attributed);
    expect(bar.colors['model-a']).toBeDefined();
    expect(bar.colors['Free']).toBeDefined();
  });
});

describe('buildKvcacheData (issue #165)', () => {
  const kvCache = {
    totalBytes: 12 * 1024 ** 3,
    usedBytes: 5 * 1024 ** 3,
    preallocBytes: 1 * 1024 ** 3,
    freeBytes: 6 * 1024 ** 3,
  };

  it('builds the single-row Prealloc/Used/Free dataset from the device kvCache block', () => {
    const bar = buildKvcacheData(makeDevice({ kvCache }), true);
    expect(bar).not.toBeNull();
    expect(bar!.data).toEqual([
      { id: 'KVCache', Prealloc: kvCache.preallocBytes, Used: kvCache.usedBytes, Free: kvCache.freeBytes },
    ]);
    expect(bar!.keys).toEqual(['Prealloc', 'Used', 'Free']);
    expect(bar!.totalBytes).toBe(kvCache.totalBytes);
  });

  it('returns null when the device has no kvCache block (absent means absent)', () => {
    expect(buildKvcacheData(makeDevice(), true)).toBeNull();
  });

  it('returns null when the pool has no capacity (totalBytes 0)', () => {
    expect(buildKvcacheData(makeDevice({ kvCache: { ...kvCache, totalBytes: 0 } }), true)).toBeNull();
  });

  it('returns null when the worker has no models (v1 guard: a pool with nothing serving is not rendered)', () => {
    expect(buildKvcacheData(makeDevice({ kvCache }), false)).toBeNull();
  });

  it('exposes the v1 segment colors for the sub-bar legend', () => {
    expect(KVCACHE_COLORS).toEqual({ Prealloc: '#F0AB00', Used: '#0066CC', Free: '#6A6E73' });
  });
});

describe('summarizeWorkerVram', () => {
  it('computes the rounded used percent across all devices', () => {
    const devices = [
      makeDevice({
        deviceIndex: 0,
        memoryTotalBytes: 8 * 1024 ** 3,
        memoryUsedBytes: 4 * 1024 ** 3,
      }),
      makeDevice({
        deviceIndex: 1,
        memoryTotalBytes: 8 * 1024 ** 3,
        memoryUsedBytes: 8 * 1024 ** 3,
      }),
    ];
    const { usedPercent, totalBytes, usedBytes } = summarizeWorkerVram(devices);
    expect(totalBytes).toBe(16 * 1024 ** 3);
    expect(usedBytes).toBe(12 * 1024 ** 3);
    expect(usedPercent).toBe(75);
  });

  it('returns 0% for a worker with no devices (divide-by-zero guard)', () => {
    expect(summarizeWorkerVram([]).usedPercent).toBe(0);
  });
});
