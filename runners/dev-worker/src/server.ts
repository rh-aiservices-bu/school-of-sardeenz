import Fastify from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { registerRunnerRoutes } from './routes/runners.js';
import { registerLogRoutes } from './routes/logs.js';
import type { RunnerManager } from './runner-manager.js';

export function createServer(runnerManager: RunnerManager, token: string) {
  const server = Fastify({ logger: false });

  if (token) {
    const expectedBuf = Buffer.from(token);
    server.addHook('onRequest', (request, reply) => {
      if (request.url === '/healthz') return Promise.resolve();
      const authHeader = request.headers.authorization;
      if (!authHeader?.startsWith('Bearer ')) {
        return reply.status(401).send({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
      }
      const tokenBuf = Buffer.from(authHeader.slice(7));
      if (tokenBuf.length !== expectedBuf.length || !timingSafeEqual(tokenBuf, expectedBuf)) {
        return reply.status(401).send({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
      }
      return Promise.resolve();
    });
  }

  registerRunnerRoutes(server, runnerManager);
  registerLogRoutes(server, runnerManager);

  server.get('/healthz', async (_req, reply) => {
    return reply.status(200).send({ status: 'ok' });
  });

  return server;
}
