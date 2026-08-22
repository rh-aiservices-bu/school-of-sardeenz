import { describe, it, expect } from 'vitest';
import {
  formatBytes,
  formatRelativeTime,
  formatPercentage,
  formatDateTime,
} from '../../utils/format';

describe('formatBytes', () => {
  it('returns "0 B" for 0', () => {
    expect(formatBytes(0)).toBe('0 B');
  });

  it('returns "0 B" for null', () => {
    expect(formatBytes(null)).toBe('0 B');
  });

  it('returns "0 B" for undefined', () => {
    expect(formatBytes(undefined)).toBe('0 B');
  });

  it('formats bytes without decimal', () => {
    expect(formatBytes(512)).toBe('512 B');
  });

  it('formats KiB', () => {
    expect(formatBytes(1024)).toBe('1.0 KiB');
  });

  it('formats MiB', () => {
    expect(formatBytes(1024 * 1024)).toBe('1.0 MiB');
  });

  it('formats GiB', () => {
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1.0 GiB');
  });

  it('formats TiB', () => {
    expect(formatBytes(1024 * 1024 * 1024 * 1024)).toBe('1.0 TiB');
  });

  it('formats partial GiB with one decimal', () => {
    expect(formatBytes(1.5 * 1024 * 1024 * 1024)).toBe('1.5 GiB');
  });

  it('formats 8 GiB (8589934592 bytes)', () => {
    expect(formatBytes(8 * 1024 * 1024 * 1024)).toBe('8.0 GiB');
  });
});

describe('formatRelativeTime', () => {
  it('returns "Never" for null', () => {
    expect(formatRelativeTime(null)).toBe('Never');
  });

  it('returns "Never" for undefined', () => {
    expect(formatRelativeTime(undefined)).toBe('Never');
  });

  it('returns "Never" for empty string', () => {
    expect(formatRelativeTime('')).toBe('Never');
  });

  it('returns "now" for a future date', () => {
    const future = new Date(Date.now() + 10_000).toISOString();
    expect(formatRelativeTime(future)).toBe('now');
  });

  it('returns seconds ago for recent times', () => {
    const recent = new Date(Date.now() - 30_000).toISOString();
    expect(formatRelativeTime(recent)).toBe('30 seconds ago');
  });

  it('returns minutes ago', () => {
    const recent = new Date(Date.now() - 5 * 60_000).toISOString();
    expect(formatRelativeTime(recent)).toBe('5 minutes ago');
  });

  it('returns hours ago', () => {
    const recent = new Date(Date.now() - 2 * 3_600_000).toISOString();
    expect(formatRelativeTime(recent)).toBe('2 hours ago');
  });

  it('returns days ago', () => {
    const recent = new Date(Date.now() - 3 * 86_400_000).toISOString();
    expect(formatRelativeTime(recent)).toBe('3 days ago');
  });
});

describe('formatPercentage', () => {
  it('returns "0%" when total is 0', () => {
    expect(formatPercentage(0, 0)).toBe('0%');
  });

  it('calculates 50%', () => {
    expect(formatPercentage(1, 2)).toBe('50.0%');
  });

  it('calculates 100%', () => {
    expect(formatPercentage(8, 8)).toBe('100.0%');
  });

  it('calculates partial percentage', () => {
    expect(formatPercentage(3, 7)).toBe('42.9%');
  });

  it('calculates 0% when used is 0', () => {
    expect(formatPercentage(0, 16)).toBe('0.0%');
  });
});

describe('formatDateTime', () => {
  it('returns "—" for null', () => {
    expect(formatDateTime(null)).toBe('—');
  });

  it('returns "—" for undefined', () => {
    expect(formatDateTime(undefined)).toBe('—');
  });

  it('returns "—" for empty string', () => {
    expect(formatDateTime('')).toBe('—');
  });

  it('returns a non-empty string for a valid ISO date', () => {
    const result = formatDateTime('2025-01-15T10:30:00Z');
    expect(result).toBeTruthy();
    expect(result).not.toBe('—');
  });
});
