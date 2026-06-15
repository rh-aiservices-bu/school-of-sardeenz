import type { FastifyInstance } from 'fastify';
import type { RouteDeps } from './deps.js';

export function registerEventRoutes(app: FastifyInstance, deps: RouteDeps): void {
  void deps;
  app.get('/api/events', async (_request, reply) => {
    return reply.code(501).send({ error: 'Not implemented', code: 'NOT_IMPLEMENTED' });
  });
}
