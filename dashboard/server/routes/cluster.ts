import type { FastifyInstance } from 'fastify';
import type { RouteDeps } from './deps.js';

export function registerClusterRoutes(app: FastifyInstance, deps: RouteDeps): void {
  // GET /api/cluster/status — with Redis fallback
  app.get('/api/cluster/status', async (_request, reply) => {
    try {
      const { status, data } = await deps.controlPlane.getClusterStatus();
      return reply.code(status).send(data);
    } catch {
      app.log.warn('Control plane unavailable for getClusterStatus, falling back to Redis');
      const partial = await deps.redis.getClusterStatus();
      return reply.code(200).send({ ...partial, source: 'redis-fallback' });
    }
  });

  // GET /api/cluster/memory — no Redis fallback (per-device breakdown not in Redis)
  app.get('/api/cluster/memory', async (_request, reply) => {
    const { status, data } = await deps.controlPlane.getClusterMemory();
    return reply.code(status).send(data);
  });
}
