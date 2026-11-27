import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify from 'fastify';
import { RunnerManager } from '../runner-manager.js';
import { registerRunnerRoutes } from '../routes/runners.js';
import { buildEntrypointAllowlist } from '../entrypoint-allowlist.js';
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
    allowInsecureCatalog: false,
  };
}

function makeRegistration(): WorkerRegistration {
  return {
    allocateMemory: () => {},
    freeMemory: () => {},
    pushMemoryReportOnce: () => {},
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
    registerRunnerRoutes(
      server,
      manager,
      buildEntrypointAllowlist(config.apptainer.runnerEntrypoint),
    );
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
    registerRunnerRoutes(
      pendingServer,
      pendingManager,
      buildEntrypointAllowlist(config.apptainer.runnerEntrypoint),
    );
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

  it('DELETE cancels a runner whose startup is still in flight', async () => {
    let rejectLaunch!: (error: Error) => void;
    const stop = vi.fn(() => {
      rejectLaunch(new Error('cancelled'));
      return Promise.resolve();
    });
    const pendingLauncher: RunnerLauncher = {
      serializeColdStarts: false,
      start: (_spec, _onLog, _onStartupComplete, _onExit, onLaunchHandle) =>
        new Promise<LaunchHandle>((_resolve, reject) => {
          rejectLaunch = reject;
          onLaunchHandle?.({ host: 'localhost', port: 19600, enginePort: 19601, stop });
        }),
    };
    const pendingManager = new RunnerManager(makeConfig(), makeRegistration(), pendingLauncher);
    const pendingServer = Fastify({ logger: false });
    registerRunnerRoutes(
      pendingServer,
      pendingManager,
      buildEntrypointAllowlist(config.apptainer.runnerEntrypoint),
    );
    const pendingBaseUrl = await pendingServer.listen({ port: 0, host: '127.0.0.1' });
    const starting = pendingManager.startRunner({
      modelName: 'cancel-me',
      instanceId: 'inst-cancel-me',
      runnerType: 'mlserver',
      modelPath: '/models/cancel-me',
      requiredMemory: 1024,
      tensorParallel: 1,
      devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
    });
    const rejected = expect(starting).rejects.toThrow('cancelled');
    const lookup = await fetch(`${pendingBaseUrl}/runners/by-instance/inst-cancel-me/status`);
    const { runnerId } = (await lookup.json()) as { runnerId: string };

    const cancelled = await fetch(`${pendingBaseUrl}/runners/${runnerId}`, { method: 'DELETE' });

    expect(cancelled.status).toBe(204);
    await rejected;
    expect(stop).toHaveBeenCalledOnce();
    const gone = await fetch(`${pendingBaseUrl}/runners/by-instance/inst-cancel-me/status`);
    expect(gone.status).toBe(404);
    await pendingServer.close();
  });
});

// A retained failed launch ("zombie", #288) is contract-visible: without a FAILED verdict the
// control plane would see STARTING (sealed log buffer) and then 404 while the process may still
// hold VRAM, and nothing CP-facing would ever learn the runnerId it must DELETE.
describe('GET /runners/by-instance/:instanceId/status — retained failed launch (#288)', () => {
  const config = makeConfig();

  it('reports a retained failed launch as 200 FAILED, then 404 once it is deleted', async () => {
    let alive = true;
    const stop = vi.fn(() => Promise.resolve());
    const zombieLauncher: RunnerLauncher = {
      serializeColdStarts: false,
      start: (_spec, _onLog, _onStartupComplete, _onExit, onLaunchHandle) => {
        onLaunchHandle?.({
          host: 'localhost',
          port: 19600,
          enginePort: 19601,
          isAlive: () => alive,
          stop,
        });
        return Promise.reject(new Error('cold-start boom'));
      },
    };
    const manager = new RunnerManager(config, makeRegistration(), zombieLauncher);
    const server = Fastify({ logger: false });
    registerRunnerRoutes(
      server,
      manager,
      buildEntrypointAllowlist(config.apptainer.runnerEntrypoint),
    );
    const baseUrl = await server.listen({ port: 0, host: '127.0.0.1' });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await expect(
        manager.startRunner({
          modelName: 'zombie-model',
          instanceId: 'inst-zombie-route',
          runnerType: 'vllm',
          modelPath: '/models/zombie',
          requiredMemory: 1024,
          tensorParallel: 1,
          devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
        }),
      ).rejects.toThrow('cold-start boom');

      const retained = await fetch(`${baseUrl}/runners/by-instance/inst-zombie-route/status`);
      expect(retained.status).toBe(200);
      const body = (await retained.json()) as {
        instanceId: string;
        runnerId: string;
        state: string;
        host?: string;
        port?: number;
        enginePort?: number;
      };
      expect(body.instanceId).toBe('inst-zombie-route');
      expect(body.runnerId).toMatch(/^runner-/);
      expect(body.state).toBe('FAILED');
      // No endpoint: the launch never became usable, so there is nothing to route to.
      expect(body.host).toBeUndefined();
      expect(body.port).toBeUndefined();
      expect(body.enginePort).toBeUndefined();

      // Retained launches stay out of the registry (#286's reverse sweep must not see a phantom).
      const registry = await fetch(`${baseUrl}/runners`);
      expect(await registry.json()).toEqual({ runners: [] });

      alive = false;
      const deleted = await fetch(`${baseUrl}/runners/${body.runnerId}`, { method: 'DELETE' });
      expect(deleted.status).toBe(204);

      const gone = await fetch(`${baseUrl}/runners/by-instance/inst-zombie-route/status`);
      expect(gone.status).toBe(404);
    } finally {
      errorSpy.mockRestore();
      warnSpy.mockRestore();
      await manager.stopAll();
      await server.close();
    }
  });
});

