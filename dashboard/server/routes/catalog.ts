import type { FastifyInstance } from 'fastify';
import { composeUpstreamSignal } from '../clients/upstream-signal.js';
import { BffError } from '../errors.js';
import type { RouteDeps } from './deps.js';

export function registerCatalogRoutes(app: FastifyInstance, deps: RouteDeps): void {
  // GET /api/catalog — list the runner catalog merged with import state (read).
  app.get(
    '/api/catalog',
    { preHandler: [app.authenticate, app.requireRole('admin-readonly')] },
    async (_request, reply) => {
      const upstream = composeUpstreamSignal(deps.config.upstreamTimeoutMs, reply);
      try {
        const { status, data } = await deps.controlPlane.listCatalog(upstream.signal);
        return reply.code(status).send(data);
      } finally {
        upstream.done();
      }
    },
  );

  // POST /api/catalog/refresh — force a re-fetch of the catalog source (read-ish).
  // admin-readonly: refresh re-fetches the catalog source — a read-ish operation, not a write
  app.post(
    '/api/catalog/refresh',
    { preHandler: [app.authenticate, app.requireRole('admin-readonly')] },
    async (_request, reply) => {
      const upstream = composeUpstreamSignal(deps.config.upstreamTimeoutMs, reply);
      try {
        const { status, data } = await deps.controlPlane.refreshCatalog(upstream.signal);
        return reply.code(status).send(data);
      } finally {
        upstream.done();
      }
    },
  );

  // POST /api/catalog/:id/import — pull the SIF onto the module store (write op).
  app.post<{ Params: { id: string } }>(
    '/api/catalog/:id/import',
    { preHandler: [app.authenticate, app.requireRole('admin')] },
    async (request, reply) => {
      const upstream = composeUpstreamSignal(deps.config.upstreamTimeoutMs, reply);
      try {
        if (!request.params.id) throw BffError.notFound('catalog entry');
        const { status, data } = await deps.controlPlane.importRunner(
          request.params.id,
          upstream.signal,
        );
        return reply.code(status).send(data);
      } finally {
        upstream.done();
      }
    },
  );

  // DELETE /api/catalog/:id — uninstall an imported SIF (write op).
  app.delete<{ Params: { id: string } }>(
    '/api/catalog/:id',
    { preHandler: [app.authenticate, app.requireRole('admin')] },
    async (request, reply) => {
      const upstream = composeUpstreamSignal(deps.config.upstreamTimeoutMs, reply);
      try {
        const { status, data } = await deps.controlPlane.uninstallRunner(
          request.params.id,
          upstream.signal,
        );
        return reply.code(status).send(data);
      } finally {
        upstream.done();
      }
    },
  );
}
