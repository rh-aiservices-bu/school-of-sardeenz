import { existsSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';
import { config as dotenvConfig } from 'dotenv';

/**
 * Load the repo-root `.env` into `process.env` for local development.
 *
 * Walks up from the current working directory to the filesystem root and loads the first `.env`
 * it finds. Variables already present in the environment are never overridden, so per-process
 * overrides (e.g. `SARDEENZ_WORKER_PORT=9200 make dev-worker`) always win over the file. No-op in
 * production (`NODE_ENV=production`) and when no `.env` exists, so it is safe to call
 * unconditionally at startup.
 *
 * Kept local to each service (rather than in a shared package) so it stays a plain intra-service
 * import that compiles into the service's own `dist` — no cross-package runtime coupling.
 */
export function loadRootEnv(): void {
  if (process.env['NODE_ENV'] === 'production') return;

  let dir = process.cwd();
  const { root } = parse(dir);

  for (;;) {
    const candidate = join(dir, '.env');
    if (existsSync(candidate)) {
      dotenvConfig({ path: candidate, override: false, quiet: true });
      return;
    }
    if (dir === root) return;
    dir = dirname(dir);
  }
}
