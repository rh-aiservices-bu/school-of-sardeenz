// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { CatalogItemState, CatalogUpdateReason } from '@sardeenz/types';
import { buildCatalogView, isModuleInUse, type ActiveRunnerInfo } from '../catalog-view.js';
import type { CatalogEntry, CatalogSnapshot } from '../catalog-service.js';

const DIGEST = 'a'.repeat(64);
const SHIM = '337e0aeba53554c42b5e920011ed592fd4f30e8b';
const OTHER = 'b'.repeat(40);

function entry(over: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    id: 'vllm-0.21',
    title: 'vLLM 0.21',
    description: 'd',
    runnerType: 'vllm',
    version: '0.21',
    image: `oras://quay.io/x/vllm:0.21@sha256:${DIGEST}`,
    sifName: 'vllm-0.21',
    protocol: 'openai' as CatalogEntry['protocol'],
    maxTensorParallelism: 1,
    kvCacheElasticSharing: false,
    ...over,
  };
}

function snapshot(entries: CatalogEntry[]): CatalogSnapshot {
  return { source: 'test', fetchedAt: '2026-01-01T00:00:00Z', entries, invalidEntries: [] };
}

describe('buildCatalogView', () => {
  it('marks entries imported when the SIF stem is present', () => {
    const view = buildCatalogView(
      snapshot([entry()]),
      new Map([['vllm-0.21', { imageDigest: DIGEST }]]),
      new Map(),
    );
    expect(view.runners[0].status.state).toBe(CatalogItemState.IMPORTED);
    expect(view.runners[0].updateAvailable).toBe(false);
  });

  it('marks entries not imported when absent', () => {
    const view = buildCatalogView(snapshot([entry()]), new Map(), new Map());
    expect(view.runners[0].status.state).toBe(CatalogItemState.NOT_IMPORTED);
  });

  it('prefers a transient (IMPORTING/FAILED) status over fs-derived state', () => {
    const transient = new Map([
      ['vllm-0.21', { id: 'vllm-0.21', state: CatalogItemState.IMPORTING, percentComplete: 42 }],
    ]);
    const view = buildCatalogView(snapshot([entry()]), new Map(), transient);
    expect(view.runners[0].status.state).toBe(CatalogItemState.IMPORTING);
    expect(view.runners[0].status.percentComplete).toBe(42);
  });

  it('does not flag updateAvailable for coexisting versions (distinct immutable modules)', () => {
    const entries = [
      entry({ id: 'vllm-0.20', version: '0.20', sifName: 'vllm-0.20' }),
      entry({ id: 'vllm-0.21', version: '0.21', sifName: 'vllm-0.21' }),
    ];
    const view = buildCatalogView(
      snapshot(entries),
      new Map([['vllm-0.20', { imageDigest: DIGEST }]]),
      new Map(),
    );
    const older = view.runners.find((r) => r.entry.id === 'vllm-0.20');
    expect(older?.status.state).toBe(CatalogItemState.IMPORTED);
    expect(older?.updateAvailable).toBe(false);
  });

  it('flags an update when the catalog digest differs from the imported digest', () => {
    const view = buildCatalogView(
      snapshot([entry()]),
      new Map([['vllm-0.21', { imageDigest: 'b'.repeat(64) }]]),
      new Map(),
    );
    expect(view.runners[0].updateAvailable).toBe(true);
    expect(view.runners[0].updateReason).toBe(CatalogUpdateReason.digest_changed);
  });

  it('flags a legacy imported SIF whose digest is unknown', () => {
    const view = buildCatalogView(
      snapshot([entry()]),
      new Map([['vllm-0.21', undefined]]),
      new Map(),
    );
    expect(view.runners[0].updateAvailable).toBe(true);
    expect(view.runners[0].updateReason).toBe(CatalogUpdateReason.digest_changed);
  });

  it('lists module-store SIFs not in the catalog as unmanagedModules', () => {
    const view = buildCatalogView(
      snapshot([entry()]),
      new Map([
        ['vllm-0.21', { imageDigest: DIGEST }],
        ['triton-2.42', undefined],
        ['locally-built', undefined],
      ]),
      new Map(),
    );
    expect(view.unmanagedModules).toEqual(['locally-built', 'triton-2.42']);
  });

  // Decision matrix (#287) — rows evaluated in order, first match wins.
  it('does not flag a not-imported entry that advertises a shim source', () => {
    const view = buildCatalogView(snapshot([entry({ shimSource: SHIM })]), new Map(), new Map());
    const item = view.runners[0];
    expect(item.updateAvailable).toBe(false);
    expect('updateReason' in item).toBe(false);
    expect(item.catalogShimSource).toBe(SHIM);
    expect(item.importedShimSource).toBeUndefined();
  });

  it('flags shim-source-advanced when digests match and the shim sources differ', () => {
    const view = buildCatalogView(
      snapshot([entry({ shimSource: SHIM })]),
      new Map([['vllm-0.21', { imageDigest: DIGEST, shimSource: OTHER }]]),
      new Map(),
    );
    const item = view.runners[0];
    expect(item.updateAvailable).toBe(true);
    expect(item.updateReason).toBe(CatalogUpdateReason.shim_source_advanced);
    expect(item.catalogShimSource).toBe(SHIM);
    expect(item.importedShimSource).toBe(OTHER);
  });

  it('flags unprovenanced when the module recorded no shim source', () => {
    const view = buildCatalogView(
      snapshot([entry({ shimSource: SHIM })]),
      new Map([['vllm-0.21', { imageDigest: DIGEST }]]),
      new Map(),
    );
    const item = view.runners[0];
    expect(item.updateAvailable).toBe(true);
    expect(item.updateReason).toBe(CatalogUpdateReason.unprovenanced);
    expect(item.importedShimSource).toBeUndefined();
  });

  it('does not flag an update when digest and shim source both match', () => {
    const view = buildCatalogView(
      snapshot([entry({ shimSource: SHIM })]),
      new Map([['vllm-0.21', { imageDigest: DIGEST, shimSource: SHIM }]]),
      new Map(),
    );
    const item = view.runners[0];
    expect(item.updateAvailable).toBe(false);
    expect('updateReason' in item).toBe(false);
    expect(item.importedShimSource).toBe(SHIM);
  });

  it('keeps digest-only semantics when the catalog advertises no shim source', () => {
    const view = buildCatalogView(
      snapshot([entry()]),
      new Map([['vllm-0.21', { imageDigest: DIGEST, shimSource: SHIM }]]),
      new Map(),
    );
    const item = view.runners[0];
    expect(item.updateAvailable).toBe(false);
    expect('updateReason' in item).toBe(false);
    expect(item.catalogShimSource).toBeUndefined();
  });

  it('passes through invalidEntries from the snapshot', () => {
    const withInvalid: CatalogSnapshot = {
      ...snapshot([entry()]),
      invalidEntries: [{ id: 'bad-entry', reason: "missing/invalid 'protocol'" }],
    };
    const view = buildCatalogView(withInvalid, new Map(), new Map());
    expect(view.invalidEntries).toEqual([
      { id: 'bad-entry', reason: "missing/invalid 'protocol'" },
    ]);
  });
});

describe('isModuleInUse', () => {
  const e = { runnerType: 'vllm' };

  it('is false when no active runner shares the runnerType', () => {
    const active: ActiveRunnerInfo[] = [{ runnerType: 'triton' }];
    expect(isModuleInUse(e, active)).toBe(false);
  });

  it('is false when there are no active runners', () => {
    expect(isModuleInUse(e, [])).toBe(false);
  });

  it('conservatively blocks whenever a running model uses the same runnerType', () => {
    expect(isModuleInUse(e, [{ runnerType: 'vllm' }])).toBe(true);
  });
});
