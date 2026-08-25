import type { FastifyInstance } from 'fastify';
import { ModelLifecycleState } from '@sardeenz/types';

import type { RouteDeps } from './deps.js';
import { ControlPlaneError } from '../errors.js';
import {
  buildCatalogView,
  isModuleInUse,
  type ActiveRunnerInfo,
} from '../services/catalog-view.js';
import type { CatalogSnapshot } from '../services/catalog-service.js';

export function registerCatalogRoutes(app: FastifyInstance, deps: RouteDeps): void {
  async function view(snapshot: CatalogSnapshot) {
    const importedStems = await deps.moduleStore.listImportedStems();
    return buildCatalogView(snapshot, importedStems, deps.moduleStore.getAllTransient());
  }

  app.get('/api/v1/catalog', async (_request, reply) => {
    let snapshot: CatalogSnapshot;
    try {
      snapshot = await deps.catalogService.load();
    } catch (err) {
      throw ControlPlaneError.catalogFetchFailed(err instanceof Error ? err.message : String(err));
    }
    return reply.code(200).send(await view(snapshot));
  });

  app.post('/api/v1/catalog/refresh', async (_request, reply) => {
    let snapshot: CatalogSnapshot;
    try {
      snapshot = await deps.catalogService.refresh();
    } catch (err) {
      throw ControlPlaneError.catalogFetchFailed(err instanceof Error ? err.message : String(err));
    }
    deps.moduleStore.notifyCatalogRefreshed();
    return reply.code(200).send(await view(snapshot));
  });

  app.post<{ Params: { id: string } }>('/api/v1/catalog/:id/import', async (request, reply) => {
    if (!deps.leaderElection.isLeader) throw ControlPlaneError.notLeader();

    const snapshot = await deps.catalogService.load();
    const entry = snapshot.entries.find((e) => e.id === request.params.id);
    if (!entry) throw ControlPlaneError.catalogEntryNotFound(request.params.id);

    // Forward-compat guard: reject an import only on positive evidence the running proxy
    // demonstrably cannot serve this protocol. Key absent (proxy not started yet / older build)
    // is indistinguishable from "new protocol" — permit the import rather than failing catalog
    // import whenever the proxy happens to be down (#125 Unit B item 4).
    const supported = await deps.proxyProtocols.getSupported();
    if (supported !== null && !supported.includes(entry.protocol)) {
      throw ControlPlaneError.proxyProtocolUnsupported(entry.protocol, supported);
    }

    const status = deps.moduleStore.startImport(entry);
    return reply.code(202).send(status);
  });

  app.delete<{ Params: { id: string } }>('/api/v1/catalog/:id', async (request, reply) => {
    if (!deps.leaderElection.isLeader) throw ControlPlaneError.notLeader();

    const snapshot = await deps.catalogService.load();
    const entry = snapshot.entries.find((e) => e.id === request.params.id);
    if (!entry) throw ControlPlaneError.catalogEntryNotFound(request.params.id);

    if (await isEntryInUse(deps, entry.runnerType)) {
      throw ControlPlaneError.moduleInUse(entry.id);
    }

    const removed = await deps.moduleStore.uninstall(entry);
    if (!removed) throw ControlPlaneError.catalogEntryNotFound(entry.id);
    return reply.code(204).send();
  });
}

// A module is in use if a non-STOPPED model resolves to it. Model lifecycle state carries the
// runner endpoint but not the module, so we cross-reference the model repository for runnerType +
// engineConfig.version (see isModuleInUse for the conservative matching rule).
async function isEntryInUse(deps: RouteDeps, runnerType: string): Promise<boolean> {
  const states = await deps.lifecycle.getAllInstances();
  const activeNames = new Set(
    states.filter((s) => s.state !== ModelLifecycleState.STOPPED).map((s) => s.modelName),
  );
  if (activeNames.size === 0) return false;

  const records = await deps.modelRepository.findAll();
  const active: ActiveRunnerInfo[] = records
    .filter((r) => activeNames.has(r.name))
    .map((r) => ({ runnerType: r.runnerType }));

  return isModuleInUse({ runnerType }, active);
}
