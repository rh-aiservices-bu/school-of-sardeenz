/**
 * ModelList memory-column logic (#163, measured-only doctrine round).
 *
 * Following the project convention (see gpuMemoryPanel.test.ts / memorySegments.test.ts), we
 * test the pure logic that drives the memory cell and sort comparator directly, rather than
 * rendering the PatternFly table (see the dual-React test limitation noted in M8).
 *
 * `currentMemory` is a real NVML measurement that is ABSENT (not 0) when the model isn't
 * running or the worker can't measure it — 0 is a legitimate measured value (e.g. a sleeping
 * model) and must render differently from "no measurement". `requiredMemory` is a placement-time
 * indicator only (doctrine: it is never shown as a denominator for a running model), so the
 * memory column shows currentMemory alone.
 */
import { describe, it, expect } from 'vitest';
import { formatBytes } from '../../utils/format';

// Mirrors the per-row memory cell logic in ModelList.tsx.
function memoryCellText(current: number | undefined): string {
  return current != null ? formatBytes(current) : '—';
}

describe('ModelList — memory column (currentMemory absent vs measured)', () => {
  it('shows a dash when currentMemory is undefined (no measurement yet)', () => {
    expect(memoryCellText(undefined)).toBe('—');
  });

  it('shows the measured value when currentMemory is 0 (a real, distinct-from-absent reading)', () => {
    expect(memoryCellText(0)).toBe('0 B');
  });

  it('shows the measured value when present', () => {
    expect(memoryCellText(1.5 * 1024 ** 3)).toBe('1.5 GiB');
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
