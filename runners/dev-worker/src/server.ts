import Fastify from 'fastify';
import { registerRunnerRoutes } from './routes/runners.js';
import type { RunnerManager } from './runner-manager.js';

export function createServer(runnerManager: RunnerManager) {
  const server = Fastify({ logger: false });

  registerRunnerRoutes(server, runnerManager);

  server.get('/healthz', async (_req, reply) => {
    return reply.status(200).send({ status: 'ok' });
  });

  return server;
}
