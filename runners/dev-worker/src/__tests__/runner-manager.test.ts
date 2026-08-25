import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RunnerManager, ConflictError, NotFoundError } from '../runner-manager.js';
import { RunnerLogBuffer, RETAIN_TTL_MS } from '../runner-log-buffer.js';
import type { WorkerRegistration } from '../registration.js';
import type { DevWorkerConfig } from '../config.js';
import type { LaunchHandle, LaunchSpec, RunnerLauncher } from '../launcher.js';

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
    ...overrides,
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

  it('allocates ports in (management, engine) pairs so engine ports never collide', async () => {
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

    // Ports step by 2: r1 reserves (19301, 19302), r2 reserves (19303, 19304). Were the manager to
    // step by 1, r2's management port (19302) would collide with r1's engine port (management + 1).
    expect(r1.port).toBe(19301);
    expect(r2.port).toBe(19303);
  });

  it('rejects duplicate instanceId with ConflictError (#120: conflict key is instanceId, not model name)', async () => {
    await manager.startRunner({
      modelName: 'dupe-model',
      instanceId: 'inst-dupe-model',
      runnerType: 'vllm',
      modelPath: '/models/dupe',
      requiredMemory: 1024 * 1024 * 1024,
      tensorParallel: 1,
      devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
    });

    await expect(
      manager.startRunner({
        modelName: 'dupe-model',
        instanceId: 'inst-dupe-model',
        runnerType: 'vllm',
        modelPath: '/models/dupe',
        requiredMemory: 1024 * 1024 * 1024,
        tensorParallel: 1,
        devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
      }),
    ).rejects.toThrow(ConflictError);
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
      vi.advanceTimersByTime(RETAIN_TTL_MS);
      expect(logBuffer.has(runnerId)).toBe(false);
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

    expect(a.port).toBe(19303);
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
  const processesConfig = (): DevWorkerConfig => makeConfig({ workerPort: 19700, runnerPortStart: 19701 });

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
