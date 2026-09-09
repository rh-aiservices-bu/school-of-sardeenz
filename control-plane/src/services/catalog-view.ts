import { CatalogItemState, type ControlPlaneComponents } from '@sardeenz/types';
import type { CatalogSnapshot } from './catalog-service.js';
import type { ImportedModules } from './module-store.js';

type RunnerCatalogView = ControlPlaneComponents['schemas']['RunnerCatalogView'];
type CatalogItem = ControlPlaneComponents['schemas']['CatalogItem'];
type CatalogItemStatus = ControlPlaneComponents['schemas']['CatalogItemStatus'];

// Merge the catalog snapshot with module-store contents + transient import states into the API view.
export function buildCatalogView(
  snapshot: CatalogSnapshot,
  importedModules: ImportedModules,
  transientById: Map<string, CatalogItemStatus>,
): RunnerCatalogView {
  const importedStems = new Set(importedModules.keys());
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
    const catalogDigest = entry.image.match(/@sha256:([a-fA-F0-9]{64})$/)?.[1]?.toLowerCase();
    const importedDigest = importedModules.get(entry.sifName);
    const updateAvailable =
      status.state === CatalogItemState.IMPORTED &&
      (catalogDigest === undefined || importedDigest !== catalogDigest);
    return { entry, status, updateAvailable };
  });

  const unmanagedModules = [...importedStems].filter((stem) => !catalogStems.has(stem)).sort();

  return {
    source: snapshot.source,
    fetchedAt: snapshot.fetchedAt,
    runners,
    unmanagedModules,
    invalidEntries: snapshot.invalidEntries,
  };
}

// --- uninstall in-use guard --------------------------------------------------------------------
export interface ActiveRunnerInfo {
  runnerType: string;
}

// Conservative and SOUND: block uninstall if any running model uses the entry's runnerType.
//
// We cannot precisely map a running model to a specific SIF module today — a deploy records
// runnerType (and a free-form engineConfig) but not the resolved runtimeModule/sifName, and the
// sifName↔version relationship is a naming convention nothing enforces. Matching on runnerType
// alone therefore over-blocks (you must stop dependent models before uninstalling any version of
// that engine) but never deletes a SIF backing a live runner. Precise per-module guarding needs
// the resolved runtimeModule recorded on the model at deploy time (a future enhancement).
export function isModuleInUse(entry: { runnerType: string }, active: ActiveRunnerInfo[]): boolean {
  return active.some((a) => a.runnerType === entry.runnerType);
}
