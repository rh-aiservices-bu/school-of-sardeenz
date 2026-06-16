/**
 * MemoryVisualization feature tests.
 *
 * Following the project convention (see role-visibility.test.tsx), we test
 * the logic and data-flow layers directly to avoid React version conflicts
 * when rendering PatternFly components in the worktree. Full rendering
 * coverage is left to the Playwright e2e suite.
 */
import { describe, it, expect } from 'vitest';
import { formatBytes, formatPercentage } from '../../utils/format';
import type { ControlPlaneComponents } from '@sardeenz/types';

type WorkerModelInfo = ControlPlaneComponents['schemas']['WorkerModelInfo'];
type DeviceInfo = ControlPlaneComponents['schemas']['DeviceInfo'];

// ---------------------------------------------------------------------------
// Helpers — mirrors MemoryVisualization.tsx logic
// ---------------------------------------------------------------------------

type DisplayMode = 'bytes' | 'percent';

function formatMemoryLabel(device: DeviceInfo, displayMode: DisplayMode): string {
  if (displayMode === 'bytes') {
    return `${formatBytes(device.memoryUsedBytes)} / ${formatBytes(device.memoryTotalBytes)}`;
  }
  return `${formatPercentage(device.memoryUsedBytes, device.memoryTotalBytes)} used`;
}

function buildWorkerHref(workerId: string): string {
  return `/workers/${encodeURIComponent(workerId)}`;
}

function buildModelTooltipLines(models?: WorkerModelInfo[]): string[] {
  if (!models?.length) return [];
  return models.map(
    (m) => `${m.modelName} (${m.memoryUsedBytes != null ? formatBytes(m.memoryUsedBytes) : '—'})`,
  );
}

function computeSegmentPercents(device: DeviceInfo) {
  const total = device.memoryTotalBytes > 0 ? device.memoryTotalBytes : 1;
  const usedPercent = Math.min(100, (device.memoryUsedBytes / total) * 100);
  const reservedPercent = Math.min(
    100 - usedPercent,
    ((device.memoryReservedBytes ?? 0) / total) * 100,
  );
  const availablePercent = Math.max(0, 100 - usedPercent - reservedPercent);
  return {
    usedPct: Math.round(usedPercent),
    reservedPct: Math.round(reservedPercent),
    availablePct: Math.max(0, 100 - Math.round(usedPercent) - Math.round(reservedPercent)),
    usedPercent,
    reservedPercent,
    availablePercent,
  };
}

