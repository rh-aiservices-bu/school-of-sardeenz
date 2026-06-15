import type { FastifyInstance } from 'fastify';
import type { RouteDeps } from '../routes/deps.js';

export function registerProbes(app: FastifyInstance, deps: RouteDeps): void {
  app.get('/healthz', async (_req, reply) => {
    return reply.code(200).send({ status: 'ok' });
  });

  app.get('/readyz', async (_req, reply) => {
    const [cpHealthy, redisHealthy, promHealthy] = await Promise.all([
      deps.controlPlane.isHealthy(),
      deps.redis.isHealthy(),
      deps.prometheus.isHealthy(),
    ]);

    const checks: Record<string, string> = {
      controlPlane: cpHealthy ? 'ok' : 'error',
      redis: redisHealthy ? 'ok' : 'error',
      prometheus: promHealthy ? 'ok' : 'warning',
    };

    const ready = cpHealthy && redisHealthy;

    return reply.code(ready ? 200 : 503).send({
      status: ready ? 'ready' : 'not_ready',
      checks,
    });
  });
}
