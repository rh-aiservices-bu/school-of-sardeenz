/**
 * ModelList memory-column logic (#163).
 *
 * Following the project convention (see MemoryVisualization.test.tsx), we test the
 * pure logic that drives the memory cell and sort comparator directly, rather than
 * rendering the PatternFly table (see the dual-React test limitation noted in M8).
 * `currentMemory` is now a real NVML measurement that is ABSENT (not 0) when the
 * model isn't running or the worker can't measure it — 0 is a legitimate measured
 * value (e.g. a sleeping model) and must render differently from "no measurement".
 */
import { describe, it, expect } from 'vitest';
import { formatBytes } from '../../utils/format';

// Mirrors the per-row memory cell logic in ModelList.tsx.
function memoryCellText(required: number, current: number | undefined): string {
  if (required <= 0) return '—';
  const hasCurrent = current != null;
  return `${hasCurrent ? formatBytes(current) : '—'} / ${formatBytes(required)}`;
}

// Mirrors the ratio computed in ModelList.tsx (drives the Progress bar and its variant).
function memoryRatio(required: number, current: number | undefined): number {
  const hasCurrent = current != null;
  return required > 0 && hasCurrent ? current / required : 0;
}

describe('ModelList — memory column (currentMemory absent vs measured)', () => {
  it('shows "— / required" when currentMemory is undefined (no measurement yet)', () => {
    expect(memoryCellText(2 * 1024 ** 3, undefined)).toBe('— / 2.0 GiB');
  });

  it('shows the measured value when currentMemory is 0 (a real, distinct-from-absent reading)', () => {
    expect(memoryCellText(2 * 1024 ** 3, 0)).toBe('0 B / 2.0 GiB');
  });

  it('shows measured / required when both are present', () => {
    expect(memoryCellText(2 * 1024 ** 3, 1.5 * 1024 ** 3)).toBe('1.5 GiB / 2.0 GiB');
  });

  it('shows a bare dash when no requiredMemory is configured', () => {
    expect(memoryCellText(0, 1 * 1024 ** 3)).toBe('—');
  });

  it('ratio is 0 (no progress bar rendered) when currentMemory is absent', () => {
    expect(memoryRatio(2 * 1024 ** 3, undefined)).toBe(0);
  });

  it('ratio can exceed 1 when measured usage overshoots the configured estimate', () => {
    expect(memoryRatio(2 * 1024 ** 3, 3 * 1024 ** 3)).toBeCloseTo(1.5);
  });
});

// Mirrors the currentMemory sort comparator in ModelList.tsx.
function compareCurrentMemory(a: number | undefined, b: number | undefined): number {
  return (a ?? -1) - (b ?? -1);
}

describe('ModelList — currentMemory sort comparator', () => {
  it('treats undefined as less than any measured value, including 0', () => {
    expect(compareCurrentMemory(undefined, 100)).toBeLessThan(0);
    expect(compareCurrentMemory(undefined, 0)).toBeLessThan(0);
  });

  it('treats two undefined values as equal', () => {
    expect(compareCurrentMemory(undefined, undefined)).toBe(0);
  });

  it('compares two measured values normally', () => {
    expect(compareCurrentMemory(50, 100)).toBeLessThan(0);
    expect(compareCurrentMemory(100, 50)).toBeGreaterThan(0);
  });
});
