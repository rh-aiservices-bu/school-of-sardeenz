import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { RunnerManager, ConflictError, NotFoundError } from '../runner-manager.js';
import type { WorkerRegistration } from '../registration.js';
import type { DevWorkerConfig } from '../config.js';

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
