import type { FastifyInstance } from 'fastify';

import type { RouteDeps } from './deps.js';

export function registerWeightsRoutes(app: FastifyInstance, deps: RouteDeps): void {
  // GET /api/v1/weights?path=<relative> — browse the shared model-weights directory (read).
  app.get<{ Querystring: { path?: string } }>('/api/v1/weights', async (request, reply) => {
    const listing = await deps.weightsBrowser.list(request.query.path ?? '');
    return reply.code(200).send(listing);
  });
}
