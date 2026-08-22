import type { FastifyInstance } from 'fastify';
import type { RouteDeps } from './deps.js';

export function registerNotificationRoutes(app: FastifyInstance, deps: RouteDeps): void {
  app.get(
    '/api/notifications',
    { preHandler: [app.authenticate, app.requireRole('admin-readonly')] },
    async (request, reply) => {
      const query = request.query as Record<string, string>;
      const limit = query['limit'] ? parseInt(query['limit'], 10) : undefined;
      const offset = query['offset'] ? parseInt(query['offset'], 10) : undefined;
      const { status, data } = await deps.controlPlane.listNotifications(limit, offset);
      return reply.code(status).send(data);
    },
  );

  // admin-readonly: marking as read is a personal UI state change, not a destructive op
  app.post<{ Params: { id: string } }>(
    '/api/notifications/:id/read',
    { preHandler: [app.authenticate, app.requireRole('admin-readonly')] },
    async (request, reply) => {
      const { status, data } = await deps.controlPlane.markNotificationRead(request.params.id);
      return reply.code(status).send(data);
    },
  );

  // admin-readonly: marking as read is a personal UI state change, not a destructive op
  app.post(
    '/api/notifications/read-all',
    { preHandler: [app.authenticate, app.requireRole('admin-readonly')] },
    async (request, reply) => {
      const { status, data } = await deps.controlPlane.markAllNotificationsRead();
      return reply.code(status).send(data);
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/notifications/:id',
    { preHandler: [app.authenticate, app.requireRole('admin')] },
    async (request, reply) => {
      const { status, data } = await deps.controlPlane.removeNotification(request.params.id);
      return reply.code(status).send(data);
    },
  );

  app.delete(
    '/api/notifications',
    { preHandler: [app.authenticate, app.requireRole('admin')] },
    async (request, reply) => {
      const { status, data } = await deps.controlPlane.clearAllNotifications();
      return reply.code(status).send(data);
    },
  );
}
