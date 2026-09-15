// @vitest-environment node
import { describe, it, expect } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { createServer } from '../server.js';
import { RunnerManager } from '../runner-manager.js';
import type { WorkerRegistration } from '../registration.js';
import type { DevWorkerConfig } from '../config.js';

function makeConfig(): DevWorkerConfig {
  return {
    redisUrl: 'redis://localhost:6379',
    redisKeyPrefix: 'sardeenz',
    workerId: 'auth-test-worker',
    workerPort: 0,
    advertiseHost: 'localhost',
    runnerPortStart: 19600,
    maxRunners: 32,
    deviceCount: 2,
    deviceType: 'CUDA',
    deviceMemoryBytes: 24 * 1024 * 1024 * 1024,
    runnerType: 'vllm',
    startupDelayMs: 100,
    sleepDelayMs: 50,
    wakeDelayMs: 100,
    inferenceDelayMs: 50,
    heartbeatIntervalMs: 60000,
    mode: 'stub',
    apptainer: {
      apptainerBin: 'apptainer',
      modulesDir: '/modules',
      weightsDir: '/weights',
      scratchDir: '/scratch',
      binds: ['/weights', '/scratch'],
      runnerEntrypoint: ['python3', '-m', 'sardeenz_vllm_runner'],
      home: '/scratch/home',
      verifySif: true,
      healthTimeoutMs: 300000,
      healthIntervalMs: 1000,
      stopGraceMs: 15000,
      advertiseHost: 'localhost',
    },
    workerToken: '',
    catalogUrl: '',
  };
}

function makeRegistration(): WorkerRegistration {
  return {
    allocateMemory: () => {},
    freeMemory: () => {},
    getDeviceMemoryUsed: () => 0,
    register: async () => {},
    deregister: async () => {},
    startHeartbeat: () => {},
    stopHeartbeat: () => {},
  } as unknown as WorkerRegistration;
}

function buildTestApp(token: string): FastifyInstance {
  const runnerManager = new RunnerManager(makeConfig(), makeRegistration());
  return createServer(runnerManager, token);
}

describe('dev-worker API auth hook', () => {
  it('rejects a request to a protected route with no Authorization header', async () => {
    const app = buildTestApp('secret-token');
    const res = await app.inject({ method: 'DELETE', url: '/runners/some-runner' });
    expect(res.statusCode).toBe(401);
    expect(res.json<{ code: string }>().code).toBe('UNAUTHORIZED');
    await app.close();
  });

  it('rejects a request with the wrong token', async () => {
    const app = buildTestApp('secret-token');
    const res = await app.inject({
      method: 'DELETE',
      url: '/runners/some-runner',
      headers: { authorization: 'Bearer wrong-token' },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('allows a request with the correct Bearer token through to the route', async () => {
    const app = buildTestApp('secret-token');
    const res = await app.inject({
      method: 'DELETE',
      url: '/runners/some-runner',
      headers: { authorization: 'Bearer secret-token' },
    });
    // Not authenticated-rejected — the route itself 404s because the runner doesn't exist.
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('exempts /healthz even when a token is configured', async () => {
    const app = buildTestApp('secret-token');
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('allows requests without a header when no token is configured (auth disabled)', async () => {
    const app = buildTestApp('');
    const res = await app.inject({ method: 'DELETE', url: '/runners/some-runner' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