// The list endpoint exists so the control plane's reverse reconciliation can find a runner whose
// instance record it has lost (#286) — including one whose launch it lost track of mid-flight.
describe('GET /runners (registry enumeration, #286)', () => {
  const config = makeConfig();

  type ListBody = {
    runners: Array<{
      runnerId: string;
      instanceId: string;
      modelName: string;
      state: string;
      host?: string;
      port?: number;
      enginePort?: number;
    }>;
  };

  async function buildHarness(launcher: RunnerLauncher = instantLauncher) {
    const manager = new RunnerManager(makeConfig(), makeRegistration(), launcher);
    const server = Fastify({ logger: false });
    registerRunnerRoutes(
      server,
      manager,
      buildEntrypointAllowlist(config.apptainer.runnerEntrypoint),
    );
    const baseUrl = await server.listen({ port: 0, host: '127.0.0.1' });
    return {
      manager,
      baseUrl,
      close: async () => {
        await manager.stopAll();
        await server.close();
      },
    };
  }

  function startRunnerFor(manager: RunnerManager, modelName: string, instanceId: string) {
    return manager.startRunner({
      modelName,
      instanceId,
      runnerType: 'vllm',
      modelPath: `/models/${modelName}`,
      requiredMemory: 1024 * 1024 * 1024,
      tensorParallel: 1,
      devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
    });
  }

  // The pending registry entry is published after the (async) port allocation, so the STARTING
  // cases wait for the launcher call itself instead of polling: `start()` runs after the pending
  // entry is registered, and its promise stays unresolved, so the registry cannot have moved on.
  function deferredLauncher() {
    const launched: { promise: Promise<void>; resolve: () => void } = (() => {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => {
        resolve = r;
      });
      return { promise, resolve };
    })();
    let finish!: (handle: LaunchHandle) => void;
    const launcher: RunnerLauncher = {
      serializeColdStarts: false,
      start: () => {
        launched.resolve();
        return new Promise<LaunchHandle>((resolve) => {
          finish = resolve;
        });
      },
    };
    return { launcher, launched: launched.promise, finish: (h: LaunchHandle) => finish(h) };
  }

  async function listRunners(baseUrl: string): Promise<ListBody> {
    const res = await fetch(`${baseUrl}/runners`);
    expect(res.status).toBe(200);
    return (await res.json()) as ListBody;
  }

  it('returns an empty registry on a fresh worker', async () => {
    const { baseUrl, close } = await buildHarness();
    try {
      expect(await listRunners(baseUrl)).toEqual({ runners: [] });
    } finally {
      await close();
    }
  });

  it('lists a READY runner with its instance identity and ports', async () => {
    const { manager, baseUrl, close } = await buildHarness();
    try {
      const { runnerId } = await startRunnerFor(manager, 'listed-model', 'inst-listed-model');

      const body = await listRunners(baseUrl);
      expect(body.runners).toHaveLength(1);
      expect(body.runners[0]).toMatchObject({
        runnerId,
        instanceId: 'inst-listed-model',
        modelName: 'listed-model',
        state: 'READY',
        host: 'localhost',
        port: 19600,
        enginePort: 19601,
      });
    } finally {
      await close();
    }
  });

  it('lists a launch still in flight as STARTING without endpoint fields', async () => {
    const deferred = deferredLauncher();
    const { manager, baseUrl, close } = await buildHarness(deferred.launcher);
    try {
      const starting = startRunnerFor(manager, 'starting-model', 'inst-starting-model');
      await deferred.launched;

      const body = await listRunners(baseUrl);
      expect(body.runners).toHaveLength(1);
      expect(body.runners[0]).toMatchObject({
        instanceId: 'inst-starting-model',
        modelName: 'starting-model',
        state: 'STARTING',
      });
      expect(body.runners[0]).not.toHaveProperty('host');
      expect(body.runners[0]).not.toHaveProperty('port');
      expect(body.runners[0]).not.toHaveProperty('enginePort');

      deferred.finish({
        host: 'localhost',
        port: 19600,
        enginePort: 19601,
        stop: () => Promise.resolve(),
      });
      await starting;

      const ready = await listRunners(baseUrl);
      expect(ready.runners).toHaveLength(1);
      expect(ready.runners[0]).toMatchObject({ state: 'READY', port: 19600, enginePort: 19601 });
    } finally {
      await close();
    }
  });

  it('lists a READY runner and an in-flight launch together, each with its own state', async () => {
    // First start() call resolves instantly; the second is held open so the registry holds one
    // READY and one STARTING entry at the same time.
    const deferred = deferredLauncher();
    let call = 0;
    const mixedLauncher: RunnerLauncher = {
      serializeColdStarts: false,
      start: (spec: LaunchSpec) => {
        call += 1;
        if (call === 2) return deferred.launcher.start(spec);
        return Promise.resolve({
          host: 'localhost',
          port: spec.port,
          enginePort: spec.enginePort,
          stop: () => Promise.resolve(),
        });
      },
    };
    const { manager, baseUrl, close } = await buildHarness(mixedLauncher);
    try {
      const ready = await startRunnerFor(manager, 'mixed-model', 'inst-mixed-ready');
      const starting = startRunnerFor(manager, 'mixed-model', 'inst-mixed-starting');
      await deferred.launched;

      const body = await listRunners(baseUrl);
      expect(body.runners).toHaveLength(2);
      const byInstance = new Map(body.runners.map((r) => [r.instanceId, r]));
      expect(byInstance.get('inst-mixed-ready')).toMatchObject({
        runnerId: ready.runnerId,
        state: 'READY',
      });
      expect(byInstance.get('inst-mixed-starting')).toMatchObject({ state: 'STARTING' });

      deferred.finish({
        host: 'localhost',
        port: 19600,
        enginePort: 19601,
        stop: () => Promise.resolve(),
      });
      await starting;
    } finally {
      await close();
    }
  });

  it('drops a runner from the registry once it is stopped', async () => {
    const { manager, baseUrl, close } = await buildHarness();
    try {
      const { runnerId } = await startRunnerFor(manager, 'stopped-model', 'inst-stopped-model');
      expect((await listRunners(baseUrl)).runners).toHaveLength(1);

      const res = await fetch(`${baseUrl}/runners/${runnerId}`, { method: 'DELETE' });
      expect(res.status).toBe(204);

      expect(await listRunners(baseUrl)).toEqual({ runners: [] });
    } finally {
      await close();
    }
  });
});

