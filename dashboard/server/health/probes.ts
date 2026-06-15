import type { FastifyInstance } from 'fastify';
import type { RouteDeps } from '../routes/deps.js';

export function registerProbes(app: FastifyInstance, deps: RouteDeps): void {
  app.get('/healthz', async (_req, reply) => {
    return reply.code(200).send({ status: 'ok' });
  });

  app.get('/readyz', async (_req, reply) => {
    const checks: Record<string, string> = {};
    let ready = true;

    const cpHealthy = await deps.controlPlane.isHealthy();
    checks['controlPlane'] = cpHealthy ? 'ok' : 'error';
    if (!cpHealthy) ready = false;

    const redisHealthy = await deps.redis.isHealthy();
    checks['redis'] = redisHealthy ? 'ok' : 'error';
    if (!redisHealthy) ready = false;

    const promHealthy = await deps.prometheus.isHealthy();
    checks['prometheus'] = promHealthy ? 'ok' : 'warning';

    return reply.code(ready ? 200 : 503).send({
      status: ready ? 'ready' : 'not_ready',
      checks,
    });
  });
}
