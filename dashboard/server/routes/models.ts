import type { FastifyInstance } from 'fastify';
import type { RouteDeps } from './deps.js';

export function registerModelRoutes(app: FastifyInstance, deps: RouteDeps): void {
  app.post('/api/models', async (request, reply) => {
    const res = await deps.controlPlane.proxyRequest('POST', '/api/v1/models', request.body);
    const body: unknown = await res.json();
    return reply.code(res.status).send(body);
  });

  app.get('/api/models', async (request, reply) => {
    const queryString = new URLSearchParams(request.query as Record<string, string>).toString();
    const path = queryString ? `/api/v1/models?${queryString}` : '/api/v1/models';
    const res = await deps.controlPlane.proxyRequest('GET', path);
    const body: unknown = await res.json();
    return reply.code(res.status).send(body);
  });

  app.get<{ Params: { name: string } }>('/api/models/:name', async (request, reply) => {
    const res = await deps.controlPlane.proxyRequest(
      'GET',
      `/api/v1/models/${encodeURIComponent(request.params.name)}`,
    );
    const body: unknown = await res.json();
    return reply.code(res.status).send(body);
  });

  app.delete<{ Params: { name: string } }>('/api/models/:name', async (request, reply) => {
    const res = await deps.controlPlane.proxyRequest(
      'DELETE',
      `/api/v1/models/${encodeURIComponent(request.params.name)}`,
    );
    const body: unknown = await res.json();
    return reply.code(res.status).send(body);
  });

  app.post<{ Params: { name: string } }>('/api/models/:name/sleep', async (request, reply) => {
    const res = await deps.controlPlane.proxyRequest(
      'POST',
      `/api/v1/models/${encodeURIComponent(request.params.name)}/sleep`,
    );
    const body: unknown = await res.json();
    return reply.code(res.status).send(body);
  });

  app.post<{ Params: { name: string } }>('/api/models/:name/wake', async (request, reply) => {
    const res = await deps.controlPlane.proxyRequest(
      'POST',
      `/api/v1/models/${encodeURIComponent(request.params.name)}/wake`,
    );
    const body: unknown = await res.json();
    return reply.code(res.status).send(body);
  });
}