// A repeat start for one instanceId must not spawn a second process (#288): the route answers
// 201 only when this request spawned, 200 when it returned a runner it did not spawn.
describe('POST /runners idempotency (#288)', () => {
  async function buildHarness() {
    const manager = new RunnerManager(makeConfig(), makeRegistration(), instantLauncher);
    const server = Fastify({ logger: false });
    registerRunnerRoutes(
      server,
      manager,
      buildEntrypointAllowlist(makeConfig().apptainer.runnerEntrypoint),
    );
    const baseUrl = await server.listen({ port: 0, host: '127.0.0.1' });
    return {
      manager,
      baseUrl,
      close: async () => {
        await manager.stopAll();
        await server.close();
      },
    };
  }

  function makeBody(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      modelName: 'idem-route-model',
      instanceId: 'inst-idem',
      runnerType: 'vllm',
      modelPath: '/models/idem',
      requiredMemory: 1024 * 1024 * 1024,
      tensorParallel: 1,
      devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
      ...overrides,
    });
  }

  function post(baseUrl: string, body: string) {
    return fetch(`${baseUrl}/runners`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
  }

  it('POST /runners twice with the same instanceId answers 201 then 200 with reused: true', async () => {
    const { baseUrl, close } = await buildHarness();
    try {
      const r1 = await post(baseUrl, makeBody());
      expect(r1.status).toBe(201);
      const first = (await r1.json()) as { runnerId: string };

      const r2 = await post(baseUrl, makeBody());
      expect(r2.status).toBe(200);
      const second = (await r2.json()) as { runnerId: string; reused?: boolean };
      expect(second.runnerId).toBe(first.runnerId);
      expect(second.reused).toBe(true);
    } finally {
      await close();
    }
  });

  it('POST /runners with the same instanceId and a different modelPath answers 409', async () => {
    const { baseUrl, close } = await buildHarness();
    try {
      const r1 = await post(baseUrl, makeBody());
      expect(r1.status).toBe(201);
      const first = (await r1.json()) as { runnerId: string };

      const r2 = await post(baseUrl, makeBody({ modelPath: '/models/other' }));
      expect(r2.status).toBe(409);
      const body = (await r2.json()) as { error: string; code: string };
      expect(body.code).toBe('CONFLICT');
      expect(body.error).toContain(first.runnerId);
    } finally {
      await close();
    }
  });

  it('POST /runners without an instanceId twice answers 201 twice', async () => {
    const { baseUrl, close } = await buildHarness();
    try {
      const body = makeBody({ instanceId: undefined });
      const r1 = await post(baseUrl, body);
      expect(r1.status).toBe(201);
      const first = (await r1.json()) as { runnerId: string };

      const r2 = await post(baseUrl, body);
      expect(r2.status).toBe(201);
      const second = (await r2.json()) as { runnerId: string };
      expect(second.runnerId).not.toBe(first.runnerId);
    } finally {
      await close();
    }
  });
});

