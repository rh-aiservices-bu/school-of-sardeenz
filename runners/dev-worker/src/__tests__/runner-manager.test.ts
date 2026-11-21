import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RunnerManager, ConflictError, NotFoundError } from '../runner-manager.js';
import type { StartRunnerParams } from '../runner-manager.js';
import { RunnerLogBuffer, RETAIN_TTL_MS } from '../runner-log-buffer.js';
import { WorkerRegistration } from '../registration.js';
import type { DevWorkerConfig } from '../config.js';
import type { LaunchHandle, LaunchSpec, RunnerLauncher } from '../launcher.js';
import type { WorkerMemoryReport } from './response-types.js';

function makeConfig(overrides: Partial<DevWorkerConfig> = {}): DevWorkerConfig {
  return {
    redisUrl: 'redis://localhost:6379',
    redisKeyPrefix: 'sardeenz',
    workerId: 'test-worker-0',
    workerPort: 19300,
    advertiseHost: 'localhost',
    runnerPortStart: 19301,
    maxRunners: 32,
    deviceCount: 2,
    deviceType: 'CUDA',
    deviceMemoryBytes: 24 * 1024 * 1024 * 1024,
    runnerType: 'vllm',
    startupDelayMs: 100,
    sleepDelayMs: 50,
    wakeDelayMs: 50,
    inferenceDelayMs: 20,
    heartbeatIntervalMs: 5000,
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
    ...overrides,
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

// A launcher whose start() resolves immediately with a handle matching the spec's ports — no
// real sockets, safe to run alongside every other block in this file.
function makeFakeLauncher(): RunnerLauncher {
  return {
    serializeColdStarts: false,
    start: (spec: LaunchSpec): Promise<LaunchHandle> =>
      Promise.resolve({
        host: 'localhost',
        port: spec.port,
        enginePort: spec.enginePort,
        stop: () => Promise.resolve(),
      }),
  };
}

// Minimal tracking redis double for wiring a real WorkerRegistration into a RunnerManager —
// only what pushMemoryReport()/register() touch (set + pipeline factory), plus the set history
// the `:memory` assertions read.
function makeTrackingRedis() {
  const setHistory: Array<{ key: string; value: string }> = [];
  const pipeline = {
    set: () => pipeline,
    del: () => pipeline,
    exec: () => [],
  };
  return {
    pipeline: () => pipeline,
    set: vi.fn((...args: unknown[]) => {
      const [key, value] = args as [string, string];
      setHistory.push({ key, value });
      return 'OK';
    }),
    _setHistory: setHistory,
  };
}

// A launcher whose start() captures the onExit callback the manager wired in, so a test can fire
// it later to simulate the runner's process exiting on its own (post-startup supervision).
function makeSupervisedLauncher(): {
  launcher: RunnerLauncher;
  fireExit: (runnerId: string) => void;
} {
  const onExitByRunnerId = new Map<string, () => void>();
  const launcher: RunnerLauncher = {
    serializeColdStarts: false,
    start: (spec: LaunchSpec, _onLog, _onStartupComplete, onExit): Promise<LaunchHandle> => {
      if (onExit) onExitByRunnerId.set(spec.runnerId, onExit);
      return Promise.resolve({
        host: 'localhost',
        port: spec.port,
        enginePort: spec.enginePort,
        stop: () => Promise.resolve(),
      });
    },
  };
  return {
    launcher,
    fireExit: (runnerId) => onExitByRunnerId.get(runnerId)?.(),
  };
}

// Counts start() calls; `handle` shapes the returned LaunchHandle. `failAfterHandle` rejects the
// launch *after* the handle sink fired, i.e. a launch whose process may have survived.
function makeCountingLauncher(options: {
  pid?: number;
  isAlive?: () => boolean;
  stop?: () => Promise<void>;
  failAfterHandle?: string;
}) {
  const start = vi.fn(
    (
      spec: LaunchSpec,
      _onLog?: unknown,
      _onStartupComplete?: () => void,
      _onExit?: () => void,
      onLaunchHandle?: (handle: LaunchHandle) => void,
    ): Promise<LaunchHandle> => {
      const handle: LaunchHandle = {
        host: 'localhost',
        port: spec.port,
        enginePort: spec.enginePort,
        ...(options.pid !== undefined ? { pid: options.pid } : {}),
        ...(options.isAlive ? { isAlive: options.isAlive } : {}),
        stop: options.stop ?? (() => Promise.resolve()),
      };
      onLaunchHandle?.(handle);
      return options.failAfterHandle
        ? Promise.reject(new Error(options.failAfterHandle))
        : Promise.resolve(handle);
    },
  );
  const launcher: RunnerLauncher = { serializeColdStarts: false, start };
  return { launcher, start };
}

// One start request for the idempotency cases (#288); overrides replace individual fields.
function startParams(
  instanceId: string,
  overrides: Partial<StartRunnerParams> = {},
): StartRunnerParams {
  return {
    modelName: 'idem-model',
    instanceId,
    runnerType: 'vllm',
    modelPath: '/models/idem',
    requiredMemory: 1024 * 1024 * 1024,
    tensorParallel: 1,
    devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
    ...overrides,
  };
}

describe('RunnerManager', () => {
  let manager: RunnerManager;

  beforeEach(() => {
    manager = new RunnerManager(makeConfig(), makeRegistration());
  });

  afterEach(async () => {
    await manager.stopAll();
  });

  it('starts a runner and returns runnerId, host, port, enginePort', async () => {
    const result = await manager.startRunner({
      modelName: 'test-model',
      instanceId: 'inst-test-model',
      runnerType: 'vllm',
      modelPath: '/models/test',
      requiredMemory: 1024 * 1024 * 1024,
      tensorParallel: 1,
      devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
    });

    expect(result.runnerId).toMatch(/^runner-/);
    expect(result.host).toBe('localhost');
    expect(result.port).toBe(19301);
    // The stub is a single server, so inference is served on the management port.
    expect(result.enginePort).toBe(19301);
  });

  it('allocates ports in contiguous 4-port blocks so engine ports never collide', async () => {
    const r1 = await manager.startRunner({
      modelName: 'model-a',
      instanceId: 'inst-model-a',
      runnerType: 'vllm',
      modelPath: '/models/a',
      requiredMemory: 1024 * 1024 * 1024,
      tensorParallel: 1,
      devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
    });
    const r2 = await manager.startRunner({
      modelName: 'model-b',
      instanceId: 'inst-model-b',
      runnerType: 'vllm',
      modelPath: '/models/b',
      requiredMemory: 1024 * 1024 * 1024,
      tensorParallel: 1,
      devices: [{ deviceIndex: 1, deviceType: 'CUDA' }],
    });

    // Ports step by 4: r1 reserves the block (19301..19304), r2 reserves (19305..19308). Were the
    // manager to step by 1, r2's management port would collide with r1's engine/grpc/metrics ports.
    expect(r1.port).toBe(19301);
    expect(r2.port).toBe(19305);
  });

  it('reserves a contiguous 4-port block (mgmt, engine, grpc, metrics)', async () => {
    let capturedSpec: LaunchSpec | undefined;
    const launcher: RunnerLauncher = {
      serializeColdStarts: false,
      start: (spec: LaunchSpec): Promise<LaunchHandle> => {
        capturedSpec = spec;
        return Promise.resolve({
          host: 'localhost',
          port: spec.port,
          enginePort: spec.enginePort,
          stop: () => Promise.resolve(),
        });
      },
    };
    const mgr = new RunnerManager(makeConfig(), makeRegistration(), launcher);

    const result = await mgr.startRunner({
      modelName: 'block-model',
      instanceId: 'inst-block-model',
      runnerType: 'mlserver',
      modelPath: '/models/block-model',
      requiredMemory: 1024 * 1024 * 1024,
      tensorParallel: 1,
      devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
    });

    expect(result.port).toBe(19301);
    expect(result.enginePort).toBe(19302);
    expect(capturedSpec?.grpcPort).toBe(19303);
    expect(capturedSpec?.metricsPort).toBe(19304);
  });

  it('duplicate instanceId reuses the running runner instead of launching again (#288)', async () => {
    const first = await manager.startRunner({
      modelName: 'dupe-model',
      instanceId: 'inst-dupe-model',
      runnerType: 'vllm',
      modelPath: '/models/dupe',
      requiredMemory: 1024 * 1024 * 1024,
      tensorParallel: 1,
      devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
    });

    const second = await manager.startRunner({
      modelName: 'dupe-model',
      instanceId: 'inst-dupe-model',
      runnerType: 'vllm',
      modelPath: '/models/dupe',
      requiredMemory: 1024 * 1024 * 1024,
      tensorParallel: 1,
      devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
    });

    expect(second.runnerId).toBe(first.runnerId);
    expect(second.reused).toBe(true);
    expect(manager.getAllRunners()).toHaveLength(1);
  });

  it('cancels a runner while launcher health checks are still in progress', async () => {
    let rejectLaunch!: (error: Error) => void;
    const stop = vi.fn(() => {
      rejectLaunch(new Error('runner exited during cancelled startup'));
      return Promise.resolve();
    });
    const launcher: RunnerLauncher = {
      serializeColdStarts: false,
      start: (_spec, _onLog, _onStartupComplete, _onExit, onLaunchHandle) =>
        new Promise<LaunchHandle>((_resolve, reject) => {
          rejectLaunch = reject;
          onLaunchHandle?.({ host: 'localhost', port: 19301, enginePort: 19302, stop });
        }),
    };
    const mgr = new RunnerManager(makeConfig(), makeRegistration(), launcher);
    const starting = mgr.startRunner({
      modelName: 'cancel-me',
      instanceId: 'inst-cancel-me',
      runnerType: 'mlserver',
      modelPath: '/models/cancel-me',
      requiredMemory: 1024,
      tensorParallel: 1,
      devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
    });
    const outcome = starting.then(
      () => null,
      (error: unknown) => error,
    );
    await vi.waitFor(() =>
      expect(mgr.getRunnerIdForInstance('inst-cancel-me')).toMatch(/^runner-/),
    );
    const runnerId = mgr.getRunnerIdForInstance('inst-cancel-me');

    expect(runnerId).toMatch(/^runner-/);
    await mgr.stopRunner(runnerId!);
    await expect(outcome).resolves.toEqual(
      expect.objectContaining({ message: 'runner exited during cancelled startup' }),
    );

    expect(stop).toHaveBeenCalledOnce();
    expect(mgr.getRunnerIdForInstance('inst-cancel-me')).toBeUndefined();
    expect(mgr.getAllRunners()).toEqual([]);
  });

  it('allows two replicas of the same model name on this worker with distinct instanceIds (#120)', async () => {
    const r1 = await manager.startRunner({
      modelName: 'replica-model',
      instanceId: 'inst-replica-a',
      runnerType: 'vllm',
      modelPath: '/models/replica',
      requiredMemory: 1024 * 1024 * 1024,
      tensorParallel: 1,
      devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
    });
    const r2 = await manager.startRunner({
      modelName: 'replica-model',
      instanceId: 'inst-replica-b',
      runnerType: 'vllm',
      modelPath: '/models/replica',
      requiredMemory: 1024 * 1024 * 1024,
      tensorParallel: 1,
      devices: [{ deviceIndex: 1, deviceType: 'CUDA' }],
    });

    expect(r1.runnerId).not.toBe(r2.runnerId);
    expect(manager.getAllRunners()).toHaveLength(2);
    // getRunnerIdForModel resolves to the most-recently-started runner — documented ambiguity.
    expect(manager.getRunnerIdForModel('replica-model')).toBe(r2.runnerId);
    // getRunnerIdForInstance is unambiguous per replica.
    expect(manager.getRunnerIdForInstance('inst-replica-a')).toBe(r1.runnerId);
    expect(manager.getRunnerIdForInstance('inst-replica-b')).toBe(r2.runnerId);
  });

  it('stops a runner by ID', async () => {
    const result = await manager.startRunner({
      modelName: 'stop-me',
      instanceId: 'inst-stop-me',
      runnerType: 'vllm',
      modelPath: '/models/stop',
      requiredMemory: 1024 * 1024 * 1024,
      tensorParallel: 1,
      devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
    });

    await manager.stopRunner(result.runnerId);
    expect(manager.getRunner(result.runnerId)).toBeUndefined();
  });

  it('throws NotFoundError when stopping unknown runner', async () => {
    await expect(manager.stopRunner('nonexistent')).rejects.toThrow(NotFoundError);
  });

  it('tracks all runners via getAllRunners', async () => {
    await manager.startRunner({
      modelName: 'model-x',
      instanceId: 'inst-model-x',
      runnerType: 'vllm',
      modelPath: '/models/x',
      requiredMemory: 1024 * 1024 * 1024,
      tensorParallel: 1,
      devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
    });
    await manager.startRunner({
      modelName: 'model-y',
      instanceId: 'inst-model-y',
      runnerType: 'vllm',
      modelPath: '/models/y',
      requiredMemory: 1024 * 1024 * 1024,
      tensorParallel: 1,
      devices: [{ deviceIndex: 1, deviceType: 'CUDA' }],
    });

    expect(manager.getAllRunners()).toHaveLength(2);
  });

  it('stopAll stops all runners', async () => {
    await manager.startRunner({
      modelName: 'model-1',
      instanceId: 'inst-model-1',
      runnerType: 'vllm',
      modelPath: '/models/1',
      requiredMemory: 1024 * 1024 * 1024,
      tensorParallel: 1,
      devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
    });
    await manager.startRunner({
      modelName: 'model-2',
      instanceId: 'inst-model-2',
      runnerType: 'vllm',
      modelPath: '/models/2',
      requiredMemory: 1024 * 1024 * 1024,
      tensorParallel: 1,
      devices: [{ deviceIndex: 1, deviceType: 'CUDA' }],
    });

    await manager.stopAll();
    expect(manager.getAllRunners()).toHaveLength(0);
  });

  it('rolls back the model slot when a launch fails so the model can be retried', async () => {
    const failing: RunnerLauncher = {
      serializeColdStarts: false,
      start: () => Promise.reject(new Error('cold-start boom')),
    };
    const mgr = new RunnerManager(makeConfig(), makeRegistration(), failing);

    await expect(
      mgr.startRunner({
        modelName: 'retry-me',
        instanceId: 'inst-retry-me',
        runnerType: 'vllm',
        modelPath: '/models/retry',
        requiredMemory: 1,
        tensorParallel: 1,
        devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
      }),
    ).rejects.toThrow('cold-start boom');

    // A second attempt must not hit a stale ConflictError from the reserved slot.
    await expect(
      mgr.startRunner({
        modelName: 'retry-me',
        instanceId: 'inst-retry-me',
        runnerType: 'vllm',
        modelPath: '/models/retry',
        requiredMemory: 1,
        tensorParallel: 1,
        devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
      }),
    ).rejects.toThrow('cold-start boom');
  });

  // #288: the instance slot is still reserved synchronously, before the first await, but a second
  // start that arrives during that window now *joins* the in-flight launch instead of failing:
  // one spawn, one port block, both callers get the same endpoint (the joiner marked `reused`).
  it('concurrent same-instanceId starts coalesce to one spawn and both resolve to the same runnerId', async () => {
    // A shared deferred probePort: every allocatePorts probe suspends on it until released, so
    // whichever starts are in flight are held in the port-probe window the guard covers.
    let releaseProbe!: (value: boolean) => void;
    const gate = new Promise<boolean>((resolve) => {
      releaseProbe = resolve;
    });
    const slowProbe = (): Promise<boolean> => gate;
    const { launcher, start } = makeCountingLauncher({});
    const mgr = new RunnerManager(makeConfig(), makeRegistration(), launcher, undefined, slowProbe);

    const params = startParams('inst-raced', {
      modelName: 'raced-model',
      modelPath: '/models/raced',
    });
    // Fire both, release the gate, then settle. Pre-fix (before the synchronous reservation) both
    // passed the guard while allocatePorts was suspended and both launched.
    const first = mgr.startRunner(params);
    const second = mgr.startRunner(params);
    releaseProbe(true);
    const [a, b] = await Promise.all([first, second]);

    expect(start).toHaveBeenCalledOnce();
    expect(a.runnerId).toBe(b.runnerId);
    expect(a.reused).toBeUndefined();
    expect(b.reused).toBe(true);

    // Exactly one 4-port block was consumed: a third, unrelated start lands on 19305
    // (runnerPortStart + PORTS_PER_RUNNER), not 19309.
    const third = await mgr.startRunner({
      ...params,
      modelName: 'other-model',
      instanceId: 'inst-other',
    });
    expect(third.port).toBe(19305);
  });

  it('duplicate start for a READY instanceId returns the existing endpoint with reused: true and spawns once', async () => {
    const { launcher, start } = makeCountingLauncher({});
    const mgr = new RunnerManager(makeConfig(), makeRegistration(), launcher);

    const first = await mgr.startRunner(startParams('inst-idem-ready'));
    const second = await mgr.startRunner(startParams('inst-idem-ready'));

    expect(start).toHaveBeenCalledOnce();
    expect(second).toEqual({
      runnerId: first.runnerId,
      host: first.host,
      port: first.port,
      enginePort: first.enginePort,
      reused: true,
    });
    expect(mgr.getAllRunners()).toHaveLength(1);

    // The reuse allocated nothing: an unrelated instance lands on the second port block.
    const third = await mgr.startRunner(startParams('inst-idem-other'));
    expect(third.port).toBe(19305);
  });

  it('duplicate start with a different launch spec throws ConflictError naming the existing runner and spawns nothing', async () => {
    const { launcher, start } = makeCountingLauncher({});
    const mgr = new RunnerManager(makeConfig(), makeRegistration(), launcher);
    const twoDevices = [
      { deviceIndex: 0, deviceType: 'CUDA' },
      { deviceIndex: 1, deviceType: 'CUDA' },
    ];
    const baseline = startParams('inst-idem-spec', {
      modelPath: '/models/a',
      tensorParallel: 2,
      devices: twoDevices,
      engineConfig: { a: 1, b: 2 },
    });
    const first = await mgr.startRunner(baseline);

    // A different modelPath is a different launch.
    const conflict = await mgr
      .startRunner({ ...baseline, modelPath: '/models/b' })
      .catch((err: unknown) => err);
    expect(conflict).toBeInstanceOf(ConflictError);
    expect((conflict as Error).message).toContain(first.runnerId);

    // engineConfig key order is not part of the launch identity.
    const reorderedConfig = await mgr.startRunner({ ...baseline, engineConfig: { b: 2, a: 1 } });
    expect(reorderedConfig.reused).toBe(true);

    // Device placement order is not part of the launch identity either.
    const reorderedDevices = await mgr.startRunner({
      ...baseline,
      devices: [...twoDevices].reverse(),
    });
    expect(reorderedDevices.reused).toBe(true);

    expect(start).toHaveBeenCalledOnce();
  });

  it('a failed launch whose process is still alive is retained and a retry refuses with 409', async () => {
    let zombieRunnerId: string | undefined;
    const stop = vi.fn(() => Promise.resolve());
    const { launcher, start } = makeCountingLauncher({
      pid: 4242,
      isAlive: () => true,
      stop,
      failAfterHandle: 'cold-start boom',
    });
    const capturing: RunnerLauncher = {
      serializeColdStarts: false,
      start: (spec, onLog, onStartupComplete, onExit, onLaunchHandle) => {
        zombieRunnerId = spec.runnerId;
        return launcher.start(spec, onLog, onStartupComplete, onExit, onLaunchHandle);
      },
    };
    const mgr = new RunnerManager(makeConfig(), makeRegistration(), capturing);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(mgr.startRunner(startParams('inst-zombie'))).rejects.toThrow('cold-start boom');

      const retry = await mgr.startRunner(startParams('inst-zombie')).catch((err: unknown) => err);
      expect(retry).toBeInstanceOf(ConflictError);
      expect((retry as Error).message).toContain(zombieRunnerId);

      expect(start).toHaveBeenCalledOnce();
      expect(errorSpy.mock.calls.flat().join('\n')).toMatch(/retained as a zombie/);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('a retained failed launch is stopped and cleared before a retry proceeds', async () => {
    let alive = true;
    const stop = vi.fn(() => {
      if (stop.mock.calls.length > 1) alive = false;
      return Promise.resolve();
    });
    let attempts = 0;
    let zombieRunnerId: string | undefined;
    const launcher: RunnerLauncher = {
      serializeColdStarts: false,
      start: (spec, _onLog, _onStartupComplete, _onExit, onLaunchHandle) => {
        attempts += 1;
        const handle: LaunchHandle = {
          host: 'localhost',
          port: spec.port,
          enginePort: spec.enginePort,
          pid: 4242,
          isAlive: () => alive,
          stop,
        };
        onLaunchHandle?.(handle);
        if (attempts === 1) {
          zombieRunnerId = spec.runnerId;
          return Promise.reject(new Error('cold-start boom'));
        }
        return Promise.resolve(handle);
      },
    };
    const mgr = new RunnerManager(makeConfig(), makeRegistration(), launcher);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(mgr.startRunner(startParams('inst-zombie-retry'))).rejects.toThrow(
        'cold-start boom',
      );

      // The retry stops the retained launch first; it now reports dead, so the entry is dropped
      // and the fresh spawn proceeds under a new runnerId.
      const retry = await mgr.startRunner(startParams('inst-zombie-retry'));
      expect(attempts).toBe(2);
      expect(retry.runnerId).not.toBe(zombieRunnerId);
      expect(retry.reused).toBeUndefined();

      // The retained entry is gone: the old runnerId is no longer addressable.
      await expect(mgr.stopRunner(zombieRunnerId!)).rejects.toThrow(NotFoundError);
    } finally {
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it('stopRunner(runnerId) of a retained failed launch stops it and answers instead of NotFound', async () => {
    let zombieRunnerId: string | undefined;
    const stop = vi.fn(() => Promise.resolve());
    const { launcher } = makeCountingLauncher({
      pid: 4242,
      isAlive: () => true,
      stop,
      failAfterHandle: 'cold-start boom',
    });
    const capturing: RunnerLauncher = {
      serializeColdStarts: false,
      start: (spec, onLog, onStartupComplete, onExit, onLaunchHandle) => {
        zombieRunnerId = spec.runnerId;
        return launcher.start(spec, onLog, onStartupComplete, onExit, onLaunchHandle);
      },
    };
    const mgr = new RunnerManager(makeConfig(), makeRegistration(), capturing);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(mgr.startRunner(startParams('inst-zombie-delete'))).rejects.toThrow(
        'cold-start boom',
      );
      // The failed launch's catch already issued one stop attempt; DELETE issues the second.
      const stopsBeforeDelete = stop.mock.calls.length;

      await expect(mgr.stopRunner(zombieRunnerId!)).resolves.toBeUndefined();
      expect(stop.mock.calls.length).toBe(stopsBeforeDelete + 1);

      // The entry was cleared, so a second DELETE is a plain 404 again.
      await expect(mgr.stopRunner(zombieRunnerId!)).rejects.toThrow(NotFoundError);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('getRetainedLaunchForInstance exposes the retained runnerId until the launch is stopped', async () => {
    let zombieRunnerId: string | undefined;
    const stop = vi.fn(() => Promise.resolve());
    const { launcher } = makeCountingLauncher({
      pid: 4242,
      isAlive: () => true,
      stop,
      failAfterHandle: 'cold-start boom',
    });
    const capturing: RunnerLauncher = {
      serializeColdStarts: false,
      start: (spec, onLog, onStartupComplete, onExit, onLaunchHandle) => {
        zombieRunnerId = spec.runnerId;
        return launcher.start(spec, onLog, onStartupComplete, onExit, onLaunchHandle);
      },
    };
    const mgr = new RunnerManager(makeConfig(), makeRegistration(), capturing);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(mgr.getRetainedLaunchForInstance('inst-zombie-lookup')).toBeUndefined();

      await expect(mgr.startRunner(startParams('inst-zombie-lookup'))).rejects.toThrow(
        'cold-start boom',
      );
      // Only the id is exposed — the launcher handle stays private to the manager.
      expect(mgr.getRetainedLaunchForInstance('inst-zombie-lookup')).toEqual({
        runnerId: zombieRunnerId,
      });
      expect(mgr.getRetainedLaunchForInstance('inst-other')).toBeUndefined();

      await mgr.stopRunner(zombieRunnerId!);
      expect(mgr.getRetainedLaunchForInstance('inst-zombie-lookup')).toBeUndefined();
    } finally {
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it('the Started runner line carries the launcher pid', async () => {
    const { launcher } = makeCountingLauncher({ pid: 4242 });
    const mgr = new RunnerManager(makeConfig(), makeRegistration(), launcher);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await mgr.startRunner(startParams('inst-pid'));
      expect(logSpy.mock.calls.flat().join('\n')).toMatch(/Started runner \S+ for .* pid=4242/);
    } finally {
      logSpy.mockRestore();
    }
  });

  // #257 defect 1, rollback half: with the reservation moved above allocatePorts, an allocation
  // failure lands inside the try, whose catch rolls the reserved slot back — a retry of the same
  // instanceId must fail with the allocation error again, never ConflictError.
  it('a failed port allocation rolls back the reserved slot so the same instanceId can retry', async () => {
    // One-slot range whose only block always fails its probe: allocatePorts throws exhausted.
    const mgr = new RunnerManager(
      makeConfig({ maxRunners: 1 }),
      makeRegistration(),
      makeFakeLauncher(),
      undefined,
      () => Promise.resolve(false),
    );
    const startParams = {
      modelName: 'alloc-fail-model',
      instanceId: 'inst-alloc-fail',
      runnerType: 'vllm' as const,
      modelPath: '/models/alloc-fail',
      requiredMemory: 1,
      tensorParallel: 1,
      devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
    };

    await expect(mgr.startRunner(startParams)).rejects.toThrow(/port range exhausted/i);
    // The same instanceId is not stranded behind a stale reservation — the allocation error
    // again, NOT ConflictError.
    await expect(mgr.startRunner(startParams)).rejects.toThrow(/port range exhausted/i);
  });

  // #257 defect 3: a tensor-parallel start across N devices updates all ledgers but pushes one
  // coalesced memory report per tick, with the per-device floor arithmetic preserved.
  it('a 2-device start calls redis.set once with a report containing both devices', async () => {
    const trackingRedis = makeTrackingRedis();
    const registration = new WorkerRegistration(trackingRedis as never, makeConfig(), [
      { deviceIndex: 0, deviceType: 'CUDA', memoryTotalBytes: 24 * 1024 * 1024 * 1024 },
      { deviceIndex: 1, deviceType: 'CUDA', memoryTotalBytes: 24 * 1024 * 1024 * 1024 },
    ]);
    const mgr = new RunnerManager(makeConfig(), registration, makeFakeLauncher());

    await mgr.startRunner({
      modelName: 'tp-model',
      instanceId: 'inst-tp',
      runnerType: 'vllm',
      modelPath: '/models/tp',
      requiredMemory: 1000,
      tensorParallel: 2,
      devices: [
        { deviceIndex: 0, deviceType: 'CUDA' },
        { deviceIndex: 1, deviceType: 'CUDA' },
      ],
    });
    // Drain the coalesced (microtask-scheduled) push: two deterministic macrotask turns cover
    // the microtask and the redis.set promise. No wall-clock waits.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const memCalls = trackingRedis._setHistory.filter((c) => c.key.endsWith(':memory'));
    expect(memCalls.length).toBe(1);
    const report = JSON.parse(memCalls[0].value) as WorkerMemoryReport;
    expect(report.devices[0].memoryUsedBytes).toBe(500);
    expect(report.devices[1].memoryUsedBytes).toBe(500);
    expect(report.reportedAt).toBeDefined();
  });
  // #257 review r1: startRunner's coalesced push is pinned by the 2-device test above; the two
  // rollback paths (deliberate stop, unexpected exit) must each still schedule one coalesced
  // push after freeing memory, or the control plane sees the freed VRAM only on the next
  // heartbeat tick.
  it('stopRunner schedules one coalesced memory-report push', async () => {
    const registration = makeRegistration();
    const pushSpy = vi.spyOn(registration, 'pushMemoryReportOnce');
    const mgr = new RunnerManager(makeConfig(), registration, makeFakeLauncher());

    const { runnerId } = await mgr.startRunner({
      modelName: 'stop-push',
      instanceId: 'inst-stop-push',
      runnerType: 'vllm',
      modelPath: '/models/stop-push',
      requiredMemory: 1024 * 1024 * 1024,
      tensorParallel: 1,
      devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
    });
    expect(pushSpy).toHaveBeenCalledTimes(1);

    await mgr.stopRunner(runnerId);
    expect(pushSpy).toHaveBeenCalledTimes(2);
  });

  it('unexpected exit schedules one coalesced memory-report push', async () => {
    const { launcher, fireExit } = makeSupervisedLauncher();
    const registration = makeRegistration();
    const pushSpy = vi.spyOn(registration, 'pushMemoryReportOnce');
    const mgr = new RunnerManager(makeConfig(), registration, launcher);

    const { runnerId } = await mgr.startRunner({
      modelName: 'exit-push',
      instanceId: 'inst-exit-push',
      runnerType: 'vllm',
      modelPath: '/models/exit-push',
      requiredMemory: 1024 * 1024 * 1024,
      tensorParallel: 1,
      devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
    });
    expect(pushSpy).toHaveBeenCalledTimes(1);

    fireExit(runnerId);
    expect(pushSpy).toHaveBeenCalledTimes(2);
  });

  it('serializes cold-starts when the launcher requires it', async () => {
    let active = 0;
    let maxConcurrent = 0;
    const gate: RunnerLauncher = {
      serializeColdStarts: true,
      start: async (spec: LaunchSpec): Promise<LaunchHandle> => {
        active++;
        maxConcurrent = Math.max(maxConcurrent, active);
        await new Promise((r) => setTimeout(r, 20));
        active--;
        return {
          host: 'localhost',
          port: spec.port,
          enginePort: spec.enginePort,
          stop: () => Promise.resolve(),
        };
      },
    };
    const mgr = new RunnerManager(makeConfig(), makeRegistration(), gate);

    await Promise.all(
      ['a', 'b', 'c'].map((name) =>
        mgr.startRunner({
          modelName: `model-${name}`,
          instanceId: `inst-model-${name}`,
          runnerType: 'vllm',
          modelPath: `/models/${name}`,
          requiredMemory: 1,
          tensorParallel: 1,
          devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
        }),
      ),
    );

    expect(maxConcurrent).toBe(1);
    expect(mgr.getAllRunners()).toHaveLength(3);
  });

  it('marks log stream ended and retains buffer when launch fails', async () => {
    const logBuffer = new RunnerLogBuffer();
    const markEndedSpy = vi.spyOn(logBuffer, 'markEnded');
    const retainSpy = vi.spyOn(logBuffer, 'retain');
    const failing: RunnerLauncher = {
      serializeColdStarts: false,
      start: () => Promise.reject(new Error('launch boom')),
    };
    const mgr = new RunnerManager(makeConfig(), makeRegistration(), failing, logBuffer);

    await expect(
      mgr.startRunner({
        modelName: 'fails-to-launch',
        instanceId: 'inst-fails-to-launch',
        runnerType: 'vllm',
        modelPath: '/models/fail',
        requiredMemory: 1,
        tensorParallel: 1,
        devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
      }),
    ).rejects.toThrow('launch boom');

    expect(markEndedSpy).toHaveBeenCalledTimes(1);
    expect(retainSpy).toHaveBeenCalledTimes(1);
    const runnerId = markEndedSpy.mock.calls[0][0];
    expect(retainSpy.mock.calls[0][0]).toBe(runnerId);
    logBuffer.append(runnerId, 'stderr', 'startup failed\n');
    expect(mgr.getRunnerIdForInstance('inst-fails-to-launch')).toBe(runnerId);
  });

  it('buffer dropped after retain TTL on failed launch', async () => {
    vi.useFakeTimers();
    try {
      const logBuffer = new RunnerLogBuffer();
      const markEndedSpy = vi.spyOn(logBuffer, 'markEnded');
      const failing: RunnerLauncher = {
        serializeColdStarts: false,
        start: () => Promise.reject(new Error('launch boom')),
      };
      const mgr = new RunnerManager(makeConfig(), makeRegistration(), failing, logBuffer);

      await expect(
        mgr.startRunner({
          modelName: 'fails-then-expires',
          instanceId: 'inst-fails-then-expires',
          runnerType: 'vllm',
          modelPath: '/models/fail-expires',
          requiredMemory: 1,
          tensorParallel: 1,
          devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
        }),
      ).rejects.toThrow('launch boom');

      const runnerId = markEndedSpy.mock.calls[0][0];
      logBuffer.append(runnerId, 'stdout', 'failure log\n');

      expect(logBuffer.has(runnerId)).toBe(true);
      expect(mgr.getRunnerIdForInstance('inst-fails-then-expires')).toBe(runnerId);
      vi.advanceTimersByTime(RETAIN_TTL_MS);
      expect(logBuffer.has(runnerId)).toBe(false);
      expect(mgr.getRunnerIdForInstance('inst-fails-then-expires')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('allows starting a model after it was stopped', async () => {
    const r1 = await manager.startRunner({
      modelName: 'recycled',
      instanceId: 'inst-recycled',
      runnerType: 'vllm',
      modelPath: '/models/recycled',
      requiredMemory: 1024 * 1024 * 1024,
      tensorParallel: 1,
      devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
    });
    await manager.stopRunner(r1.runnerId);

    const r2 = await manager.startRunner({
      modelName: 'recycled',
      instanceId: 'inst-recycled',
      runnerType: 'vllm',
      modelPath: '/models/recycled',
      requiredMemory: 1024 * 1024 * 1024,
      tensorParallel: 1,
      devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
    });
    expect(r2.runnerId).not.toBe(r1.runnerId);
  });

  it('cleans up when a runner exits unexpectedly after startup', async () => {
    const { launcher, fireExit } = makeSupervisedLauncher();
    const logBuffer = new RunnerLogBuffer();
    const markEndedSpy = vi.spyOn(logBuffer, 'markEnded');
    const retainSpy = vi.spyOn(logBuffer, 'retain');
    const registration = makeRegistration();
    const freeMemorySpy = vi.spyOn(registration, 'freeMemory');
    const mgr = new RunnerManager(makeConfig(), registration, launcher, logBuffer);

    const { runnerId } = await mgr.startRunner({
      modelName: 'crashes-later',
      instanceId: 'inst-crashes-later',
      runnerType: 'vllm',
      modelPath: '/models/crashes-later',
      requiredMemory: 1024 * 1024 * 1024,
      tensorParallel: 1,
      devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
    });
    expect(mgr.getRunner(runnerId)).toBeDefined();

    fireExit(runnerId);

    expect(mgr.getRunner(runnerId)).toBeUndefined();
    expect(freeMemorySpy).toHaveBeenCalledWith(0, 1024 * 1024 * 1024);
    expect(markEndedSpy).toHaveBeenCalledWith(runnerId);
    expect(retainSpy).toHaveBeenCalledWith(runnerId);

    // The model slot is freed too — a replacement runner can be started for the same model.
    const restarted = await mgr.startRunner({
      modelName: 'crashes-later',
      instanceId: 'inst-crashes-later',
      runnerType: 'vllm',
      modelPath: '/models/crashes-later',
      requiredMemory: 1024 * 1024 * 1024,
      tensorParallel: 1,
      devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
    });
    expect(restarted.runnerId).not.toBe(runnerId);
  });

  it('supervision callback no-ops when stopRunner has already cleaned up', async () => {
    const { launcher, fireExit } = makeSupervisedLauncher();
    const registration = makeRegistration();
    const freeMemorySpy = vi.spyOn(registration, 'freeMemory');
    const mgr = new RunnerManager(makeConfig(), registration, launcher);

    const { runnerId } = await mgr.startRunner({
      modelName: 'stopped-deliberately',
      instanceId: 'inst-stopped-deliberately',
      runnerType: 'vllm',
      modelPath: '/models/stopped-deliberately',
      requiredMemory: 1024 * 1024 * 1024,
      tensorParallel: 1,
      devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
    });

    await mgr.stopRunner(runnerId);
    expect(freeMemorySpy).toHaveBeenCalledTimes(1);

    // The process exiting in response to the deliberate stop still fires the supervision callback —
    // it must no-op rather than free memory a second time for a record that's already gone.
    fireExit(runnerId);
    expect(freeMemorySpy).toHaveBeenCalledTimes(1);
  });

  it('reuses released port after stop', async () => {
    const a = await manager.startRunner({
      modelName: 'port-reuse-a',
      instanceId: 'inst-port-reuse-a',
      runnerType: 'vllm',
      modelPath: '/models/port-reuse-a',
      requiredMemory: 1024 * 1024 * 1024,
      tensorParallel: 1,
      devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
    });
    expect(a.port).toBe(19301);

    await manager.stopRunner(a.runnerId);

    const b = await manager.startRunner({
      modelName: 'port-reuse-b',
      instanceId: 'inst-port-reuse-b',
      runnerType: 'vllm',
      modelPath: '/models/port-reuse-b',
      requiredMemory: 1024 * 1024 * 1024,
      tensorParallel: 1,
      devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
    });
    expect(b.port).toBe(19301);
  });

  it('block is reused after stop', async () => {
    const a = await manager.startRunner({
      modelName: 'block-reuse-a',
      instanceId: 'inst-block-reuse-a',
      runnerType: 'vllm',
      modelPath: '/models/block-reuse-a',
      requiredMemory: 1024 * 1024 * 1024,
      tensorParallel: 1,
      devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
    });
    expect(a.port).toBe(19301);

    await manager.stopRunner(a.runnerId);

    const b = await manager.startRunner({
      modelName: 'block-reuse-b',
      instanceId: 'inst-block-reuse-b',
      runnerType: 'vllm',
      modelPath: '/models/block-reuse-b',
      requiredMemory: 1024 * 1024 * 1024,
      tensorParallel: 1,
      devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
    });
    expect(b.port).toBe(19301);
  });

  it('reuses released port after unexpected exit', async () => {
    const { launcher, fireExit } = makeSupervisedLauncher();
    const mgr = new RunnerManager(makeConfig(), makeRegistration(), launcher);

    const a = await mgr.startRunner({
      modelName: 'port-reuse-exit-a',
      instanceId: 'inst-port-reuse-exit-a',
      runnerType: 'vllm',
      modelPath: '/models/port-reuse-exit-a',
      requiredMemory: 1024 * 1024 * 1024,
      tensorParallel: 1,
      devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
    });
    expect(a.port).toBe(19301);

    fireExit(a.runnerId);

    const b = await mgr.startRunner({
      modelName: 'port-reuse-exit-b',
      instanceId: 'inst-port-reuse-exit-b',
      runnerType: 'vllm',
      modelPath: '/models/port-reuse-exit-b',
      requiredMemory: 1024 * 1024 * 1024,
      tensorParallel: 1,
      devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
    });
    expect(b.port).toBe(19301);
  });

  it('range exhaustion produces clear error', async () => {
    const mgr = new RunnerManager(makeConfig({ maxRunners: 1 }), makeRegistration());

    await mgr.startRunner({
      modelName: 'exhaust-a',
      instanceId: 'inst-exhaust-a',
      runnerType: 'vllm',
      modelPath: '/models/exhaust-a',
      requiredMemory: 1024 * 1024 * 1024,
      tensorParallel: 1,
      devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
    });

    await expect(
      mgr.startRunner({
        modelName: 'exhaust-b',
        instanceId: 'inst-exhaust-b',
        runnerType: 'vllm',
        modelPath: '/models/exhaust-b',
        requiredMemory: 1024 * 1024 * 1024,
        tensorParallel: 1,
        devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
      }),
    ).rejects.toThrow(/port range exhausted/i);
  });

  it('workerPort is never allocated', async () => {
    const mgr = new RunnerManager(
      makeConfig({ workerPort: 19301, runnerPortStart: 19301, maxRunners: 3 }),
      makeRegistration(),
    );

    const a = await mgr.startRunner({
      modelName: 'skip-worker-port',
      instanceId: 'inst-skip-worker-port',
      runnerType: 'vllm',
      modelPath: '/models/skip-worker-port',
      requiredMemory: 1024 * 1024 * 1024,
      tensorParallel: 1,
      devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
    });

    expect(a.port).toBe(19305);
  });

  it('port released on failed launch', async () => {
    let attempt = 0;
    const failing: RunnerLauncher = {
      serializeColdStarts: false,
      start: (spec: LaunchSpec): Promise<LaunchHandle> => {
        attempt++;
        if (attempt === 1) {
          return Promise.reject(new Error('cold-start boom'));
        }
        return Promise.resolve({
          host: 'localhost',
          port: spec.port,
          enginePort: spec.enginePort,
          stop: () => Promise.resolve(),
        });
      },
    };
    const mgr = new RunnerManager(makeConfig({ maxRunners: 1 }), makeRegistration(), failing);

    await expect(
      mgr.startRunner({
        modelName: 'released-on-failure-a',
        instanceId: 'inst-released-on-failure-a',
        runnerType: 'vllm',
        modelPath: '/models/released-on-failure-a',
        requiredMemory: 1,
        tensorParallel: 1,
        devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
      }),
    ).rejects.toThrow('cold-start boom');

    const b = await mgr.startRunner({
      modelName: 'released-on-failure-b',
      instanceId: 'inst-released-on-failure-b',
      runnerType: 'vllm',
      modelPath: '/models/released-on-failure-b',
      requiredMemory: 1,
      tensorParallel: 1,
      devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
    });
    expect(b.port).toBe(19301);
  });

  it('threads engineArgs through to the LaunchSpec passed to the launcher (#126)', async () => {
    let capturedSpec: LaunchSpec | undefined;
    const capturingLauncher: RunnerLauncher = {
      serializeColdStarts: false,
      start: (spec: LaunchSpec): Promise<LaunchHandle> => {
        capturedSpec = spec;
        return Promise.resolve({
          host: 'localhost',
          port: spec.port,
          enginePort: spec.enginePort,
          stop: () => Promise.resolve(),
        });
      },
    };
    const mgr = new RunnerManager(makeConfig(), makeRegistration(), capturingLauncher);

    await mgr.startRunner({
      modelName: 'engine-args-model',
      instanceId: 'inst-engine-args-model',
      runnerType: 'vllm',
      modelPath: '/models/engine-args-model',
      requiredMemory: 1,
      tensorParallel: 1,
      engineArgs: ['--x=1'],
      devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
    });

    expect(capturedSpec?.engineArgs).toEqual(['--x=1']);
  });

  it('threads entrypoint through to the LaunchSpec passed to the launcher (#125)', async () => {
    let capturedSpec: LaunchSpec | undefined;
    const capturingLauncher: RunnerLauncher = {
      serializeColdStarts: false,
      start: (spec: LaunchSpec): Promise<LaunchHandle> => {
        capturedSpec = spec;
        return Promise.resolve({
          host: 'localhost',
          port: spec.port,
          enginePort: spec.enginePort,
          stop: () => Promise.resolve(),
        });
      },
    };
    const mgr = new RunnerManager(makeConfig(), makeRegistration(), capturingLauncher);

    await mgr.startRunner({
      modelName: 'entrypoint-model',
      instanceId: 'inst-entrypoint-model',
      runnerType: 'mlserver',
      modelPath: '/models/entrypoint-model',
      requiredMemory: 1,
      tensorParallel: 1,
      entrypoint: ['python3', '-m', 'sardeenz_mlserver_runner'],
      devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
    });

    expect(capturedSpec?.entrypoint).toEqual(['python3', '-m', 'sardeenz_mlserver_runner']);
  });
});

describe('getRunnerProcesses', () => {
  // A dedicated port range, distinct from every other describe block in this file: the only test
  // below that binds a real socket (the default StubLauncher case) must not race the teardown of
  // real listeners started by the many other tests sharing runnerPortStart 19301 above.
  const processesConfig = (): DevWorkerConfig =>
    makeConfig({ workerPort: 19700, runnerPortStart: 19701 });

  it('returns nothing for the default StubLauncher (never sets handle.pid)', async () => {
    const mgr = new RunnerManager(processesConfig(), makeRegistration());
    await mgr.startRunner({
      modelName: 'stub-model',
      instanceId: 'inst-stub-model',
      runnerType: 'vllm',
      modelPath: '/models/stub',
      requiredMemory: 1024,
      tensorParallel: 1,
      devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
    });

    expect(mgr.getRunnerProcesses()).toEqual([]);
    await mgr.stopAll();
  });

  it('reports pid/instanceId/modelName for runners whose launcher sets handle.pid', async () => {
    const pidLauncher: RunnerLauncher = {
      serializeColdStarts: false,
      start: (spec: LaunchSpec): Promise<LaunchHandle> =>
        Promise.resolve({
          host: 'localhost',
          port: spec.port,
          enginePort: spec.enginePort,
          pid: 4242,
          stop: () => Promise.resolve(),
        }),
    };
    const mgr = new RunnerManager(makeConfig(), makeRegistration(), pidLauncher);

    await mgr.startRunner({
      modelName: 'real-model',
      instanceId: 'inst-real-model',
      runnerType: 'vllm',
      modelPath: '/models/real',
      requiredMemory: 1024,
      tensorParallel: 1,
      devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
    });

    expect(mgr.getRunnerProcesses()).toEqual([
      { pid: 4242, instanceId: 'inst-real-model', modelName: 'real-model' },
    ]);
    await mgr.stopAll();
  });

  it('drops a runner from the list once it is stopped', async () => {
    const pidLauncher: RunnerLauncher = {
      serializeColdStarts: false,
      start: (spec: LaunchSpec): Promise<LaunchHandle> =>
        Promise.resolve({
          host: 'localhost',
          port: spec.port,
          enginePort: spec.enginePort,
          pid: 4242,
          stop: () => Promise.resolve(),
        }),
    };
    const mgr = new RunnerManager(makeConfig(), makeRegistration(), pidLauncher);

    const { runnerId } = await mgr.startRunner({
      modelName: 'real-model',
      instanceId: 'inst-real-model',
      runnerType: 'vllm',
      modelPath: '/models/real',
      requiredMemory: 1024,
      tensorParallel: 1,
      devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
    });
    await mgr.stopRunner(runnerId);

    expect(mgr.getRunnerProcesses()).toEqual([]);
  });
});

describe('getLedgerInstanceShares', () => {
  // Runners in these tests use a fake launcher that never actually binds a socket — only the
  // constructor-injected fetchFn is exercised, so no real network/port isolation is needed here.
  function makeLauncher(): RunnerLauncher {
    return {
      serializeColdStarts: false,
      start: (spec: LaunchSpec): Promise<LaunchHandle> =>
        Promise.resolve({
          host: 'localhost',
          port: spec.port,
          enginePort: spec.enginePort,
          stop: () => Promise.resolve(),
        }),
    };
  }

  function makeFetchFn(
    impl: (url: string) => Promise<{ ok: boolean; json?: () => Promise<unknown> }>,
  ): typeof fetch {
    return vi.fn((url: unknown) => impl(url as string)) as unknown as typeof fetch;
  }

  it("returns per-device bytes from each running runner's own /memory-report", async () => {
    const fetchFn = makeFetchFn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ devices: [{ deviceIndex: 0, memoryUsedBytes: 500 }] }),
      }),
    );
    const mgr = new RunnerManager(
      makeConfig(),
      makeRegistration(),
      makeLauncher(),
      undefined,
      undefined,
      fetchFn,
    );

    await mgr.startRunner({
      modelName: 'model-a',
      instanceId: 'inst-a',
      runnerType: 'vllm',
      modelPath: '/models/a',
      requiredMemory: 1000,
      tensorParallel: 1,
      devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
    });

    const shares = await mgr.getLedgerInstanceShares();

    expect(shares).toEqual([
      { instanceId: 'inst-a', modelName: 'model-a', deviceIndex: 0, bytes: 500 },
    ]);
    // The AbortSignal timeout is load-bearing: without it a hung runner (socket accepted,
    // response never sent) would pend the Promise.all forever, freezing the heartbeat's
    // memory-report push until the control plane marks the whole worker's budget stale.
    expect(fetchFn).toHaveBeenCalledWith(
      'http://127.0.0.1:19301/memory-report',
      expect.objectContaining({ signal: expect.any(AbortSignal) as AbortSignal }),
    );
  });

  it('a sleeping runner (0 bytes reported) contributes no entries — matches "sleeping models hold nothing"', async () => {
    const fetchFn = makeFetchFn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ devices: [{ deviceIndex: 0, memoryUsedBytes: 0 }] }),
      }),
    );
    const mgr = new RunnerManager(
      makeConfig(),
      makeRegistration(),
      makeLauncher(),
      undefined,
      undefined,
      fetchFn,
    );
    await mgr.startRunner({
      modelName: 'model-a',
      instanceId: 'inst-a',
      runnerType: 'vllm',
      modelPath: '/models/a',
      requiredMemory: 1000,
      tensorParallel: 1,
      devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
    });

    expect(await mgr.getLedgerInstanceShares()).toEqual([]);
  });

  it('a runner whose /memory-report call rejects contributes no entries (never throws)', async () => {
    const fetchFn = vi.fn(() =>
      Promise.reject(new Error('ECONNREFUSED')),
    ) as unknown as typeof fetch;
    const mgr = new RunnerManager(
      makeConfig(),
      makeRegistration(),
      makeLauncher(),
      undefined,
      undefined,
      fetchFn,
    );
    await mgr.startRunner({
      modelName: 'model-a',
      instanceId: 'inst-a',
      runnerType: 'vllm',
      modelPath: '/models/a',
      requiredMemory: 1000,
      tensorParallel: 1,
      devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
    });

    await expect(mgr.getLedgerInstanceShares()).resolves.toEqual([]);
  });

  it('a non-ok /memory-report response contributes no entries', async () => {
    const fetchFn = makeFetchFn(() => Promise.resolve({ ok: false }));
    const mgr = new RunnerManager(
      makeConfig(),
      makeRegistration(),
      makeLauncher(),
      undefined,
      undefined,
      fetchFn,
    );
    await mgr.startRunner({
      modelName: 'model-a',
      instanceId: 'inst-a',
      runnerType: 'vllm',
      modelPath: '/models/a',
      requiredMemory: 1000,
      tensorParallel: 1,
      devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
    });

    expect(await mgr.getLedgerInstanceShares()).toEqual([]);
  });

  it('aggregates entries across multiple runners', async () => {
    const fetchFn = makeFetchFn((url) =>
      url.includes('19301')
        ? Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ devices: [{ deviceIndex: 0, memoryUsedBytes: 300 }] }),
          })
        : Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ devices: [{ deviceIndex: 1, memoryUsedBytes: 700 }] }),
          }),
    );
    const mgr = new RunnerManager(
      makeConfig(),
      makeRegistration(),
      makeLauncher(),
      undefined,
      undefined,
      fetchFn,
    );
    await mgr.startRunner({
      modelName: 'model-a',
      instanceId: 'inst-a',
      runnerType: 'vllm',
      modelPath: '/models/a',
      requiredMemory: 300,
      tensorParallel: 1,
      devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
    });
    await mgr.startRunner({
      modelName: 'model-b',
      instanceId: 'inst-b',
      runnerType: 'vllm',
      modelPath: '/models/b',
      requiredMemory: 700,
      tensorParallel: 1,
      devices: [{ deviceIndex: 1, deviceType: 'CUDA' }],
    });

    const shares = await mgr.getLedgerInstanceShares();
    expect(shares).toHaveLength(2);
    expect(shares).toEqual(
      expect.arrayContaining([
        { instanceId: 'inst-a', modelName: 'model-a', deviceIndex: 0, bytes: 300 },
        { instanceId: 'inst-b', modelName: 'model-b', deviceIndex: 1, bytes: 700 },
      ]),
    );
  });

  it('returns empty when there are no running runners', async () => {
    const mgr = new RunnerManager(makeConfig(), makeRegistration());
    expect(await mgr.getLedgerInstanceShares()).toEqual([]);
  });

  // --- Scope rule (ADR-027, issue #278) ---

  it('promotes a runner-scope row unchanged', async () => {
    const fetchFn = makeFetchFn(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            devices: [{ deviceIndex: 0, memoryUsedBytes: 500, attribution: 'runner' }],
          }),
      }),
    );
    const mgr = new RunnerManager(
      makeConfig(),
      makeRegistration(),
      makeLauncher(),
      undefined,
      undefined,
      fetchFn,
    );
    await mgr.startRunner({
      modelName: 'model-a',
      instanceId: 'inst-a',
      runnerType: 'vllm',
      modelPath: '/models/a',
      requiredMemory: 1000,
      tensorParallel: 1,
      devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
    });

    expect(await mgr.getLedgerInstanceShares()).toEqual([
      {
        instanceId: 'inst-a',
        modelName: 'model-a',
        deviceIndex: 0,
        bytes: 500,
        attribution: 'runner',
      },
    ]);
  });

  it("promotes a device-scope row only while the runner is the device's sole record", async () => {
    const fetchFn = makeFetchFn(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            devices: [{ deviceIndex: 0, memoryUsedBytes: 900, attribution: 'device' }],
          }),
      }),
    );
    const mgr = new RunnerManager(
      makeConfig(),
      makeRegistration(),
      makeLauncher(),
      undefined,
      undefined,
      fetchFn,
    );
    await mgr.startRunner({
      modelName: 'model-a',
      instanceId: 'inst-a',
      runnerType: 'vllm',
      modelPath: '/models/a',
      requiredMemory: 1000,
      tensorParallel: 1,
      devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
    });

    // Sole record on device 0: the whole-device observation is attributed to the lone
    // resident, carrying its SOURCE scope verbatim — never relabeled to 'runner'.
    expect(await mgr.getLedgerInstanceShares()).toEqual([
      {
        instanceId: 'inst-a',
        modelName: 'model-a',
        deviceIndex: 0,
        bytes: 900,
        attribution: 'device',
      },
    ]);
  });

  it('drops device-scope rows when two records claim the same device', async () => {
    // Two co-located runners on device 0, both real-shim style (device-scope rows).
    const fetchFn = makeFetchFn(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            devices: [{ deviceIndex: 0, memoryUsedBytes: 900, attribution: 'device' }],
          }),
      }),
    );
    const mgr = new RunnerManager(
      makeConfig(),
      makeRegistration(),
      makeLauncher(),
      undefined,
      undefined,
      fetchFn,
    );
    await mgr.startRunner({
      modelName: 'model-a',
      instanceId: 'inst-a',
      runnerType: 'vllm',
      modelPath: '/models/a',
      requiredMemory: 1000,
      tensorParallel: 1,
      devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
    });
    await mgr.startRunner({
      modelName: 'model-b',
      instanceId: 'inst-b',
      runnerType: 'vllm',
      modelPath: '/models/b',
      requiredMemory: 1000,
      tensorParallel: 1,
      devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
    });

    // Both rows are whole-device observations on a shared device: summing them would
    // double-count, so neither becomes an instance row. The double-count can no longer
    // be built; the bytes surface in the dashboard's Other bucket downstream.
    expect(await mgr.getLedgerInstanceShares()).toEqual([]);
  });

  it('treats an absent attribution as device-scope (sole record promoted, co-tenant dropped)', async () => {
    const legacyBody = { devices: [{ deviceIndex: 0, memoryUsedBytes: 700 }] }; // no attribution field
    const fetchFn = makeFetchFn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve(legacyBody) }),
    );

    // Sole record: unknown-scope row is promoted conservatively.
    const sole = new RunnerManager(
      makeConfig(),
      makeRegistration(),
      makeLauncher(),
      undefined,
      undefined,
      fetchFn,
    );
    await sole.startRunner({
      modelName: 'model-a',
      instanceId: 'inst-a',
      runnerType: 'vllm',
      modelPath: '/models/a',
      requiredMemory: 1000,
      tensorParallel: 1,
      devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
    });
    expect(await sole.getLedgerInstanceShares()).toEqual([
      { instanceId: 'inst-a', modelName: 'model-a', deviceIndex: 0, bytes: 700 },
    ]);

    // Co-tenant record on the same device: unknown-scope row is dropped.
    const shared = new RunnerManager(
      makeConfig(),
      makeRegistration(),
      makeLauncher(),
      undefined,
      undefined,
      fetchFn,
    );
    await shared.startRunner({
      modelName: 'model-a',
      instanceId: 'inst-a',
      runnerType: 'vllm',
      modelPath: '/models/a',
      requiredMemory: 1000,
      tensorParallel: 1,
      devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
    });
    await shared.startRunner({
      modelName: 'model-b',
      instanceId: 'inst-b',
      runnerType: 'vllm',
      modelPath: '/models/b',
      requiredMemory: 1000,
      tensorParallel: 1,
      devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
    });
    expect(await shared.getLedgerInstanceShares()).toEqual([]);
  });

  it("a sleeping co-tenant's record still blocks promotion (residency is record-based, not byte-based)", async () => {
    // Record A on device 0 reports device-scope bytes; record B (sleeping, same device)
    // reports 0 — filtered by the >0 guard — but its RECORD still claims the device.
    const fetchFn = makeFetchFn((url) =>
      url.includes('19305')
        ? Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ devices: [{ deviceIndex: 0, memoryUsedBytes: 0 }] }),
          })
        : Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                devices: [{ deviceIndex: 0, memoryUsedBytes: 900, attribution: 'device' }],
              }),
          }),
    );
    const mgr = new RunnerManager(
      makeConfig(),
      makeRegistration(),
      makeLauncher(),
      undefined,
      undefined,
      fetchFn,
    );
    await mgr.startRunner({
      modelName: 'model-a',
      instanceId: 'inst-a',
      runnerType: 'vllm',
      modelPath: '/models/a',
      requiredMemory: 1000,
      tensorParallel: 1,
      devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
    });
    await mgr.startRunner({
      modelName: 'model-b',
      instanceId: 'inst-b',
      runnerType: 'vllm',
      modelPath: '/models/b',
      requiredMemory: 1000,
      tensorParallel: 1,
      devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
    });

    // A's device-scope row is dropped: a sleeping co-tenant's residual CUDA context can
    // still hold bytes, so the whole-device figure must not become A's instance row.
    expect(await mgr.getLedgerInstanceShares()).toEqual([]);
  });

  it("TP instance with a co-tenant on one device keeps only its unshared device's row", async () => {
    // Record A (inst-a, port 19301) spans devices 0+1 (device-scope rows); record B
    // (inst-b, port 19305) sits on device 1 only, runner-scope (stub-style ledger share).
    const fetchFn = makeFetchFn((url) =>
      url.includes('19305')
        ? Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                devices: [{ deviceIndex: 1, memoryUsedBytes: 300, attribution: 'runner' }],
              }),
          })
        : Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                devices: [
                  { deviceIndex: 0, memoryUsedBytes: 900, attribution: 'device' },
                  { deviceIndex: 1, memoryUsedBytes: 900, attribution: 'device' },
                ],
              }),
          }),
    );
    const mgr = new RunnerManager(
      makeConfig(),
      makeRegistration(),
      makeLauncher(),
      undefined,
      undefined,
      fetchFn,
    );
    await mgr.startRunner({
      modelName: 'model-a',
      instanceId: 'inst-a',
      runnerType: 'vllm',
      modelPath: '/models/a',
      requiredMemory: 1800,
      tensorParallel: 2,
      devices: [
        { deviceIndex: 0, deviceType: 'CUDA' },
        { deviceIndex: 1, deviceType: 'CUDA' },
      ],
    });
    await mgr.startRunner({
      modelName: 'model-b',
      instanceId: 'inst-b',
      runnerType: 'vllm',
      modelPath: '/models/b',
      requiredMemory: 300,
      tensorParallel: 1,
      devices: [{ deviceIndex: 1, deviceType: 'CUDA' }],
    });

    // Device 0: A is the sole record → its device-scope row is promoted.
    // Device 1: A and B both claim it → A's device-scope row is dropped (B's runner-scope
    // row is kept — honest per-runner delta, summed freely). Row order follows the flatMap
    // over fetchMemoryReports' records (A first — it started first), devices in body order.
    expect(await mgr.getLedgerInstanceShares()).toEqual([
      {
        instanceId: 'inst-a',
        modelName: 'model-a',
        deviceIndex: 0,
        bytes: 900,
        attribution: 'device',
      },
      {
        instanceId: 'inst-b',
        modelName: 'model-b',
        deviceIndex: 1,
        bytes: 300,
        attribution: 'runner',
      },
    ]);
  });

  it('clamps a malformed runner-supplied attribution to absent (outbound report stays schema-valid)', async () => {
    const fetchFn = makeFetchFn(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            devices: [{ deviceIndex: 0, memoryUsedBytes: 800, attribution: 'RUNNER' }],
          }),
      }),
    );
    const mgr = new RunnerManager(
      makeConfig(),
      makeRegistration(),
      makeLauncher(),
      undefined,
      undefined,
      fetchFn,
    );
    await mgr.startRunner({
      modelName: 'model-a',
      instanceId: 'inst-a',
      runnerType: 'vllm',
      modelPath: '/models/a',
      requiredMemory: 1000,
      tensorParallel: 1,
      devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
    });

    // 'RUNNER' is not a contract enum value, but the fetch boundary casts the body untyped.
    // It is clamped to absent — unknown scope, device-conservative — so the sole record is
    // still promoted while the emitted row carries NO attribution field: the worker's
    // outbound report stays schema-valid whatever a runner emits.
    expect(await mgr.getLedgerInstanceShares()).toEqual([
      { instanceId: 'inst-a', modelName: 'model-a', deviceIndex: 0, bytes: 800 },
    ]);
  });
});

