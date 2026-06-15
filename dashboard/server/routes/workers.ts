import type { FastifyInstance } from 'fastify';
import type { RouteDeps } from './deps.js';

export function registerWorkerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  app.get('/api/workers', async (_request, reply) => {
    const res = await deps.controlPlane.proxyRequest('GET', '/api/v1/workers');
    const body: unknown = await res.json();
    return reply.code(res.status).send(body);
  });

  app.get<{ Params: { id: string } }>('/api/workers/:id', async (request, reply) => {
    const res = await deps.controlPlane.proxyRequest(
      'GET',
      `/api/v1/workers/${encodeURIComponent(request.params.id)}`,
    );
    const body: unknown = await res.json();
    return reply.code(res.status).send(body);
  });
}
