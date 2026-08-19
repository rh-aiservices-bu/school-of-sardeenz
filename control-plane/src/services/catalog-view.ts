import { CatalogItemState, type ControlPlaneComponents } from '@sardeenz/types';
import type { CatalogEntry, CatalogSnapshot } from './catalog-service.js';

type RunnerCatalogView = ControlPlaneComponents['schemas']['RunnerCatalogView'];
type CatalogItem = ControlPlaneComponents['schemas']['CatalogItem'];
type CatalogItemStatus = ControlPlaneComponents['schemas']['CatalogItemStatus'];

// Numeric-aware version compare: "0.21" > "0.20" > "0.9". Falls back to string compare per token.
export function compareVersions(a: string, b: string): number {
  const ta = a.split(/[^0-9A-Za-z]+/);
  const tb = b.split(/[^0-9A-Za-z]+/);
  const len = Math.max(ta.length, tb.length);
  for (let i = 0; i < len; i++) {
    const sa = ta[i] ?? '';
    const sb = tb[i] ?? '';
    const na = Number(sa);
    const nb = Number(sb);
    const bothNum = sa !== '' && sb !== '' && !Number.isNaN(na) && !Number.isNaN(nb);
    if (bothNum) {
      if (na !== nb) return na < nb ? -1 : 1;
    } else if (sa !== sb) {
      return sa < sb ? -1 : 1;
    }
  }
  return 0;
}

// True when the catalog offers a newer version of the same runnerType than this (imported) entry.
function hasNewerSibling(entry: CatalogEntry, entries: CatalogEntry[]): boolean {
  return entries.some(
    (other) =>
      other.id !== entry.id &&
      other.runnerType === entry.runnerType &&
      compareVersions(other.version, entry.version) > 0,
  );
}

// Merge the catalog snapshot with module-store contents + transient import states into the API view.
export function buildCatalogView(
  snapshot: CatalogSnapshot,
  importedStems: Set<string>,
  transientById: Map<string, CatalogItemStatus>,
): RunnerCatalogView {
  const catalogStems = new Set(snapshot.entries.map((e) => e.sifName));

  const runners: CatalogItem[] = snapshot.entries.map((entry) => {
    const transient = transientById.get(entry.id);
    const status: CatalogItemStatus =
      transient ??
      ({
        id: entry.id,
        state: importedStems.has(entry.sifName)
          ? CatalogItemState.IMPORTED
          : CatalogItemState.NOT_IMPORTED,
      } satisfies CatalogItemStatus);
    const updateAvailable =
      status.state === CatalogItemState.IMPORTED && hasNewerSibling(entry, snapshot.entries);
    return { entry, status, updateAvailable };
  });

  const unmanagedModules = [...importedStems].filter((stem) => !catalogStems.has(stem)).sort();

  return {
    source: snapshot.source,
    fetchedAt: snapshot.fetchedAt,
    runners,
    unmanagedModules,
  };
}

// --- uninstall in-use guard --------------------------------------------------------------------
export interface ActiveRunnerInfo {
  runnerType: string;
  version?: string;
}

// Conservative: block uninstall if a running model uses the same runnerType and either resolves to
// this exact module or its version is unknown (can't prove it's a different version). Precise
// per-module tracking would require recording runtimeModule on the model (a future enhancement).
export function isModuleInUse(
  entry: { runnerType: string; sifName: string },
  active: ActiveRunnerInfo[],
): boolean {
  for (const a of active) {
    if (a.runnerType !== entry.runnerType) continue;
    if (a.version === undefined) return true;
    if (`${a.runnerType}-${a.version}` === entry.sifName) return true;
  }
  return false;
}
