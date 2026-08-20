import type { FastifyInstance } from 'fastify';
import type { RouteDeps } from './deps.js';

export function registerWeightsRoutes(app: FastifyInstance, deps: RouteDeps): void {
  // GET /api/weights?path=<relative> — browse the shared model-weights directory (read).
  app.get(
    '/api/weights',
    { preHandler: [app.authenticate, app.requireRole('admin-readonly')] },
    async (request, reply) => {
      const query = request.query as Record<string, string>;
      const { status, data } = await deps.controlPlane.browseWeights(query['path']);
      return reply.code(status).send(data);
    },
  );
}
