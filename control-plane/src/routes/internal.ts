import type { FastifyInstance } from 'fastify';
import { ModelLifecycleState } from '@sardeenz/types';

import type { RouteDeps } from './deps.js';
import { ControlPlaneError } from '../errors.js';

export function registerInternalRoutes(app: FastifyInstance, deps: RouteDeps): void {
  app.post<{ Body: { modelName: string } }>('/api/v1/wake', async (request, reply) => {
    const { modelName } = request.body ?? {};
    if (!modelName || typeof modelName !== 'string') {
      throw ControlPlaneError.invalidRequest('modelName is required');
    }

    const state = await deps.lifecycle.getState(modelName);
    if (!state) {
      throw ControlPlaneError.modelNotFound(modelName);
    }

    if (state.state === ModelLifecycleState.ACTIVE) {
      return reply.code(200).send({
        accepted: true,
        modelName,
        currentState: state.state,
        message: 'Model is already active',
      });
    }

    if (state.state === ModelLifecycleState.STARTING) {
      return reply.code(202).send({
        accepted: true,
        modelName,
        currentState: state.state,
        message: 'Model is already waking up',
      });
    }

    if (state.state !== ModelLifecycleState.SLEEPING) {
      throw ControlPlaneError.invalidState(modelName, state.state, 'wake');
    }

    if (!state.runnerHost || !state.runnerPort) {
      throw new ControlPlaneError(
        500,
        'INTERNAL_ERROR',
        `Model ${modelName} has no runner endpoint`,
      );
    }

    const runnerClient = deps.createRunnerClient(state.runnerHost, state.runnerPort);

    deps.sleepWake.wakeModel(modelName, runnerClient).catch((err: unknown) => {
      app.log.error({ err, modelName }, 'Background wake failed');
    });

    return reply.code(202).send({
      accepted: true,
      modelName,
      currentState: ModelLifecycleState.STARTING,
      message: 'Wake initiated',
    });
  });

  app.get('/api/v1/routing-map', async (_request, reply) => {
    const routingMap = await deps.routingMap.getRoutingMap();
    return reply.code(200).send(routingMap);
  });
}
