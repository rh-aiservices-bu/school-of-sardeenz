import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import { RunnerManager } from '../runner-manager.js';
import { registerRunnerRoutes } from '../routes/runners.js';
import type { WorkerRegistration } from '../registration.js';
import type { DevWorkerConfig } from '../config.js';
import type { LaunchHandle, LaunchSpec, RunnerLauncher } from '../launcher.js';

function makeConfig(): DevWorkerConfig {
  return {
    redisUrl: 'redis://localhost:6379',
    redisKeyPrefix: 'sardeenz',
    workerId: 'runner-route-worker',
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

// A launcher that resolves instantly without starting any real process or stub server — the
// GET /runners/:runnerId route only needs a RunnerManager with a live runner record.
const instantLauncher: RunnerLauncher = {
  serializeColdStarts: false,
  start: (spec: LaunchSpec): Promise<LaunchHandle> =>
    Promise.resolve({
      host: 'localhost',
      port: spec.port,
      enginePort: spec.enginePort,
      stop: () => Promise.resolve(),
    }),
};

describe('GET /runners/:runnerId (liveness probe, #166)', () => {
  const config = makeConfig();
  const manager = new RunnerManager(config, makeRegistration(), instantLauncher);
  const server = Fastify({ logger: false });
  let baseUrl: string;

  beforeAll(async () => {
    registerRunnerRoutes(server, manager);
    baseUrl = await server.listen({ port: 0, host: '127.0.0.1' });
  });

  afterAll(async () => {
    await manager.stopAll();
    await server.close();
  });

  it('returns 404 for an unknown runner', async () => {
    const res = await fetch(`${baseUrl}/runners/runner-does-not-exist`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe('NOT_FOUND');
  });

  it('returns 404 for an unknown instance identity', async () => {
    const res = await fetch(`${baseUrl}/runners/by-instance/inst-does-not-exist/status`);
    expect(res.status).toBe(404);
  });

  it('returns 200 for a running runner, then 404 again after it is stopped', async () => {
    const { runnerId } = await manager.startRunner({
      modelName: 'liveness-model',
      instanceId: 'inst-liveness-model',
      runnerType: 'vllm',
      modelPath: '/models/liveness',
      requiredMemory: 1024 * 1024 * 1024,
      tensorParallel: 1,
      devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
    });

    const upRes = await fetch(`${baseUrl}/runners/${runnerId}`);
    expect(upRes.status).toBe(200);
    const upBody = (await upRes.json()) as { runnerId: string; instanceId: string };
    expect(upBody.runnerId).toBe(runnerId);
    expect(upBody.instanceId).toBe('inst-liveness-model');

    const byInstanceRes = await fetch(`${baseUrl}/runners/by-instance/inst-liveness-model/status`);
    expect(byInstanceRes.status).toBe(200);
    expect(await byInstanceRes.json()).toMatchObject({
      instanceId: 'inst-liveness-model',
      runnerId,
      state: 'READY',
      host: 'localhost',
      port: 19600,
      enginePort: 19601,
    });

    await manager.stopRunner(runnerId);

    const goneRes = await fetch(`${baseUrl}/runners/${runnerId}`);
    expect(goneRes.status).toBe(404);
  });

  it('returns 202 with the assigned runner id while startup is in flight', async () => {
    let finish!: (handle: LaunchHandle) => void;
    const deferredLauncher: RunnerLauncher = {
      serializeColdStarts: false,
      start: () =>
        new Promise<LaunchHandle>((resolve) => {
          finish = resolve;
        }),
    };
    const pendingManager = new RunnerManager(makeConfig(), makeRegistration(), deferredLauncher);
    const pendingServer = Fastify({ logger: false });
    registerRunnerRoutes(pendingServer, pendingManager);
    const pendingBaseUrl = await pendingServer.listen({ port: 0, host: '127.0.0.1' });

    const start = pendingManager.startRunner({
      modelName: 'pending-model',
      instanceId: 'inst-pending-model',
      runnerType: 'vllm',
      modelPath: '/models/pending',
      requiredMemory: 1024,
      tensorParallel: 1,
      devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
    });
    const response = await fetch(`${pendingBaseUrl}/runners/by-instance/inst-pending-model/status`);
    expect(response.status).toBe(202);
    const body = (await response.json()) as { runnerId: string; state: string };
    expect(body).toMatchObject({ state: 'STARTING' });
    expect(body.runnerId).toMatch(/^runner-/);

    finish({
      host: 'localhost',
      port: 19600,
      enginePort: 19601,
      stop: () => Promise.resolve(),
    });
    const started = await start;
    await pendingManager.stopRunner(started.runnerId);
    await pendingServer.close();
  });
});
