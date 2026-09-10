import type { FastifyInstance } from 'fastify';
import type { ControlPlaneComponents } from '@sardeenz/types';
import { BffError } from '../errors.js';
import type { RouteDeps } from './deps.js';

export function registerModelRoutes(app: FastifyInstance, deps: RouteDeps): void {
  // POST /api/models — deploy a new model (write op: no Redis fallback)
  app.post(
    '/api/models',
    { preHandler: [app.authenticate, app.requireRole('admin')] },
    async (request, reply) => {
      const { status, data } = await deps.controlPlane.deployModel(request.body);
      return reply.code(status).send(data);
    },
  );

  // GET /api/models — list models with Redis fallback
  app.get(
    '/api/models',
    { preHandler: [app.authenticate, app.requireRole('admin-readonly')] },
    async (request, reply) => {
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
    },
  );

  // GET /api/models/:name — get model detail with Redis fallback
  app.get<{ Params: { name: string } }>(
    '/api/models/:name',
    { preHandler: [app.authenticate, app.requireRole('admin-readonly')] },
    async (request, reply) => {
      const { name } = request.params;
      try {
        const { status, data } = await deps.controlPlane.getModel(name);
        return reply.code(status).send(data);
      } catch (err) {
        if (!(err instanceof BffError)) throw err;
        app.log.warn(
          { modelName: name },
          'Control plane unavailable for getModel, falling back to Redis',
        );
        const model = await deps.redis.getModel(name);
        if (model === null) {
          throw BffError.notFound(name);
        }
        return reply.code(200).send({ ...model, source: 'redis-fallback' });
      }
    },
  );

  // DELETE /api/models/:name — write op: no Redis fallback
  app.delete<{ Params: { name: string }; Querystring: { force?: boolean | string } }>(
    '/api/models/:name',
    { preHandler: [app.authenticate, app.requireRole('admin')] },
    async (request, reply) => {
      const force = request.query.force === true || request.query.force === 'true';
      const { status, data } = await deps.controlPlane.deleteModel(request.params.name, force);
      return reply.code(status).send(data);
    },
  );

  // PUT /api/models/:name — replace a stopped model configuration
  app.put<{ Params: { name: string } }>(
    '/api/models/:name',
    { preHandler: [app.authenticate, app.requireRole('admin')] },
    async (request, reply) => {
      const { status, data } = await deps.controlPlane.updateModel(
        request.params.name,
        request.body,
      );
      return reply.code(status).send(data);
    },
  );

  // POST /api/models/:name/sleep — write op: no Redis fallback
  app.post<{ Params: { name: string } }>(
    '/api/models/:name/sleep',
    { preHandler: [app.authenticate, app.requireRole('admin')] },
    async (request, reply) => {
      const { status, data } = await deps.controlPlane.sleepModel(request.params.name);
      return reply.code(status).send(data);
    },
  );

  // POST /api/models/:name/wake — write op: no Redis fallback
  app.post<{ Params: { name: string } }>(
    '/api/models/:name/wake',
    { preHandler: [app.authenticate, app.requireRole('admin')] },
    async (request, reply) => {
      const { status, data } = await deps.controlPlane.wakeModel(request.params.name);
      return reply.code(status).send(data);
    },
  );

  // POST /api/models/:name/stop — write op: no Redis fallback
  app.post<{ Params: { name: string }; Querystring: { force?: boolean | string } }>(
    '/api/models/:name/stop',
    { preHandler: [app.authenticate, app.requireRole('admin')] },
    async (request, reply) => {
      const force = request.query.force === true || request.query.force === 'true';
      const { status, data } = await deps.controlPlane.stopModel(request.params.name, force);
      return reply.code(status).send(data);
    },
  );

  // POST /api/models/:name/start — write op: no Redis fallback
  app.post<{ Params: { name: string } }>(
    '/api/models/:name/start',
    { preHandler: [app.authenticate, app.requireRole('admin')] },
    async (request, reply) => {
      const { status, data } = await deps.controlPlane.startModel(request.params.name);
      return reply.code(status).send(data);
    },
  );

  // POST /api/models/:name/instances — create a replica instance: no Redis fallback
  app.post<{ Params: { name: string } }>(
    '/api/models/:name/instances',
    { preHandler: [app.authenticate, app.requireRole('admin')] },
    async (request, reply) => {
      const { status, data } = await deps.controlPlane.createInstance(request.params.name);
      return reply.code(status).send(data);
    },
  );

  // DELETE /api/models/:name/instances/:instanceId — write op: no Redis fallback
  app.delete<{ Params: { name: string; instanceId: string } }>(
    '/api/models/:name/instances/:instanceId',
    { preHandler: [app.authenticate, app.requireRole('admin')] },
    async (request, reply) => {
      const { status, data } = await deps.controlPlane.deleteInstance(
        request.params.name,
        request.params.instanceId,
      );
      return reply.code(status).send(data);
    },
  );

  // POST /api/models/:name/instances/:instanceId/sleep — write op: no Redis fallback
  app.post<{ Params: { name: string; instanceId: string } }>(
    '/api/models/:name/instances/:instanceId/sleep',
    { preHandler: [app.authenticate, app.requireRole('admin')] },
    async (request, reply) => {
      const { status, data } = await deps.controlPlane.sleepInstance(
        request.params.name,
        request.params.instanceId,
      );
      return reply.code(status).send(data);
    },
  );

  // POST /api/models/:name/instances/:instanceId/wake — write op: no Redis fallback
  app.post<{ Params: { name: string; instanceId: string } }>(
    '/api/models/:name/instances/:instanceId/wake',
    { preHandler: [app.authenticate, app.requireRole('admin')] },
    async (request, reply) => {
      const { status, data } = await deps.controlPlane.wakeInstance(
        request.params.name,
        request.params.instanceId,
      );
      return reply.code(status).send(data);
    },
  );

  // POST /api/models/:name/instances/:instanceId/move — administrative write, never Redis fallback.
  app.post<{ Params: { name: string; instanceId: string } }>(
    '/api/models/:name/instances/:instanceId/move',
    { preHandler: [app.authenticate, app.requireRole('admin')] },
    async (request, reply) => {
      const { status, data } = await deps.controlPlane.moveInstance(
        request.params.name,
        request.params.instanceId,
        request.body as ControlPlaneComponents['schemas']['MoveModelInstanceRequest'],
      );
      return reply.code(status).send(data);
    },
  );
}
