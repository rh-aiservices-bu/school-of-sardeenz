import Fastify from 'fastify';

import type { Config } from './config.js';
import type { RouteDeps } from './routes/deps.js';
import { BffError } from './errors.js';
import { registerProbes } from './health/probes.js';
import { registerModelRoutes } from './routes/models.js';
import { registerWorkerRoutes } from './routes/workers.js';
import { registerClusterRoutes } from './routes/cluster.js';
import { registerMetricsRoutes } from './routes/metrics.js';
import { registerEventRoutes } from './routes/events.js';

export interface ServerDeps {
  config: Config;
  routes: RouteDeps;
}

export async function buildServer(deps: ServerDeps) {
  const app = Fastify({
    logger: {
      level: deps.config.logLevel,
      transport:
        process.env['NODE_ENV'] !== 'production'
          ? { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss Z' } }
          : undefined,
    },
    requestIdHeader: 'x-request-id',
    genReqId: () => crypto.randomUUID(),
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof BffError) {
      return reply.code(error.statusCode).send(error.toResponse());
    }

    app.log.error({ err: error }, 'Unhandled error');
    return reply.code(500).send({
      error: 'Internal server error',
      code: 'INTERNAL_ERROR',
    });
  });

  registerProbes(app, deps.routes);
  registerModelRoutes(app, deps.routes);
  registerWorkerRoutes(app, deps.routes);
  registerClusterRoutes(app, deps.routes);
  registerMetricsRoutes(app, deps.routes);
  registerEventRoutes(app, deps.routes);

  return app;
}
