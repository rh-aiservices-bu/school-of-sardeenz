import type { FastifyInstance } from 'fastify';
import type { RouteDeps } from '../routes/deps.js';

export function registerProbes(app: FastifyInstance, deps: RouteDeps): void {
  app.get('/api/health', async (_req, reply) => {
    return reply.code(200).send({ status: 'ok' });
  });

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

    // The dashboard stays ready in degraded read-only mode as long as at
    // least one data source (control plane OR Redis) is available.  Only
    // report not-ready when both are down and no data can be served.
    const ready = cpHealthy || redisHealthy;
    const degraded = ready && !(cpHealthy && redisHealthy);

    const status = degraded ? 'degraded' : ready ? 'ready' : 'not_ready';

    return reply.code(ready ? 200 : 503).send({
      status,
      checks,
    });
  });
}
