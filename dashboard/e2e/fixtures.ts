/**
 * Playwright fixtures for E2E tests.
 *
 * Starts mock Control Plane + mock Prometheus, then spawns the BFF
 * pointed at those mocks. All tests share a fresh fixture scope.
 *
 * Usage in test files:
 *   import { test, expect } from './fixtures.js';
 */

import { test as base } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { MockControlPlane } from './mocks/control-plane.js';
import { MockPrometheus } from './mocks/prometheus.js';
import { RedisTestHelper, generateTestPrefix } from './helpers/redis.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..'); // dashboard/

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MockFixtures {
  mockControlPlane: MockControlPlane;
  mockPrometheus: MockPrometheus;
  testRedis: RedisTestHelper;
  bffPort: number;
}

// ---------------------------------------------------------------------------
// BFF process management
// ---------------------------------------------------------------------------

async function waitForPort(port: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok || res.status === 401 || res.status === 403) return; // auth errors mean BFF is up
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`BFF did not start on port ${port} within ${timeoutMs}ms`);
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') {
        srv.close();
        reject(new Error('Could not determine free port'));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

interface BffProcess {
  process: ChildProcess;
  port: number;
}

async function startBff(
  cpUrl: string,
  promUrl: string,
  redisKeyPrefix: string,
): Promise<BffProcess> {
  const port = await findFreePort();

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SARDEENZ_BFF_LISTEN_ADDR: `127.0.0.1:${port}`,
    SARDEENZ_CONTROL_PLANE_URL: cpUrl,
    SARDEENZ_PROMETHEUS_URL: promUrl,
    SARDEENZ_REDIS_URL: process.env['SARDEENZ_REDIS_URL'] ?? 'redis://127.0.0.1:6379',
    SARDEENZ_REDIS_KEY_PREFIX: redisKeyPrefix,
    AUTH_MODE: 'none',
    SARDEENZ_LOG_LEVEL: 'error',
    NODE_ENV: 'test',
    SARDEENZ_SERVE_STATIC: '1',
    SARDEENZ_CLIENT_DIR: join(ROOT, 'dist', 'client'),
  };

  const bffProc = spawn('node', ['--import', 'tsx', join(ROOT, 'server', 'index.ts')], {
    env,
    stdio: 'pipe',
    cwd: ROOT,
  });

  // Forward BFF stderr to process stderr only on error (keep output clean)
  bffProc.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    // Only surface fatal errors
    if (text.includes('Fatal') || text.includes('Error:')) {
      process.stderr.write(`[BFF] ${text}`);
    }
  });

  await waitForPort(port);

  return { process: bffProc, port };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

export const test = base.extend<MockFixtures>({
  // Per-test: fresh mock instances with the same servers running
  // The servers are started once per *worker* (see below via workerStorageState).
  // Here we just expose already-started instances and reset state per test.

  mockControlPlane: [
    async ({}, use) => {
      const cp = new MockControlPlane();
      await cp.start();

      await use(cp);

      await cp.stop();
    },
    { scope: 'test' },
  ],

  mockPrometheus: [
    async ({}, use) => {
      const prom = new MockPrometheus();
      await prom.start();

      await use(prom);

      await prom.stop();
    },
    { scope: 'test' },
  ],

  testRedis: [
    async ({}, use) => {
      const prefix = generateTestPrefix();
      const redis = new RedisTestHelper(prefix);
      await redis.connect();

      await use(redis);

      await redis.close();
    },
    { scope: 'test' },
  ],

  bffPort: [
    async ({ mockControlPlane, mockPrometheus, testRedis }, use) => {
      const bff = await startBff(mockControlPlane.url, mockPrometheus.url, testRedis.keyPrefix);

      await use(bff.port);

      bff.process.kill('SIGTERM');
      // Give the process a moment to clean up
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 2000);
        bff.process.on('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
    { scope: 'test' },
  ],
});

export { expect } from '@playwright/test';

// ---------------------------------------------------------------------------
// Helper to build the absolute URL for a given path against the BFF
// ---------------------------------------------------------------------------
export function bffUrl(port: number, path: string): string {
  return `http://127.0.0.1:${port}${path}`;
}

// ---------------------------------------------------------------------------
// Re-export mock types for convenience
// ---------------------------------------------------------------------------
export type { MockControlPlane, MockPrometheus };
export type { RedisTestHelper } from './helpers/redis.js';
export type {
  MockModelInfo,
  MockWorkerInfo,
  MockWorkerDetail,
  MockSseEvent,
} from './mocks/control-plane.js';
