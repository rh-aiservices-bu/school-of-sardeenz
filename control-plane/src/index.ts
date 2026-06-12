import { loadConfig, redactUrl } from './config.js';
import { createRedisClient } from './clients/redis.js';
import { createDatabasePool } from './clients/database.js';
import { buildServer } from './server.js';

async function main(): Promise<void> {
  const config = loadConfig();

  const redis = createRedisClient(config);
  const db = createDatabasePool(config);

  await redis.connect();

  const app = await buildServer({ config, redis, db });

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'Shutting down');
    await app.close();
    redis.disconnect();
    await db.end();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ host: config.listenAddr, port: config.listenPort });
  app.log.info(
    {
      address: `${config.listenAddr}:${config.listenPort}`,
      redisUrl: redactUrl(config.redisUrl),
      databaseUrl: redactUrl(config.databaseUrl),
    },
    'Control plane started',
  );
}

main().catch((err: unknown) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
