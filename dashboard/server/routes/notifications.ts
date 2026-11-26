import type { FastifyInstance } from 'fastify';
import { composeUpstreamSignal } from '../clients/upstream-signal.js';
import type { RouteDeps } from './deps.js';

export function registerNotificationRoutes(app: FastifyInstance, deps: RouteDeps): void {
  app.get(
    '/api/notifications',
    { preHandler: [app.authenticate, app.requireRole('admin-readonly')] },
    async (request, reply) => {
      const upstream = composeUpstreamSignal(deps.config.upstreamTimeoutMs, reply);
      try {
        const query = request.query as Record<string, string>;
        const limit = query['limit'] ? parseInt(query['limit'], 10) : undefined;
        const offset = query['offset'] ? parseInt(query['offset'], 10) : undefined;
        const { status, data } = await deps.controlPlane.listNotifications(
          limit,
          offset,
          upstream.signal,
        );
        return reply.code(status).send(data);
      } finally {
        upstream.done();
      }
    },
  );

  // admin-readonly: marking as read is a personal UI state change, not a destructive op
  app.post<{ Params: { id: string } }>(
    '/api/notifications/:id/read',
    { preHandler: [app.authenticate, app.requireRole('admin-readonly')] },
    async (request, reply) => {
      const upstream = composeUpstreamSignal(deps.config.upstreamTimeoutMs, reply);
      try {
        const { status, data } = await deps.controlPlane.markNotificationRead(
          request.params.id,
          upstream.signal,
        );
        return reply.code(status).send(data);
      } finally {
        upstream.done();
      }
    },
  );

  // admin-readonly: marking as read is a personal UI state change, not a destructive op
  app.post(
    '/api/notifications/read-all',
    { preHandler: [app.authenticate, app.requireRole('admin-readonly')] },
    async (request, reply) => {
      const upstream = composeUpstreamSignal(deps.config.upstreamTimeoutMs, reply);
      try {
        const { status, data } = await deps.controlPlane.markAllNotificationsRead(upstream.signal);
        return reply.code(status).send(data);
      } finally {
        upstream.done();
      }
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/notifications/:id',
    { preHandler: [app.authenticate, app.requireRole('admin')] },
    async (request, reply) => {
      const upstream = composeUpstreamSignal(deps.config.upstreamTimeoutMs, reply);
      try {
        const { status, data } = await deps.controlPlane.removeNotification(
          request.params.id,
          upstream.signal,
        );
        return reply.code(status).send(data);
      } finally {
        upstream.done();
      }
    },
  );

  app.delete(
    '/api/notifications',
    { preHandler: [app.authenticate, app.requireRole('admin')] },
    async (request, reply) => {
      const upstream = composeUpstreamSignal(deps.config.upstreamTimeoutMs, reply);
      try {
        const { status, data } = await deps.controlPlane.clearAllNotifications(upstream.signal);
        return reply.code(status).send(data);
      } finally {
        upstream.done();
      }
    },
  );
}
