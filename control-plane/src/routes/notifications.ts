import type { FastifyInstance } from 'fastify';

import type { RouteDeps } from './deps.js';

interface QueryParams {
  limit?: number;
  offset?: number;
}

export function registerNotificationRoutes(app: FastifyInstance, deps: RouteDeps): void {
  app.get<{ Querystring: QueryParams }>('/api/v1/notifications', async (request, reply) => {
    const rawLimit = Number(request.query.limit);
    const rawOffset = Number(request.query.offset);
    const limit = Number.isInteger(rawLimit) && rawLimit > 0 && rawLimit <= 500 ? rawLimit : 50;
    const offset = Number.isInteger(rawOffset) && rawOffset >= 0 ? rawOffset : 0;

    const notifications = await deps.notifications.listNotifications(limit, offset);
    return reply.code(200).send({ notifications });
  });

  app.post<{ Params: { id: string } }>(
    '/api/v1/notifications/:id/read',
    async (request, reply) => {
      const { id } = request.params;
      await deps.notifications.markAsRead(id);
      return reply.code(204).send();
    },
  );

  app.post('/api/v1/notifications/read-all', async (_request, reply) => {
    await deps.notifications.markAllAsRead();
    return reply.code(204).send();
  });

  app.delete<{ Params: { id: string } }>(
    '/api/v1/notifications/:id',
    async (request, reply) => {
      const { id } = request.params;
      await deps.notifications.removeNotification(id);
      return reply.code(204).send();
    },
  );

  app.delete('/api/v1/notifications', async (_request, reply) => {
    await deps.notifications.clearAll();
    return reply.code(204).send();
  });
}
