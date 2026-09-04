// Playwright globalSetup (#155): fail fast when dist/client is stale relative to client
// source or public assets, so `npx playwright test` against an unbuilt/old dist can never
// give a false-green signal (dist/client had been stale for a month before #128/#155).
// `npm run test:e2e` runs `vite build &&` first, so dist is always fresh there; CI does the
// same (`.github/workflows/ci.yml` runs `npm run test:e2e`). Set SKIP_DIST_FRESHNESS_CHECK=1
// to bypass for a deliberate run against a hand-built dist.
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DASHBOARD = dirname(fileURLToPath(import.meta.url)) + '/..'; // e2e/ -> dashboard/

function newestMtime(path: string): number {
  const st = lstatSync(path);
  if (st.isSymbolicLink()) {
    throw new Error(`[e2e] symbolic links are not supported in client source: ${path}`);
  }
  if (!st.isDirectory()) return st.mtimeMs;
  let newest = st.mtimeMs;
  for (const name of readdirSync(path)) {
    newest = Math.max(newest, newestMtime(join(path, name)));
  }
  return newest;
}

function sourceExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error: unknown) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

export function assertDistFresh(dashboardRoot: string): void {
  const distEntry = join(dashboardRoot, 'dist', 'client', 'index.html');
  const hint =
    'Run `npm run test:e2e` (which builds first), or `npm run build` before `npx playwright test`. ' +
    'Set SKIP_DIST_FRESHNESS_CHECK=1 to bypass.';

  if (!existsSync(distEntry)) {
    throw new Error(`[e2e] dist/client/index.html is missing — the client is not built.\n${hint}`);
  }

  const distMtime = newestMtime(distEntry);
  const sources = [
    join(dashboardRoot, 'src'),
    join(dashboardRoot, 'public'),
    join(dashboardRoot, 'index.html'),
    join(dashboardRoot, 'vite.config.ts'),
  ].filter(sourceExists);
  if (sources.length === 0) {
    throw new Error(`[e2e] client source is missing.\n${hint}`);
  }
  const srcMtime = Math.max(...sources.map(newestMtime));

  if (srcMtime > distMtime) {
    throw new Error(
      `[e2e] dist/client is older than the client source — you are testing a stale build.\n${hint}`,
    );
  }
}

export default function globalSetup(): void {
  if (process.env['SKIP_DIST_FRESHNESS_CHECK']) return;
  assertDistFresh(DASHBOARD);
}
