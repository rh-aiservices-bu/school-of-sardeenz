import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { DatabasePool } from './database.js';

export async function runMigrations(db: DatabasePool, migrationsDir: string): Promise<number> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version integer PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const result = await db.query<{ version: number }>(
    'SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1',
  );
  const currentVersion = result.rows[0]?.version ?? 0;

  const files = await readdir(migrationsDir);
  const migrations = files
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => {
      const version = parseInt(f.split('-')[0] ?? '0', 10);
      return { version, file: f };
    })
    .filter((m) => m.version > currentVersion);

  for (const migration of migrations) {
    const sql = await readFile(join(migrationsDir, migration.file), 'utf-8');
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [migration.version]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  return migrations.length;
}