describe('getKvCacheDeviceStats', () => {
  // Same harness as the getLedgerInstanceShares block: fake launcher (no sockets), URL-keyed
  // fetchFn — only the injected fetch is exercised.
  function makeLauncher(): RunnerLauncher {
    return {
      serializeColdStarts: false,
      start: (spec: LaunchSpec): Promise<LaunchHandle> =>
        Promise.resolve({
          host: 'localhost',
          port: spec.port,
          enginePort: spec.enginePort,
          stop: () => Promise.resolve(),
        }),
    };
  }

  function makeFetchFn(
    impl: (url: string) => Promise<{ ok: boolean; json?: () => Promise<unknown> }>,
  ): typeof fetch {
    return vi.fn((url: unknown) => impl(url as string)) as unknown as typeof fetch;
  }

  const KV = { totalBytes: 8_000, usedBytes: 3_000, preallocBytes: 1_000, freeBytes: 4_000 };

  it('relays the runner-reported kvCache block per device, first-wins across co-located runners', async () => {
    const fetchFn = makeFetchFn((url) =>
      url.includes('19301')
        ? Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                devices: [
                  { deviceIndex: 0, memoryUsedBytes: 300, kvCache: KV },
                  { deviceIndex: 1, memoryUsedBytes: 0 }, // no pool on device 1
                ],
              }),
          })
        : Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                // Co-located on device 0 (shared pool segment) — the second report must not
                // clobber the first.
                devices: [
                  { deviceIndex: 0, memoryUsedBytes: 700, kvCache: { ...KV, usedBytes: 999 } },
                ],
              }),
          }),
    );
    const mgr = new RunnerManager(
      makeConfig(),
      makeRegistration(),
      makeLauncher(),
      undefined,
      undefined,
      fetchFn,
    );
    await mgr.startRunner({
      modelName: 'model-a',
      instanceId: 'inst-a',
      runnerType: 'vllm',
      modelPath: '/models/a',
      requiredMemory: 300,
      tensorParallel: 1,
      devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
    });
    await mgr.startRunner({
      modelName: 'model-b',
      instanceId: 'inst-b',
      runnerType: 'vllm',
      modelPath: '/models/b',
      requiredMemory: 700,
      tensorParallel: 1,
      devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
    });

    const stats = await mgr.getKvCacheDeviceStats();
    expect([...stats.keys()]).toEqual([0]);
    expect(stats.get(0)).toEqual(KV); // device 1 never appears (absent, not zero)
    // Both runners' /memory-report were polled (the shared fetch path, with the 2s timeout).
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const calls = (fetchFn as unknown as { mock: { calls: Array<[unknown, unknown]> } }).mock.calls;
    for (const call of calls) {
      expect(call[1]).toEqual(
        expect.objectContaining({ signal: expect.any(AbortSignal) as AbortSignal }),
      );
    }
  });

  it('returns an empty map when no runner reports a kvCache block', async () => {
    const fetchFn = makeFetchFn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ devices: [{ deviceIndex: 0, memoryUsedBytes: 300 }] }),
      }),
    );
    const mgr = new RunnerManager(
      makeConfig(),
      makeRegistration(),
      makeLauncher(),
      undefined,
      undefined,
      fetchFn,
    );
    await mgr.startRunner({
      modelName: 'model-a',
      instanceId: 'inst-a',
      runnerType: 'vllm',
      modelPath: '/models/a',
      requiredMemory: 300,
      tensorParallel: 1,
      devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
    });

    expect(await mgr.getKvCacheDeviceStats()).toEqual(new Map());
  });

  it('a failing runner contributes nothing (never throws)', async () => {
    const fetchFn = vi.fn(() =>
      Promise.reject(new Error('ECONNREFUSED')),
    ) as unknown as typeof fetch;
    const mgr = new RunnerManager(
      makeConfig(),
      makeRegistration(),
      makeLauncher(),
      undefined,
      undefined,
      fetchFn,
    );
    await mgr.startRunner({
      modelName: 'model-a',
      instanceId: 'inst-a',
      runnerType: 'vllm',
      modelPath: '/models/a',
      requiredMemory: 300,
      tensorParallel: 1,
      devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
    });

    await expect(mgr.getKvCacheDeviceStats()).resolves.toEqual(new Map());
  });

  it('returns an empty map when there are no running runners', async () => {
    const mgr = new RunnerManager(makeConfig(), makeRegistration());
    expect(await mgr.getKvCacheDeviceStats()).toEqual(new Map());
  });
});
