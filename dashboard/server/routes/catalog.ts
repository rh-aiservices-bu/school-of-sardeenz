import type { FastifyInstance } from 'fastify';
import { BffError } from '../errors.js';
import type { RouteDeps } from './deps.js';

export function registerCatalogRoutes(app: FastifyInstance, deps: RouteDeps): void {
  // GET /api/catalog — list the runner catalog merged with import state (read).
  app.get(
    '/api/catalog',
    { preHandler: [app.authenticate, app.requireRole('admin-readonly')] },
    async (_request, reply) => {
      const { status, data } = await deps.controlPlane.listCatalog();
      return reply.code(status).send(data);
    },
  );

  // POST /api/catalog/refresh — force a re-fetch of the catalog source (read-ish).
  app.post(
    '/api/catalog/refresh',
    { preHandler: [app.authenticate, app.requireRole('admin-readonly')] },
    async (_request, reply) => {
      const { status, data } = await deps.controlPlane.refreshCatalog();
      return reply.code(status).send(data);
    },
  );

  // POST /api/catalog/:id/import — pull the SIF onto the module store (write op).
  app.post<{ Params: { id: string } }>(
    '/api/catalog/:id/import',
    { preHandler: [app.authenticate, app.requireRole('admin')] },
    async (request, reply) => {
      if (!request.params.id) throw BffError.notFound('catalog entry');
      const { status, data } = await deps.controlPlane.importRunner(request.params.id);
      return reply.code(status).send(data);
    },
  );

  // DELETE /api/catalog/:id — uninstall an imported SIF (write op).
  app.delete<{ Params: { id: string } }>(
    '/api/catalog/:id',
    { preHandler: [app.authenticate, app.requireRole('admin')] },
    async (request, reply) => {
      const { status, data } = await deps.controlPlane.uninstallRunner(request.params.id);
      return reply.code(status).send(data);
    },
  );
}
