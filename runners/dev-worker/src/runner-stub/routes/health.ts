import type { FastifyInstance } from 'fastify';
import type { RunnerStateMachine } from '../state.js';

export function registerHealthRoutes(app: FastifyInstance, stateMachine: RunnerStateMachine): void {
  app.get('/health', async (_req, reply) => {
    const state = stateMachine.state;
    const response: Record<string, unknown> = {
      state,
      activeRequests: stateMachine.activeRequests,
    };

    if (state === 'STARTING') {
      response.progress = stateMachine.progress;
      response.message = stateMachine.progress.message;
    }

    if (state === 'ERROR') {
      response.message = stateMachine.progress.message;
    }

    return reply.status(200).send(response);
  });
}
