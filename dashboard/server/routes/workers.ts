import type { FastifyInstance } from 'fastify';
import { BffError } from '../errors.js';
import type { RouteDeps } from './deps.js';

export function registerWorkerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  // GET /api/workers — list workers with Redis fallback
  app.get(
    '/api/workers',
    { preHandler: [app.authenticate, app.requireRole('admin-readonly')] },
    async (_request, reply) => {
      try {
        const { status, data } = await deps.controlPlane.listWorkers();
        return reply.code(status).send(data);
      } catch (err) {
        if (!(err instanceof BffError)) throw err;
        app.log.warn('Control plane unavailable for listWorkers, falling back to Redis');
        const workers = await deps.redis.listWorkers();
        return reply.code(200).send({ workers, source: 'redis-fallback' });
      }
    },
  );

  // GET /api/workers/:id — with Redis fallback
  app.get<{ Params: { id: string } }>(
    '/api/workers/:id',
    { preHandler: [app.authenticate, app.requireRole('admin-readonly')] },
    async (request, reply) => {
      try {
        const { status, data } = await deps.controlPlane.getWorker(request.params.id);
        return reply.code(status).send(data);
      } catch (err) {
        if (!(err instanceof BffError)) throw err;
        app.log.warn(
          { workerId: request.params.id },
          'Control plane unavailable for getWorker, falling back to Redis',
        );
        const worker = await deps.redis.getWorkerDetail(request.params.id);
        if (worker === null) throw BffError.notFound(request.params.id);
        return reply.code(200).send({ ...worker, source: 'redis-fallback' });
      }
    },
  );
}
