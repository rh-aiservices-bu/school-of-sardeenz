import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { RunnerManager, ConflictError, NotFoundError } from '../runner-manager.js';
import type { WorkerRegistration } from '../registration.js';
import type { DevWorkerConfig } from '../config.js';
import type { LaunchHandle, LaunchSpec, RunnerLauncher } from '../launcher.js';

function makeConfig(overrides: Partial<DevWorkerConfig> = {}): DevWorkerConfig {
  return {
    redisUrl: 'redis://localhost:6379',
    redisKeyPrefix: 'sardeenz',
    workerId: 'test-worker-0',
    workerPort: 19300,
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

describe('RunnerManager', () => {
  let manager: RunnerManager;

  beforeEach(() => {
    manager = new RunnerManager(makeConfig(), makeRegistration());
  });

  afterEach(async () => {
    await manager.stopAll();
  });

  it('starts a runner and returns runnerId, host, port', async () => {
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
  });

  it('allocates sequential ports for multiple runners', async () => {
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

    expect(r1.port).toBe(19301);
    expect(r2.port).toBe(19302);
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
        return { host: 'localhost', port: spec.port, stop: () => Promise.resolve() };
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
});
