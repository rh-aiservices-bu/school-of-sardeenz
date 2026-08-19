// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { CatalogItemState } from '@sardeenz/types';
import {
  buildCatalogView,
  compareVersions,
  isModuleInUse,
  type ActiveRunnerInfo,
} from '../catalog-view.js';
import type { CatalogEntry, CatalogSnapshot } from '../catalog-service.js';

function entry(over: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    id: 'vllm-0.21',
    title: 'vLLM 0.21',
    description: 'd',
    runnerType: 'vllm',
    version: '0.21',
    image: 'oras://quay.io/x/vllm:0.21',
    sifName: 'vllm-0.21',
    ...over,
  };
}

function snapshot(entries: CatalogEntry[]): CatalogSnapshot {
  return { source: 'test', fetchedAt: '2026-01-01T00:00:00Z', entries };
}

describe('compareVersions', () => {
  it('orders numeric versions', () => {
    expect(compareVersions('0.21', '0.20')).toBe(1);
    expect(compareVersions('0.20', '0.21')).toBe(-1);
    expect(compareVersions('0.21', '0.21')).toBe(0);
    expect(compareVersions('0.9', '0.10')).toBe(-1); // numeric, not lexical
    expect(compareVersions('1.0', '0.99')).toBe(1);
  });
});

describe('buildCatalogView', () => {
  it('marks entries imported when the SIF stem is present', () => {
    const view = buildCatalogView(snapshot([entry()]), new Set(['vllm-0.21']), new Map());
    expect(view.runners[0].status.state).toBe(CatalogItemState.IMPORTED);
    expect(view.runners[0].updateAvailable).toBe(false);
  });

  it('marks entries not imported when absent', () => {
    const view = buildCatalogView(snapshot([entry()]), new Set(), new Map());
    expect(view.runners[0].status.state).toBe(CatalogItemState.NOT_IMPORTED);
  });

  it('prefers a transient (IMPORTING/FAILED) status over fs-derived state', () => {
    const transient = new Map([
      ['vllm-0.21', { id: 'vllm-0.21', state: CatalogItemState.IMPORTING, percentComplete: 42 }],
    ]);
    const view = buildCatalogView(snapshot([entry()]), new Set(), transient);
    expect(view.runners[0].status.state).toBe(CatalogItemState.IMPORTING);
    expect(view.runners[0].status.percentComplete).toBe(42);
  });

  it('flags updateAvailable on an imported older version when a newer one is in the catalog', () => {
    const entries = [
      entry({ id: 'vllm-0.20', version: '0.20', sifName: 'vllm-0.20' }),
      entry({ id: 'vllm-0.21', version: '0.21', sifName: 'vllm-0.21' }),
    ];
    const view = buildCatalogView(snapshot(entries), new Set(['vllm-0.20']), new Map());
    const older = view.runners.find((r) => r.entry.id === 'vllm-0.20');
    expect(older?.status.state).toBe(CatalogItemState.IMPORTED);
    expect(older?.updateAvailable).toBe(true);
  });

  it('lists module-store SIFs not in the catalog as unmanagedModules', () => {
    const view = buildCatalogView(
      snapshot([entry()]),
      new Set(['vllm-0.21', 'triton-2.42', 'locally-built']),
      new Map(),
    );
    expect(view.unmanagedModules).toEqual(['locally-built', 'triton-2.42']);
  });
});

describe('isModuleInUse', () => {
  const e = { runnerType: 'vllm', sifName: 'vllm-0.20' };

  it('is false when no active runner shares the runnerType', () => {
    const active: ActiveRunnerInfo[] = [{ runnerType: 'triton', version: '2.42' }];
    expect(isModuleInUse(e, active)).toBe(false);
  });

  it('is true when an active runner resolves to the exact module', () => {
    expect(isModuleInUse(e, [{ runnerType: 'vllm', version: '0.20' }])).toBe(true);
  });

  it('allows uninstalling a different version of the same runnerType', () => {
    expect(isModuleInUse(e, [{ runnerType: 'vllm', version: '0.21' }])).toBe(false);
  });

  it('conservatively blocks when the active version is unknown', () => {
    expect(isModuleInUse(e, [{ runnerType: 'vllm' }])).toBe(true);
  });
});
