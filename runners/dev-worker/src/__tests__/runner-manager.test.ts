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
      runnerType: 'vllm',
      modelPath: '/models/a',
      requiredMemory: 1024 * 1024 * 1024,
      tensorParallel: 1,
      devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
    });
    const r2 = await manager.startRunner({
      modelName: 'model-b',
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

  it('rejects duplicate model names with ConflictError', async () => {
    await manager.startRunner({
      modelName: 'dupe-model',
      runnerType: 'vllm',
      modelPath: '/models/dupe',
      requiredMemory: 1024 * 1024 * 1024,
      tensorParallel: 1,
      devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
    });

    await expect(
      manager.startRunner({
        modelName: 'dupe-model',
        runnerType: 'vllm',
        modelPath: '/models/dupe',
        requiredMemory: 1024 * 1024 * 1024,
        tensorParallel: 1,
        devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
      }),
    ).rejects.toThrow(ConflictError);
  });

  it('stops a runner by ID', async () => {
    const result = await manager.startRunner({
      modelName: 'stop-me',
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
      runnerType: 'vllm',
      modelPath: '/models/x',
      requiredMemory: 1024 * 1024 * 1024,
      tensorParallel: 1,
      devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
    });
    await manager.startRunner({
      modelName: 'model-y',
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
      runnerType: 'vllm',
      modelPath: '/models/1',
      requiredMemory: 1024 * 1024 * 1024,
      tensorParallel: 1,
      devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
    });
    await manager.startRunner({
      modelName: 'model-2',
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
      runnerType: 'vllm',
      modelPath: '/models/recycled',
      requiredMemory: 1024 * 1024 * 1024,
      tensorParallel: 1,
      devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
    });
    await manager.stopRunner(r1.runnerId);

    const r2 = await manager.startRunner({
      modelName: 'recycled',
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
});
