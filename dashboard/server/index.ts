import { loadRootEnv } from './load-env.js';
import { loadConfig, validateAuthConfig, redactUrl } from './config.js';
import { buildServer } from './server.js';
import { ControlPlaneClient } from './clients/control-plane.js';
import { RedisReader } from './clients/redis.js';
import { PrometheusClient } from './clients/prometheus.js';
import { InferenceClient } from './clients/inference.js';

async function main(): Promise<void> {
  loadRootEnv();
  const config = loadConfig();
  validateAuthConfig(config);

  const controlPlane = new ControlPlaneClient(config);
  const redis = new RedisReader(config);
  const prometheus = new PrometheusClient(config);
  const inference = new InferenceClient(config);

  const app = await buildServer({
    config,
    routes: { config, controlPlane, redis, prometheus, inference },
  });

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'Shutting down');
    await app.close();
    redis.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ host: config.listenAddr, port: config.listenPort });
  app.log.info(
    {
      address: `${config.listenAddr}:${config.listenPort}`,
      controlPlaneUrl: redactUrl(config.controlPlaneUrl),
      redisUrl: redactUrl(config.redisUrl),
      prometheusUrl: redactUrl(config.prometheusUrl),
      inferenceUrl: redactUrl(config.inferenceUrl),
    },
    'Dashboard BFF started',
  );
}

main().catch((err: unknown) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
