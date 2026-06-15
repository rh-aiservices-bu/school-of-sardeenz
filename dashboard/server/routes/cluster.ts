import type { FastifyInstance } from 'fastify';
import { BffError } from '../errors.js';
import type { RouteDeps } from './deps.js';

export function registerClusterRoutes(app: FastifyInstance, deps: RouteDeps): void {
  // GET /api/cluster/status — with Redis fallback
  app.get('/api/cluster/status', { preHandler: [app.authenticate, app.requireRole('admin-readonly')] }, async (_request, reply) => {
    try {
      const { status, data } = await deps.controlPlane.getClusterStatus();
      return reply.code(status).send(data);
    } catch (err) {
      if (!(err instanceof BffError)) throw err;
      app.log.warn('Control plane unavailable for getClusterStatus, falling back to Redis');
      const partial = await deps.redis.getClusterStatus();
      return reply.code(200).send({ ...partial, source: 'redis-fallback' });
    }
  });

  // GET /api/cluster/memory — with Redis fallback
  app.get('/api/cluster/memory', { preHandler: [app.authenticate, app.requireRole('admin-readonly')] }, async (_request, reply) => {
    try {
      const { status, data } = await deps.controlPlane.getClusterMemory();
      return reply.code(status).send(data);
    } catch (err) {
      if (!(err instanceof BffError)) throw err;
      app.log.warn('Control plane unavailable for getClusterMemory, falling back to Redis');
      const memory = await deps.redis.getClusterMemory();
      if (memory === null) throw BffError.upstreamError('Control plane unreachable and no cached memory data');
      return reply.code(200).send({ ...memory, source: 'redis-fallback' });
    }
  });
}