// The weights opt-in crosses the CP→worker edge as a boolean and must survive into the launch
// spec the launcher receives (#336); garbage is rejected, never coerced.
describe('POST /runners weights opt-in (#336)', () => {
  async function buildHarness() {
    const specs: LaunchSpec[] = [];
    const capturing: RunnerLauncher = {
      serializeColdStarts: false,
      start: (spec: LaunchSpec): Promise<LaunchHandle> => {
        specs.push(spec);
        return Promise.resolve({
          host: 'localhost',
          port: spec.port,
          enginePort: spec.enginePort,
          stop: () => Promise.resolve(),
        });
      },
    };
    const manager = new RunnerManager(makeConfig(), makeRegistration(), capturing);
    const server = Fastify({ logger: false });
    registerRunnerRoutes(
      server,
      manager,
      buildEntrypointAllowlist(makeConfig().apptainer.runnerEntrypoint),
    );
    const baseUrl = await server.listen({ port: 0, host: '127.0.0.1' });
    return {
      specs,
      baseUrl,
      close: async () => {
        await manager.stopAll();
        await server.close();
      },
    };
  }

  function makeBody(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      modelName: 'weights-route-model',
      instanceId: 'inst-weights-route',
      runnerType: 'vllm',
      modelPath: '/models/weights',
      requiredMemory: 1024 * 1024 * 1024,
      tensorParallel: 1,
      devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
      ...overrides,
    });
  }

  function post(baseUrl: string, body: string) {
    return fetch(`${baseUrl}/runners`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
  }

  it('rejects a non-boolean allowUnsafeWeights and launches nothing', async () => {
    const { specs, baseUrl, close } = await buildHarness();
    try {
      const res = await post(baseUrl, makeBody({ allowUnsafeWeights: 'maybe' }));
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe('BAD_REQUEST');
      expect(specs).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it('forwards allowUnsafeWeights into the launch spec', async () => {
    const { specs, baseUrl, close } = await buildHarness();
    try {
      const res = await post(baseUrl, makeBody({ allowUnsafeWeights: true }));
      expect(res.status).toBe(201);
      expect(specs[0]?.allowUnsafeWeights).toBe(true);
    } finally {
      await close();
    }
  });

  it('omits allowUnsafeWeights from the launch spec by default', async () => {
    const { specs, baseUrl, close } = await buildHarness();
    try {
      const res = await post(baseUrl, makeBody());
      expect(res.status).toBe(201);
      expect(specs[0]?.allowUnsafeWeights).toBeUndefined();
    } finally {
      await close();
    }
  });
});
