import type { FastifyInstance } from 'fastify';
import type { RouteDeps } from './deps.js';

export function registerClusterRoutes(app: FastifyInstance, deps: RouteDeps): void {
  app.get('/api/cluster/status', async (_request, reply) => {
    const res = await deps.controlPlane.proxyRequest('GET', '/api/v1/cluster/status');
    const body: unknown = await res.json();
    return reply.code(res.status).send(body);
  });

  app.get('/api/cluster/memory', async (_request, reply) => {
    const res = await deps.controlPlane.proxyRequest('GET', '/api/v1/cluster/memory');
    const body: unknown = await res.json();
    return reply.code(res.status).send(body);
  });
}
