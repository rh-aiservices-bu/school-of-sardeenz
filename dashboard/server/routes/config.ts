import type { FastifyInstance } from 'fastify';
import type { RouteDeps } from './deps.js';

// Non-secret client config for the SPA. Built field-by-field with an explicit return type —
// NEVER spread `deps.config`, which holds adminPassword / jwtSecret / oauthClientSecret.
export function registerConfigRoutes(app: FastifyInstance, deps: RouteDeps): void {
  app.get(
    '/api/config',
    { preHandler: [app.authenticate, app.requireRole('admin-readonly')] },
    async (_request, reply) => {
      const body: { inferenceUrl: string } = { inferenceUrl: deps.config.inferenceUrl };
      return reply.code(200).send(body);
    },
  );
}
