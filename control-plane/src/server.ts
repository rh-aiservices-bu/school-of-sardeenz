import Fastify from 'fastify';

import type { Config } from './config.js';
import type { Redis } from './clients/redis.js';
import type { DatabasePool } from './clients/database.js';
import type { RouteDeps } from './routes/deps.js';
import { ControlPlaneError } from './errors.js';
import { registerProbes } from './health/probes.js';
import { registerMetricsRoute } from './health/metrics.js';
import { registerModelRoutes } from './routes/models.js';
import { registerModelLogRoutes } from './routes/model-logs.js';
import { registerWorkerRoutes } from './routes/workers.js';
import { registerClusterRoutes } from './routes/cluster.js';
import { registerInternalRoutes } from './routes/internal.js';
import { registerNotificationRoutes } from './routes/notifications.js';
import { registerCatalogRoutes } from './routes/catalog.js';
import { registerWeightsRoutes } from './routes/weights.js';

export interface ServerDeps {
  config: Config;
  redis: Redis;
  db: DatabasePool;
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
    if (error instanceof ControlPlaneError) {
      return reply.code(error.statusCode).send(error.toResponse());
    }

    app.log.error({ err: error }, 'Unhandled error');
    return reply.code(500).send({
      error: 'Internal server error',
      code: 'INTERNAL_ERROR',
    });
  });

  registerProbes(app, {
    redis: deps.redis,
    db: deps.db,
    leaderElection: deps.routes.leaderElection,
  });
  registerMetricsRoute(app);

  registerModelRoutes(app, deps.routes);
  registerModelLogRoutes(app, deps.routes);
  registerWorkerRoutes(app, deps.routes);
  registerClusterRoutes(app, deps.routes);
  registerInternalRoutes(app, deps.routes);
  registerNotificationRoutes(app, deps.routes);
  registerCatalogRoutes(app, deps.routes);
  registerWeightsRoutes(app, deps.routes);

  return app;
}
