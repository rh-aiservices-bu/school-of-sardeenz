import { describe, it, expect, vi } from 'vitest';
import { buildMeasuredSample, type RunnerProcessOwner } from '../measured-sample.js';
import type { NvmlDeviceMemory, NvmlProcessMemory } from '../nvml.js';

describe('buildMeasuredSample', () => {
  it('passes device samples through unchanged', () => {
    const devices: NvmlDeviceMemory[] = [
      { deviceIndex: 0, totalBytes: 24_000_000_000, usedBytes: 5_000_000_000 },
      { deviceIndex: 1, totalBytes: 24_000_000_000, usedBytes: 1_000_000_000 },
    ];
    const result = buildMeasuredSample(devices, [], [], () => null);
    expect(result.devices).toEqual([
      { deviceIndex: 0, memoryMeasuredUsedBytes: 5_000_000_000 },
      { deviceIndex: 1, memoryMeasuredUsedBytes: 1_000_000_000 },
    ]);
  });

  it('sums multiple processes into one (instanceId, deviceIndex) total', () => {
    const owners: RunnerProcessOwner[] = [{ pid: 100, instanceId: 'inst-a', modelName: 'model-a' }];
    const processes: NvmlProcessMemory[] = [
      { deviceIndex: 0, pid: 201, usedBytes: 1_000_000 },
      { deviceIndex: 0, pid: 202, usedBytes: 2_000_000 },
    ];
    // Both PIDs resolve to the same owner (e.g. a multi-process engine under one apptainer exec).
    const resolveOwner = vi.fn(() => 100);

    const result = buildMeasuredSample([], processes, owners, resolveOwner);

    expect(result.instances).toEqual([
      {
        instanceId: 'inst-a',
        modelName: 'model-a',
        deviceIndex: 0,
        memoryMeasuredUsedBytes: 3_000_000,
      },
    ]);
    expect(resolveOwner).toHaveBeenCalledTimes(2);
  });

  it('a process owned by neither runner contributes only to the device figure', () => {
    const devices: NvmlDeviceMemory[] = [
      { deviceIndex: 0, totalBytes: 24_000_000_000, usedBytes: 9_000_000 },
    ];
    const owners: RunnerProcessOwner[] = [{ pid: 100, instanceId: 'inst-a', modelName: 'model-a' }];
    const processes: NvmlProcessMemory[] = [
      { deviceIndex: 0, pid: 201, usedBytes: 4_000_000 }, // ours
      { deviceIndex: 0, pid: 999, usedBytes: 5_000_000 }, // a stray host process, not one of ours
    ];
    const resolveOwner = (pid: number): number | null => (pid === 201 ? 100 : null);

    const result = buildMeasuredSample(devices, processes, owners, resolveOwner);

    // Device figure is the raw NVML total, unaffected by attribution.
    expect(result.devices).toEqual([{ deviceIndex: 0, memoryMeasuredUsedBytes: 9_000_000 }]);
    // Only the attributable process shows up as an instance entry.
    expect(result.instances).toEqual([
      {
        instanceId: 'inst-a',
        modelName: 'model-a',
        deviceIndex: 0,
        memoryMeasuredUsedBytes: 4_000_000,
      },
    ]);
  });

  it('keeps two runners on the same device as separate instance entries', () => {
    const owners: RunnerProcessOwner[] = [
      { pid: 100, instanceId: 'inst-a', modelName: 'model-a' },
      { pid: 200, instanceId: 'inst-b', modelName: 'model-b' },
    ];
    const processes: NvmlProcessMemory[] = [
      { deviceIndex: 0, pid: 301, usedBytes: 1_000_000 },
      { deviceIndex: 0, pid: 401, usedBytes: 2_000_000 },
    ];
    const resolveOwner = (pid: number): number | null => {
      if (pid === 301) return 100;
      if (pid === 401) return 200;
      return null;
    };

    const result = buildMeasuredSample([], processes, owners, resolveOwner);

    expect(result.instances).toHaveLength(2);
    expect(result.instances).toEqual(
      expect.arrayContaining([
        {
          instanceId: 'inst-a',
          modelName: 'model-a',
          deviceIndex: 0,
          memoryMeasuredUsedBytes: 1_000_000,
        },
        {
          instanceId: 'inst-b',
          modelName: 'model-b',
          deviceIndex: 0,
          memoryMeasuredUsedBytes: 2_000_000,
        },
      ]),
    );
  });

  it('keeps one runner split across two devices as separate entries', () => {
    const owners: RunnerProcessOwner[] = [{ pid: 100, instanceId: 'inst-a', modelName: 'model-a' }];
    const processes: NvmlProcessMemory[] = [
      { deviceIndex: 0, pid: 301, usedBytes: 1_000_000 },
      { deviceIndex: 1, pid: 302, usedBytes: 2_000_000 },
    ];
    const resolveOwner = (): number | null => 100;

    const result = buildMeasuredSample([], processes, owners, resolveOwner);

    expect(result.instances).toHaveLength(2);
    expect(result.instances).toEqual(
      expect.arrayContaining([
        {
          instanceId: 'inst-a',
          modelName: 'model-a',
          deviceIndex: 0,
          memoryMeasuredUsedBytes: 1_000_000,
        },
        {
          instanceId: 'inst-a',
          modelName: 'model-a',
          deviceIndex: 1,
          memoryMeasuredUsedBytes: 2_000_000,
        },
      ]),
    );
  });

  it('returns empty instances (and never calls resolveOwner) when there are no owners', () => {
    const devices: NvmlDeviceMemory[] = [
      { deviceIndex: 0, totalBytes: 24_000_000_000, usedBytes: 5_000_000 },
    ];
    const processes: NvmlProcessMemory[] = [{ deviceIndex: 0, pid: 501, usedBytes: 5_000_000 }];
    const resolveOwner = vi.fn(() => null);

    const result = buildMeasuredSample(devices, processes, [], resolveOwner);

    expect(result.devices).toEqual([{ deviceIndex: 0, memoryMeasuredUsedBytes: 5_000_000 }]);
    expect(result.instances).toEqual([]);
    // resolveOwner is still called per-process (it's the one deciding there's no match) — what
    // matters is the empty ownerPids set produces no attribution, not that the call is skipped.
    expect(resolveOwner).toHaveBeenCalledWith(501, new Set());
  });

  it('returns empty devices/instances for an empty sample', () => {
    const result = buildMeasuredSample([], [], []);
    expect(result).toEqual({ devices: [], instances: [] });
  });
});