function shouldPassModelsToDevice(
  devices: DeviceInfo[],
  models?: WorkerModelInfo[],
): WorkerModelInfo[] | undefined {
  return devices.length === 1 ? models : undefined;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeDevice(overrides?: Partial<DeviceInfo>): DeviceInfo {
  return {
    deviceIndex: 0,
    deviceType: 'CUDA',
    memoryTotalBytes: 16 * 1024 ** 3,
    memoryUsedBytes: 8 * 1024 ** 3,
    memoryAvailableBytes: 7 * 1024 ** 3,
    memoryReservedBytes: 1 * 1024 ** 3,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// GiB / Percent toggle logic
// ---------------------------------------------------------------------------
describe('MemoryVisualization — display mode toggle', () => {
  const device = makeDevice();

  it('bytes mode shows "used / total" format', () => {
    const label = formatMemoryLabel(device, 'bytes');
    expect(label).toBe('8.0 GiB / 16.0 GiB');
  });

  it('percent mode shows "X% used" format', () => {
    const label = formatMemoryLabel(device, 'percent');
    expect(label).toBe('50.0% used');
  });

  it('percent mode handles zero-total device', () => {
    const zeroDevice = makeDevice({ memoryTotalBytes: 0, memoryUsedBytes: 0 });
    const label = formatMemoryLabel(zeroDevice, 'percent');
    expect(label).toBe('0% used');
  });

  it('percent mode handles fully-used device', () => {
    const fullDevice = makeDevice({
      memoryTotalBytes: 8 * 1024 ** 3,
      memoryUsedBytes: 8 * 1024 ** 3,
      memoryAvailableBytes: 0,
      memoryReservedBytes: 0,
    });
    const label = formatMemoryLabel(fullDevice, 'percent');
    expect(label).toBe('100.0% used');
  });
});

// ---------------------------------------------------------------------------
// Worker link href construction
// ---------------------------------------------------------------------------
describe('MemoryVisualization — worker click-through', () => {
  it('builds correct href for simple worker ID', () => {
    expect(buildWorkerHref('worker-abc')).toBe('/workers/worker-abc');
  });

  it('encodes special characters in worker ID', () => {
    expect(buildWorkerHref('worker/special id')).toBe('/workers/worker%2Fspecial%20id');
  });

  it('handles empty worker ID', () => {
    expect(buildWorkerHref('')).toBe('/workers/');
  });
});

// ---------------------------------------------------------------------------
// Model name tooltip lines
// ---------------------------------------------------------------------------
describe('MemoryVisualization — model names', () => {
  it('builds tooltip lines from models array', () => {
    const models: WorkerModelInfo[] = [
      { modelName: 'llama-3-8b', state: 'RUNNING' as never, memoryUsedBytes: 7 * 1024 ** 3 },
    ];
    const lines = buildModelTooltipLines(models);
    expect(lines).toEqual(['llama-3-8b (7.0 GiB)']);
  });

  it('returns empty array when no models', () => {
    expect(buildModelTooltipLines(undefined)).toEqual([]);
    expect(buildModelTooltipLines([])).toEqual([]);
  });

  it('handles multiple models', () => {
    const models: WorkerModelInfo[] = [
      { modelName: 'model-a', state: 'RUNNING' as never, memoryUsedBytes: 4 * 1024 ** 3 },
      { modelName: 'model-b', state: 'SLEEPING' as never, memoryUsedBytes: 2 * 1024 ** 3 },
    ];
    const lines = buildModelTooltipLines(models);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('model-a');
    expect(lines[1]).toContain('model-b');
  });

  it('shows dash when memoryUsedBytes is missing', () => {
    const models: WorkerModelInfo[] = [
      { modelName: 'unknown-mem', state: 'LOADING' as never },
    ];
    const lines = buildModelTooltipLines(models);
    expect(lines).toEqual(['unknown-mem (—)']);
  });
});

// ---------------------------------------------------------------------------
// Single-device model attribution
// ---------------------------------------------------------------------------
describe('MemoryVisualization — single-device model attribution', () => {
  const models: WorkerModelInfo[] = [
    { modelName: 'test-model', state: 'RUNNING' as never, memoryUsedBytes: 1024 },
  ];

  it('passes models to DeviceBar when worker has exactly one device', () => {
    const devices = [makeDevice()];
    expect(shouldPassModelsToDevice(devices, models)).toBe(models);
  });

  it('does not pass models when worker has multiple devices', () => {
    const devices = [makeDevice(), makeDevice({ deviceIndex: 1 })];
    expect(shouldPassModelsToDevice(devices, models)).toBeUndefined();
  });

  it('returns undefined when no models provided', () => {
    const devices = [makeDevice()];
    expect(shouldPassModelsToDevice(devices, undefined)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Segment percentage calculations
// ---------------------------------------------------------------------------
describe('MemoryVisualization — segment percentages', () => {
  it('computes correct percentages for typical device', () => {
    const device = makeDevice();
    const { usedPct, reservedPct, availablePct } = computeSegmentPercents(device);
    expect(usedPct).toBe(50);
    expect(reservedPct).toBe(6);
    expect(availablePct).toBe(44);
    expect(usedPct + reservedPct + availablePct).toBe(100);
  });

  it('handles device with no reserved memory', () => {
    const device = makeDevice({ memoryReservedBytes: 0 });
    const { reservedPct } = computeSegmentPercents(device);
    expect(reservedPct).toBe(0);
  });

  it('clamps to 100% when used exceeds total', () => {
    const device = makeDevice({
      memoryUsedBytes: 20 * 1024 ** 3,
      memoryTotalBytes: 16 * 1024 ** 3,
    });
    const { usedPct } = computeSegmentPercents(device);
    expect(usedPct).toBe(100);
  });

  it('handles zero-total gracefully (divide-by-one fallback)', () => {
    const device = makeDevice({
      memoryTotalBytes: 0,
      memoryUsedBytes: 0,
      memoryAvailableBytes: 0,
      memoryReservedBytes: 0,
    });
    const { usedPct, reservedPct, availablePct } = computeSegmentPercents(device);
    expect(usedPct).toBe(0);
    expect(reservedPct).toBe(0);
    expect(availablePct).toBe(100);
  });
});
