import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WorkerRegistration } from '../registration.js';
import type { DevWorkerConfig } from '../config.js';

function makeConfig(overrides: Partial<DevWorkerConfig> = {}): DevWorkerConfig {
  return {
    redisUrl: 'redis://localhost:6379',
    redisKeyPrefix: 'sardeenz',
    workerId: 'test-worker-0',
    workerPort: 9100,
    runnerPortStart: 9101,
    deviceCount: 2,
    deviceType: 'CUDA',
    deviceMemoryBytes: 24 * 1024 * 1024 * 1024,
    runnerType: 'vllm',
    startupDelayMs: 3000,
    sleepDelayMs: 500,
    wakeDelayMs: 1500,
    inferenceDelayMs: 200,
    heartbeatIntervalMs: 100,
    ...overrides,
  };
}

interface PipelineCall {
  method: string;
  args: unknown[];
}

function makeMockRedis() {
  const pipelineCalls: PipelineCall[] = [];
  const setHistory: Array<{ key: string; value: string }> = [];

  const pipeline = {
    set: (...args: unknown[]) => {
      pipelineCalls.push({ method: 'set', args });
      return pipeline;
    },
    del: (...args: unknown[]) => {
      pipelineCalls.push({ method: 'del', args });
      return pipeline;
    },
    exec: vi.fn(async () => {
      return pipelineCalls.map(() => [null, 'OK']);
    }),
  };

  return {
    pipeline: vi.fn(() => {
      pipelineCalls.length = 0;
      return pipeline;
    }),
    set: vi.fn(async (key: string, value: string) => {
      setHistory.push({ key, value });
      return 'OK';
    }),
    _pipelineCalls: pipelineCalls,
    _setHistory: setHistory,
    _pipeline: pipeline,
  };
}

describe('WorkerRegistration', () => {
  let config: DevWorkerConfig;
  let mockRedis: ReturnType<typeof makeMockRedis>;
  let registration: WorkerRegistration;

  beforeEach(() => {
    config = makeConfig();
    mockRedis = makeMockRedis();
    registration = new WorkerRegistration(mockRedis as never, config);
  });

  afterEach(() => {
    registration.stopHeartbeat();
  });

  describe('register()', () => {
    it('writes info, heartbeat, and memory keys via pipeline', async () => {
      await registration.register();

      expect(mockRedis.pipeline).toHaveBeenCalled();
      expect(mockRedis._pipeline.exec).toHaveBeenCalled();

      const calls = mockRedis._pipelineCalls;
      const setKeys = calls.filter((c) => c.method === 'set').map((c) => c.args[0]);

      expect(setKeys).toContain('sardeenz:workers:test-worker-0:info');
      expect(setKeys).toContain('sardeenz:workers:test-worker-0:heartbeat');
      expect(setKeys).toContain('sardeenz:workers:test-worker-0:memory');
    });

    it('writes correct WorkerInfo shape', async () => {
      await registration.register();

      const infoCall = mockRedis._pipelineCalls.find(
        (c) => c.method === 'set' && (c.args[0] as string).endsWith(':info'),
      );
      const info = JSON.parse(infoCall!.args[1] as string);

      expect(info.capabilities).toHaveLength(1);
      expect(info.capabilities[0].runnerType).toBe('vllm');
      expect(info.capabilities[0].supportedSleepLevels).toEqual(['L1_HOST_RAM']);
      expect(info.devices).toHaveLength(2);
      expect(info.devices[0].deviceIndex).toBe(0);
      expect(info.devices[0].deviceType).toBe('CUDA');
      expect(info.devices[0].memoryTotalBytes).toBe(config.deviceMemoryBytes);
      expect(info.managementUrl).toBe('http://localhost:9100');
    });

    it('writes initial memory report with zero usage', async () => {
      await registration.register();

      const memoryCall = mockRedis._pipelineCalls.find(
        (c) => c.method === 'set' && (c.args[0] as string).endsWith(':memory'),
      );
      const report = JSON.parse(memoryCall!.args[1] as string);

      expect(report.devices).toHaveLength(2);
      for (const dev of report.devices) {
        expect(dev.memoryUsedBytes).toBe(0);
        expect(dev.memoryTotalBytes).toBe(config.deviceMemoryBytes);
      }
    });
  });

  describe('heartbeat', () => {
    it('updates heartbeat key on interval', async () => {
      registration.startHeartbeat();

      await new Promise((r) => setTimeout(r, 350));

      registration.stopHeartbeat();

      const hbCalls = mockRedis._setHistory.filter((c) => c.key.endsWith(':heartbeat'));
      expect(hbCalls.length).toBeGreaterThanOrEqual(2);

      for (const call of hbCalls) {
        expect(() => new Date(call.value)).not.toThrow();
      }
    });

    it('does not start duplicate heartbeat timers', () => {
      registration.startHeartbeat();
      registration.startHeartbeat();
      registration.stopHeartbeat();
    });
  });

  describe('deregister()', () => {
    it('deletes all three Redis keys', async () => {
      await registration.deregister();

      const delKeys = mockRedis._pipelineCalls
        .filter((c) => c.method === 'del')
        .map((c) => c.args[0]);

      expect(delKeys).toContain('sardeenz:workers:test-worker-0:info');
      expect(delKeys).toContain('sardeenz:workers:test-worker-0:heartbeat');
      expect(delKeys).toContain('sardeenz:workers:test-worker-0:memory');
    });
  });

  describe('memory tracking', () => {
    it('allocateMemory updates tracked usage and pushes report', async () => {
      const bytes = 4 * 1024 * 1024 * 1024;
      registration.allocateMemory(0, bytes);

      expect(registration.getDeviceMemoryUsed(0)).toBe(bytes);
      expect(registration.getDeviceMemoryUsed(1)).toBe(0);

      await new Promise((r) => setTimeout(r, 50));
      const memCalls = mockRedis._setHistory.filter((c) => c.key.endsWith(':memory'));
      expect(memCalls.length).toBeGreaterThanOrEqual(1);
    });

    it('freeMemory decreases tracked usage', () => {
      registration.allocateMemory(0, 1000);
      registration.freeMemory(0, 400);

      expect(registration.getDeviceMemoryUsed(0)).toBe(600);
    });

    it('freeMemory does not go below zero', () => {
      registration.freeMemory(0, 1000);
      expect(registration.getDeviceMemoryUsed(0)).toBe(0);
    });

    it('ignores invalid device indices', () => {
      registration.allocateMemory(-1, 1000);
      registration.allocateMemory(99, 1000);
      expect(registration.getDeviceMemoryUsed(-1)).toBe(0);
      expect(registration.getDeviceMemoryUsed(99)).toBe(0);
    });
  });
});
