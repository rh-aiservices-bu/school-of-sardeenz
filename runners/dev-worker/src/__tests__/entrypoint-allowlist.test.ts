import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import { RunnerManager } from '../runner-manager.js';
import { registerRunnerRoutes } from '../routes/runners.js';
import { buildEntrypointAllowlist } from '../entrypoint-allowlist.js';
import type { WorkerRegistration } from '../registration.js';
import type { DevWorkerConfig } from '../config.js';
import type { LaunchHandle, LaunchSpec, RunnerLauncher } from '../launcher.js';

// Same fake set as runner-route.test.ts (repo convention: local fakes, no shared fixture module).
function makeConfig(runnerEntrypoint: string[]): DevWorkerConfig {
  return {
    redisUrl: 'redis://localhost:6379',
    redisKeyPrefix: 'sardeenz',
    workerId: 'entrypoint-allowlist-worker',
    workerPort: 0,
    advertiseHost: 'localhost',
    runnerPortStart: 19800,
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
      runnerEntrypoint,
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

// A launcher that resolves instantly without starting any real process or stub server — a 201
// proves the route's entrypoint validator passed and the manager accepted the spec.
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

// Required fields per the route's own 400 gate; entrypoint varies per case.
function makeBody(entrypoint?: unknown): Record<string, unknown> {
  const body: Record<string, unknown> = {
    modelName: 'allowlist-model',
    runnerType: 'vllm',
    modelPath: '/models/allowlist',
    requiredMemory: 4 * 1024 * 1024 * 1024,
    tensorParallel: 1,
    devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
  };
  if (entrypoint !== undefined) body['entrypoint'] = entrypoint;
  return body;
}

describe('POST /runners entrypoint allowlist (module-form config)', () => {
  // The env default: build the allowlist from the config, never a drift-prone literal.
  const config = makeConfig(['python3', '-m', 'sardeenz_vllm_runner']);
  const manager = new RunnerManager(config, makeRegistration(), instantLauncher);
  const server = Fastify({ logger: false });

  beforeAll(async () => {
    registerRunnerRoutes(
      server,
      manager,
      buildEntrypointAllowlist(config.apptainer.runnerEntrypoint),
    );
    await server.ready();
  });

  afterAll(async () => {
    await manager.stopAll();
    await server.close();
  });

  async function post(entrypoint?: unknown, instanceId?: string) {
    return server.inject({
      method: 'POST',
      url: '/runners',
      payload: { ...makeBody(entrypoint), ...(instanceId ? { instanceId } : {}) },
      headers: { 'content-type': 'application/json' },
    });
  }

  it('rejects a bash -c argv with 400 and spawns nothing', async () => {
    const res = await post(['bash', '-c', 'id > /tmp/pwn'], 'inst-bash-case');
    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: string; code: string }>();
    expect(body.code).toBe('BAD_REQUEST');
    expect(body.error).toMatch(/entrypoint/);
    const status = await server.inject({
      method: 'GET',
      url: '/runners/by-instance/inst-bash-case/status',
    });
    expect(status.statusCode).toBe(404);
  });

  it('rejects an unknown shim module', async () => {
    const res = await post(['python3', '-m', 'not_a_shim'], 'inst-unknown-module');
    expect(res.statusCode).toBe(400);
    expect(res.json<{ code: string }>().code).toBe('BAD_REQUEST');
  });

  it('rejects a -m vector whose exec differs from the configured exec0', async () => {
    const res = await post(['bash', '-m', 'sardeenz_vllm_runner'], 'inst-exec-mismatch');
    expect(res.statusCode).toBe(400);
  });

  it('rejects a non--m flag form', async () => {
    const res = await post(['python3', '-c', 'import os'], 'inst-c-flag');
    expect(res.statusCode).toBe(400);
  });

  it('accepts the catalog (mlserver) argv', async () => {
    const res = await post(['python3', '-m', 'sardeenz_mlserver_runner'], 'inst-mlserver');
    expect(res.statusCode).toBe(201);
  });

  it('accepts an absent entrypoint field (worker default applies)', async () => {
    const res = await post(undefined, 'inst-absent');
    expect(res.statusCode).toBe(201);
  });

  it('accepts an explicit empty argv', async () => {
    const res = await post([], 'inst-empty');
    expect(res.statusCode).toBe(201);
  });

  it('accepts the configured vector verbatim', async () => {
    const res = await post(['python3', '-m', 'sardeenz_vllm_runner'], 'inst-verbatim');
    expect(res.statusCode).toBe(201);
  });

  it('forwards an accepted body argv to the launcher unchanged', async () => {
    // Regression pin: the route must validate against the allowlist but forward
    // `body.entrypoint` verbatim — not `allowlist.exact` — to the launcher.
    const captured: LaunchSpec[] = [];
    const capturingLauncher: RunnerLauncher = {
      ...instantLauncher,
      start: (spec: LaunchSpec): Promise<LaunchHandle> => {
        captured.push(spec);
        return instantLauncher.start(spec);
      },
    };
    const capturingManager = new RunnerManager(config, makeRegistration(), capturingLauncher);
    const capturingServer = Fastify({ logger: false });
    registerRunnerRoutes(
      capturingServer,
      capturingManager,
      buildEntrypointAllowlist(config.apptainer.runnerEntrypoint),
    );
    await capturingServer.ready();

    const res = await capturingServer.inject({
      method: 'POST',
      url: '/runners',
      payload: makeBody(['python3', '-m', 'sardeenz_mlserver_runner']),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(201);
    expect(captured).toHaveLength(1);
    expect(captured[0].entrypoint).toEqual(['python3', '-m', 'sardeenz_mlserver_runner']);

    await capturingManager.stopAll();
    await capturingServer.close();
  });

  it('rejects a non-string module in -m position (runtime-type pin, exercises Set.has)', async () => {
    const res = await post(['python3', '-m', 123], 'inst-nonstring');
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /runners entrypoint allowlist (non--m configured override)', () => {
  const config = makeConfig(['python3', 'sardeenz_vllm_runner.py']);
  const manager = new RunnerManager(config, makeRegistration(), instantLauncher);
  const server = Fastify({ logger: false });

  beforeAll(async () => {
    registerRunnerRoutes(
      server,
      manager,
      buildEntrypointAllowlist(config.apptainer.runnerEntrypoint),
    );
    await server.ready();
  });

  afterAll(async () => {
    await manager.stopAll();
    await server.close();
  });

  async function post(entrypoint?: unknown, instanceId?: string) {
    return server.inject({
      method: 'POST',
      url: '/runners',
      payload: { ...makeBody(entrypoint), ...(instanceId ? { instanceId } : {}) },
      headers: { 'content-type': 'application/json' },
    });
  }

  it('accepts the non--m override verbatim when the body matches it', async () => {
    const res = await post(['python3', 'sardeenz_vllm_runner.py'], 'inst-override-verbatim');
    expect(res.statusCode).toBe(201);
  });

  it('does not seed the -m family when the config is not module-form', async () => {
    const res = await post(['python3', '-m', 'sardeenz_mlserver_runner'], 'inst-override-family');
    expect(res.statusCode).toBe(400);
  });

  it('rejects a different script', async () => {
    const res = await post(['python3', 'other.py'], 'inst-override-other');
    expect(res.statusCode).toBe(400);
  });
});
