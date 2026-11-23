import { describe, it, expect } from 'vitest';
import {
  compareShimSources,
  extractEntries,
  formatTable,
  parseArgs,
  runCheck,
  type CheckDeps,
  type ShimSourceRow,
} from '../catalog-shim-source.js';

const SHIM = '337e0aeba53554c42b5e920011ed592fd4f30e8b';
const OTHER = 'a'.repeat(40);

describe('compareShimSources', () => {
  it('reports current when the catalog source equals the resolved commit', () => {
    expect(compareShimSources([{ id: 'vllm-0.21', shimSource: SHIM }], SHIM)).toEqual([
      { id: 'vllm-0.21', catalogShimSource: SHIM, currentSource: SHIM, verdict: 'current' },
    ]);
  });

  it('reports stale when the catalog source differs from the resolved commit', () => {
    expect(compareShimSources([{ id: 'vllm-0.21', shimSource: OTHER }], SHIM)).toEqual([
      { id: 'vllm-0.21', catalogShimSource: OTHER, currentSource: SHIM, verdict: 'stale' },
    ]);
  });

  it('reports unset when the entry has no shimSource', () => {
    expect(compareShimSources([{ id: 'a' }, { id: 'b', shimSource: null }], SHIM)).toEqual([
      { id: 'a', verdict: 'unset' },
      { id: 'b', verdict: 'unset' },
    ]);
  });

  it('reports invalid for non-40-hex values', () => {
    for (const bad of ['XYZ', 'a'.repeat(39), 'A'.repeat(40), 123]) {
      expect(compareShimSources([{ id: 'e', shimSource: bad }], SHIM)).toEqual([
        {
          id: 'e',
          verdict: 'invalid',
          ...(typeof bad === 'string' ? { catalogShimSource: bad } : {}),
        },
      ]);
    }
  });

  it('reports unverified for every sourced entry when the current commit is unknown', () => {
    const entries = [{ id: 'a', shimSource: SHIM }];
    expect(compareShimSources(entries, undefined)).toEqual([
      { id: 'a', catalogShimSource: SHIM, verdict: 'unverified' },
    ]);
    expect(compareShimSources(entries, 'nope')).toEqual([
      { id: 'a', catalogShimSource: SHIM, verdict: 'unverified' },
    ]);
  });

  it('preserves file order and echoes entry ids', () => {
    const rows = compareShimSources(
      [{ id: 'first', shimSource: OTHER }, { id: 'second' }, { id: 'third', shimSource: SHIM }],
      SHIM,
    );
    expect(rows.map((r) => [r.id, r.verdict])).toEqual([
      ['first', 'stale'],
      ['second', 'unset'],
      ['third', 'current'],
    ]);
  });

  it('keeps the catalog value for display only on string entries', () => {
    const [stringRow] = compareShimSources([{ id: 'e', shimSource: 'not-hex' }], SHIM);
    const [numberRow] = compareShimSources([{ id: 'e', shimSource: 42 }], SHIM);
    expect(stringRow.catalogShimSource).toBe('not-hex');
    expect(numberRow.catalogShimSource).toBeUndefined();
  });
});

describe('formatTable', () => {
  const rows: ShimSourceRow[] = [
    { id: 'unset-entry', verdict: 'unset' },
    { id: 'current-entry', catalogShimSource: SHIM, currentSource: SHIM, verdict: 'current' },
    { id: 'stale-entry', catalogShimSource: OTHER, currentSource: SHIM, verdict: 'stale' },
    { id: 'unverified-entry', catalogShimSource: SHIM, verdict: 'unverified' },
  ];

  it('renders dash placeholders and one summary line', () => {
    expect(formatTable(rows)).toEqual([
      'unset-entry\t-\t-\tunset',
      `current-entry\t${SHIM}\t${SHIM}\tcurrent`,
      `stale-entry\t${OTHER}\t${SHIM}\tstale`,
      `unverified-entry\t${SHIM}\t-\tunverified`,
      'checked=4 current=1 stale=1 unset=1 unverified=1 invalid=0',
    ]);
  });

  it('preserves row order', () => {
    expect(
      formatTable(rows)
        .slice(0, 4)
        .map((line) => line.split('\t')[0]),
    ).toEqual(['unset-entry', 'current-entry', 'stale-entry', 'unverified-entry']);
  });
});

