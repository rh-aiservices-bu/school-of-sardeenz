import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';

import type { Config } from './config.js';
import type { RouteDeps } from './routes/deps.js';
import { BffError } from './errors.js';
import { authPlugin } from './plugins/auth.js';
import { registerProbes } from './health/probes.js';
import { registerAuthRoutes } from './routes/auth.js';
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

  // Auth plugin MUST be registered before routes
  await app.register(authPlugin, { config: deps.config });

  registerProbes(app, deps.routes);
  registerAuthRoutes(app, deps.config);
  registerModelRoutes(app, deps.routes);
  registerWorkerRoutes(app, deps.routes);
  registerClusterRoutes(app, deps.routes);
  registerMetricsRoutes(app, deps.routes);
  registerEventRoutes(app, deps.routes);

  // In production, serve the frontend SPA from dist/client/
  const serverDir = dirname(fileURLToPath(import.meta.url));
  const clientDir = join(serverDir, '..', 'client');

  if (process.env['NODE_ENV'] === 'production' && existsSync(clientDir)) {
    await app.register(fastifyStatic, {
      root: clientDir,
      prefix: '/',
      wildcard: false,
    });

    // SPA fallback: serve index.html for non-API routes (client-side routing)
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) {
        return reply.code(404).send({ error: 'Not found', code: 'NOT_FOUND' });
      }
      return reply.sendFile('index.html');
    });
  }

  return app;
}
