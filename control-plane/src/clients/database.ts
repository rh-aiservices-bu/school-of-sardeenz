import pg from 'pg';

import type { Config } from '../config.js';

const { Pool } = pg;

export type DatabasePool = pg.Pool;

export function createDatabasePool(config: Config): DatabasePool {
  return new Pool({
    connectionString: config.databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
}
