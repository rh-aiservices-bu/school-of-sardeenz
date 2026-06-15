import type { FastifyInstance } from 'fastify';
import type { RouteDeps } from './deps.js';

export function registerMetricsRoutes(app: FastifyInstance, deps: RouteDeps): void {
  void deps;
  app.get('/api/metrics/latency', async (_request, reply) => {
    return reply.code(501).send({ error: 'Not implemented', code: 'NOT_IMPLEMENTED' });
  });

  app.get('/api/metrics/throughput', async (_request, reply) => {
    return reply.code(501).send({ error: 'Not implemented', code: 'NOT_IMPLEMENTED' });
  });

  app.get('/api/metrics/memory', async (_request, reply) => {
    return reply.code(501).send({ error: 'Not implemented', code: 'NOT_IMPLEMENTED' });
  });
}
