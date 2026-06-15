import type { FastifyInstance } from 'fastify';
import { BffError } from '../errors.js';
import type { RouteDeps } from './deps.js';

export function registerModelRoutes(app: FastifyInstance, deps: RouteDeps): void {
  // POST /api/models — deploy a new model (write op: no Redis fallback)
  app.post('/api/models', async (request, reply) => {
    const { status, data } = await deps.controlPlane.deployModel(request.body);
    return reply.code(status).send(data);
  });

  // GET /api/models — list models with Redis fallback
  app.get('/api/models', async (request, reply) => {
    const query = request.query as Record<string, string>;
    const state = query['state'];
    try {
      const { status, data } = await deps.controlPlane.listModels(state);
      return reply.code(status).send(data);
    } catch (err) {
      if (!(err instanceof BffError)) throw err;
      app.log.warn('Control plane unavailable for listModels, falling back to Redis');
      const models = await deps.redis.listModels();
      return reply.code(200).send({ models, source: 'redis-fallback' });
    }
  });

  // GET /api/models/:name — get model detail with Redis fallback
  app.get<{ Params: { name: string } }>('/api/models/:name', async (request, reply) => {
    const { name } = request.params;
    try {
      const { status, data } = await deps.controlPlane.getModel(name);
      return reply.code(status).send(data);
    } catch (err) {
      if (!(err instanceof BffError)) throw err;
      app.log.warn({ modelName: name }, 'Control plane unavailable for getModel, falling back to Redis');
      const model = await deps.redis.getModel(name);
      if (model === null) {
        throw BffError.notFound(name);
      }
      return reply.code(200).send({ ...model, source: 'redis-fallback' });
    }
  });

  // DELETE /api/models/:name — write op: no Redis fallback
  app.delete<{ Params: { name: string } }>('/api/models/:name', async (request, reply) => {
    const { status, data } = await deps.controlPlane.deleteModel(request.params.name);
    return reply.code(status).send(data);
  });

  // POST /api/models/:name/sleep — write op: no Redis fallback
  app.post<{ Params: { name: string } }>('/api/models/:name/sleep', async (request, reply) => {
    const { status, data } = await deps.controlPlane.sleepModel(request.params.name);
    return reply.code(status).send(data);
  });

  // POST /api/models/:name/wake — write op: no Redis fallback
  app.post<{ Params: { name: string } }>('/api/models/:name/wake', async (request, reply) => {
    const { status, data } = await deps.controlPlane.wakeModel(request.params.name);
    return reply.code(status).send(data);
  });
}