describe('parseArgs', () => {
  it('returns defaults with no arguments', () => {
    expect(parseArgs([])).toEqual({
      kind: 'run',
      catalogPath: undefined,
      shimPath: undefined,
      strict: false,
    });
  });

  it('parses --catalog and --shim-path values', () => {
    expect(parseArgs(['--catalog', 'c.yaml', '--shim-path', 'runners/mlserver'])).toEqual({
      kind: 'run',
      catalogPath: 'c.yaml',
      shimPath: 'runners/mlserver',
      strict: false,
    });
  });

  it('sets strict from --strict', () => {
    expect(parseArgs(['--strict'])).toEqual({
      kind: 'run',
      catalogPath: undefined,
      shimPath: undefined,
      strict: true,
    });
  });

  it('returns help for --help and -h', () => {
    expect(parseArgs(['--help'])).toEqual({ kind: 'help' });
    expect(parseArgs(['-h'])).toEqual({ kind: 'help' });
  });

  it('rejects an unknown argument', () => {
    expect(parseArgs(['--nope'])).toMatchObject({ kind: 'error' });
  });

  it('rejects a flag missing its value', () => {
    expect(parseArgs(['--catalog'])).toMatchObject({ kind: 'error' });
    expect(parseArgs(['--catalog', '--strict'])).toMatchObject({ kind: 'error' });
  });
});

describe('extractEntries', () => {
  it('maps runners to id + shimSource', () => {
    const doc = {
      runners: [{ id: 'vllm-0.21', shimSource: SHIM, title: 'ignored' }, { id: 'mlserver-1.7.1' }],
    };
    expect(extractEntries(doc)).toEqual([
      { id: 'vllm-0.21', shimSource: SHIM },
      { id: 'mlserver-1.7.1', shimSource: undefined },
    ]);
  });

  it('ignores non-object entries', () => {
    expect(extractEntries({ runners: ['nope', null, 3, { id: 'ok' }] })).toEqual([
      { id: 'ok', shimSource: undefined },
    ]);
  });

  it('throws when runners is not an array', () => {
    expect(() => extractEntries({ runners: 'x' })).toThrow(/no 'runners' array/);
    expect(() => extractEntries({})).toThrow(/no 'runners' array/);
    expect(() => extractEntries(null)).toThrow(/no 'runners' array/);
  });
});

describe('runCheck', () => {
  const catalog = (body: string) => `apiVersion: sardeenz.io/v1\nrunners:\n${body}`;
  const ALL_CURRENT = catalog(
    `  - id: a\n    shimSource: ${SHIM}\n  - id: b\n    shimSource: ${SHIM}\n`,
  );

  function runWith(
    readCatalog: () => Promise<string>,
    currentSource: string | undefined,
    strict = false,
  ): { exit: Promise<number>; out: string[]; err: string[] } {
    const out: string[] = [];
    const err: string[] = [];
    const deps: CheckDeps = {
      readCatalog,
      resolveCurrentSource: () => currentSource,
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
    };
    return {
      exit: runCheck({ catalogPath: '/c.yaml', shimPath: 'runners/vllm', strict }, deps),
      out,
      err,
    };
  }

  it('reports current rows and exits 0', async () => {
    const r = runWith(() => Promise.resolve(ALL_CURRENT), SHIM);
    await expect(r.exit).resolves.toBe(0);
    expect(r.out).toEqual([
      `a\t${SHIM}\t${SHIM}\tcurrent`,
      `b\t${SHIM}\t${SHIM}\tcurrent`,
      'checked=2 current=2 stale=0 unset=0 unverified=0 invalid=0',
    ]);
    expect(r.err).toEqual([]);
  });

  it('exits 1 with --strict when an entry is stale', async () => {
    const stale = catalog(`  - id: a\n    shimSource: ${OTHER}\n`);
    await expect(runWith(() => Promise.resolve(stale), SHIM, true).exit).resolves.toBe(1);
  });

  it('exits 0 without --strict when an entry is stale', async () => {
    const stale = catalog(`  - id: a\n    shimSource: ${OTHER}\n`);
    await expect(runWith(() => Promise.resolve(stale), SHIM, false).exit).resolves.toBe(0);
  });

  it('exits 1 with --strict when git produced no commit', async () => {
    await expect(runWith(() => Promise.resolve(ALL_CURRENT), undefined, true).exit).resolves.toBe(
      1,
    );
  });

  it('exits 2 when the catalog cannot be read', async () => {
    const r = runWith(() => Promise.reject(new Error('ENOENT')), SHIM);
    await expect(r.exit).resolves.toBe(2);
    expect(r.err).toHaveLength(1);
    expect(r.err[0]).toMatch(/cannot read catalog/);
  });

  it('exits 2 when the catalog is not valid YAML', async () => {
    const r = runWith(() => Promise.resolve('runners: [unclosed\n'), SHIM);
    await expect(r.exit).resolves.toBe(2);
    expect(r.err[0]).toMatch(/cannot parse catalog/);
  });

  it('exits 2 when the catalog has no runners array', async () => {
    const r = runWith(() => Promise.resolve('apiVersion: sardeenz.io/v1\n'), SHIM);
    await expect(r.exit).resolves.toBe(2);
    expect(r.err[0]).toMatch(/no 'runners' array/);
  });

  it('exits 0 for an empty catalog', async () => {
    const r = runWith(() => Promise.resolve('runners: []\n'), SHIM, true);
    await expect(r.exit).resolves.toBe(0);
    expect(r.out).toEqual(['checked=0 current=0 stale=0 unset=0 unverified=0 invalid=0']);
  });
});
