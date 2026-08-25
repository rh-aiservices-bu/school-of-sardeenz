import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
}));

import { readFileSync } from 'node:fs';
import { resolveOwner, readPpidFromProc } from '../proc-tree.js';

describe('readPpidFromProc', () => {
  beforeEach(() => {
    vi.mocked(readFileSync).mockReset();
  });

  it('parses ppid from a normal /proc/<pid>/stat line', () => {
    // pid=4242, comm="python3", state=S, ppid=100
    vi.mocked(readFileSync).mockReturnValue(
      '4242 (python3) S 100 4242 4242 0 -1 4194560 ...\n',
    );
    expect(readPpidFromProc(4242)).toBe(100);
  });

  it('parses ppid when comm contains spaces and parens', () => {
    // comm = "python3 (worker)" — the field is still wrapped in the outer parens; the parser
    // must split on the LAST ')' in the line, not the first.
    vi.mocked(readFileSync).mockReturnValue(
      '4242 (python3 (worker)) S 200 4242 4242 0 -1 4194560 ...\n',
    );
    expect(readPpidFromProc(4242)).toBe(200);
  });

  it('returns null when the stat file has no closing paren', () => {
    vi.mocked(readFileSync).mockReturnValue('garbage\n');
    expect(readPpidFromProc(4242)).toBeNull();
  });

  it('returns null when the ppid field is not numeric', () => {
    vi.mocked(readFileSync).mockReturnValue('4242 (python3) S notanumber 4242\n');
    expect(readPpidFromProc(4242)).toBeNull();
  });

  it('returns null when the process is gone (ENOENT)', () => {
    vi.mocked(readFileSync).mockImplementation(() => {
      throw new Error('ENOENT: no such file or directory');
    });
    expect(readPpidFromProc(99999)).toBeNull();
  });
});

describe('resolveOwner', () => {
  it('matches the starting pid itself when it is an owner', () => {
    const readPpid = vi.fn(() => 1);
    expect(resolveOwner(500, new Set([500]), readPpid)).toBe(500);
    expect(readPpid).not.toHaveBeenCalled();
  });

  it('walks up the parent chain to find an owner ancestor', () => {
    // 700 (engine) -> 600 (shim) -> 500 (apptainer exec, the owner) -> 1
    const parents = new Map([
      [700, 600],
      [600, 500],
      [500, 1],
    ]);
    const readPpid = (pid: number): number | null => parents.get(pid) ?? null;
    expect(resolveOwner(700, new Set([500]), readPpid)).toBe(500);
  });

  it('returns null when no ancestor matches before hitting init/pid 0', () => {
    const parents = new Map([
      [700, 600],
      [600, 1],
    ]);
    const readPpid = (pid: number): number | null => parents.get(pid) ?? null;
    expect(resolveOwner(700, new Set([999]), readPpid)).toBeNull();
  });

  it('returns null when readPpid cannot resolve further (process gone)', () => {
    const readPpid = vi.fn(() => null);
    expect(resolveOwner(700, new Set([999]), readPpid)).toBeNull();
  });

  it('stops on a cycle rather than looping forever', () => {
    // 300 -> 400 -> 300 -> ... — a malformed/adversarial chain
    const parents = new Map([
      [300, 400],
      [400, 300],
    ]);
    const readPpid = (pid: number): number | null => parents.get(pid) ?? null;
    expect(resolveOwner(300, new Set([999]), readPpid)).toBeNull();
  });

  it('gives up after the hop limit on a very deep chain', () => {
    const readPpid = vi.fn((pid: number) => pid + 1); // never matches, never reaches <= 1
    expect(resolveOwner(1, new Set([999]), readPpid)).toBeNull();
    // MAX_HOPS = 32 — bounded, not unbounded recursion/looping.
    expect(readPpid.mock.calls.length).toBeLessThanOrEqual(32);
  });
});
