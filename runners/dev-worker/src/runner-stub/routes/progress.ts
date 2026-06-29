import type { FastifyInstance } from 'fastify';
import type { RunnerStateMachine } from '../state.js';

export function registerProgressRoutes(
  app: FastifyInstance,
  stateMachine: RunnerStateMachine,
): void {
  app.get('/progress', async (_req, reply) => {
    const progress = stateMachine.progress;
    return reply.status(200).send({
      phase: progress.phase,
      percentComplete: progress.percentComplete,
      message: progress.message,
    });
  });
}
