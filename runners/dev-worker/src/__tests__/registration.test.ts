import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  WorkerRegistration,
  type CatalogCapabilityOverrides,
  type MeasuredMemorySample,
} from '../registration.js';
import type { DevWorkerConfig } from '../config.js';
import type { KVCacheStats, WorkerInfo, WorkerMemoryReport } from './response-types.js';

function makeConfig(overrides: Partial<DevWorkerConfig> = {}): DevWorkerConfig {
  return {
    redisUrl: 'redis://localhost:6379',
    redisKeyPrefix: 'sardeenz',
    workerId: 'test-worker-0',
    workerPort: 9100,
    advertiseHost: 'localhost',
    runnerPortStart: 9101,
    maxRunners: 32,
    deviceCount: 2,
    deviceType: 'CUDA',
    deviceMemoryBytes: 24 * 1024 * 1024 * 1024,
    runnerType: 'vllm',
    startupDelayMs: 3000,
    sleepDelayMs: 500,
    wakeDelayMs: 1500,
    inferenceDelayMs: 200,
    heartbeatIntervalMs: 100,
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
    exec: vi.fn(() => {
      return pipelineCalls.map(() => [null, 'OK']);
    }),
  };

  return {
    pipeline: vi.fn(() => {
      pipelineCalls.length = 0;
      return pipeline;
    }),
    set: vi.fn((...args: unknown[]) => {
      const [key, value] = args as [string, string];
      setHistory.push({ key, value });
      return 'OK';
    }),
    _pipelineCalls: pipelineCalls,
    _setHistory: setHistory,
    _pipeline: pipeline,
  };
}

function makeFetchFn(ok = true): typeof fetch {
  return vi.fn(() => Promise.resolve({ ok }) as unknown as Promise<Response>);
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
      const info = JSON.parse(infoCall!.args[1] as string) as WorkerInfo;

      expect(info.capabilities).toHaveLength(1);
      expect(info.capabilities[0].runnerType).toBe('vllm');
      expect(info.capabilities[0].supportedSleepLevels).toEqual(['L1_HOST_RAM']);
      expect(info.devices).toHaveLength(2);
      expect(info.devices[0].deviceIndex).toBe(0);
      expect(info.devices[0].deviceType).toBe('CUDA');
      expect(info.devices[0].memoryTotalBytes).toBe(config.deviceMemoryBytes);
      expect(info.managementUrl).toBe('http://localhost:9100');
    });

    it('advertises every configured runner family', async () => {
      config = makeConfig({ runnerTypes: ['vllm', 'mlserver'] });
      registration = new WorkerRegistration(mockRedis as never, config);

      await registration.register();

      const infoCall = mockRedis._pipelineCalls.find(
        (c) => c.method === 'set' && (c.args[0] as string).endsWith(':info'),
      );
      const info = JSON.parse(infoCall!.args[1] as string) as WorkerInfo;

      expect(info.capabilities.map((capability) => capability.runnerType)).toEqual([
        'vllm',
        'mlserver',
      ]);
    });

    it('uses advertiseHost in managementUrl', async () => {
      config = makeConfig({ advertiseHost: '10.244.1.5' });
      registration = new WorkerRegistration(mockRedis as never, config);

      await registration.register();

      const infoCall = mockRedis._pipelineCalls.find(
        (c) => c.method === 'set' && (c.args[0] as string).endsWith(':info'),
      );
      const info = JSON.parse(infoCall!.args[1] as string) as WorkerInfo;

      expect(info.managementUrl).toBe('http://10.244.1.5:9100');
    });

    it('writes initial memory report with zero (ledger-simulated) usage and no device stats', async () => {
      await registration.register();

      const memoryCall = mockRedis._pipelineCalls.find(
        (c) => c.method === 'set' && (c.args[0] as string).endsWith(':memory'),
      );
      const report = JSON.parse(memoryCall!.args[1] as string) as WorkerMemoryReport;

      expect(report.devices).toHaveLength(2);
      for (const dev of report.devices) {
        // No measuredProvider at all here — memoryUsedBytes falls all the way back to the ledger.
        expect(dev.memoryUsedBytes).toBe(0);
        expect(dev.memoryTotalBytes).toBe(config.deviceMemoryBytes);
        expect(dev.deviceName).toBeUndefined();
        expect(dev.utilizationPercent).toBeUndefined();
        expect(dev.temperatureC).toBeUndefined();
      }
      // instances[] is always present post-doctrine, even with no ledgerInstancesProvider wired.
      expect(report.instances).toEqual([]);
    });

    it('always sets reportedAt, even with no measuredProvider (stub mode)', async () => {
      await registration.register();

      const memoryCall = mockRedis._pipelineCalls.find(
        (c) => c.method === 'set' && (c.args[0] as string).endsWith(':memory'),
      );
      const report = JSON.parse(memoryCall!.args[1] as string) as WorkerMemoryReport;

      expect(report.reportedAt).toBeDefined();
      expect(() => new Date(report.reportedAt!)).not.toThrow();
      expect(new Date(report.reportedAt!).toISOString()).toBe(report.reportedAt);
    });

    it('registers with catalog-sourced capabilities', async () => {
      const overrides: CatalogCapabilityOverrides = {
        supportedModelTypes: ['LLM'],
        supportedSleepLevels: ['L1_HOST_RAM'],
        engineVersion: '0.21',
        maxTensorParallelism: 8,
        kvCacheElasticSharing: true,
        features: { prefixCaching: true },
      };
      registration = new WorkerRegistration(
        mockRedis as never,
        config,
        undefined,
        undefined,
        overrides,
      );

      await registration.register();

      const infoCall = mockRedis._pipelineCalls.find(
        (c) => c.method === 'set' && (c.args[0] as string).endsWith(':info'),
      );
      const info = JSON.parse(infoCall!.args[1] as string) as WorkerInfo;
      const capability = info.capabilities[0];

      expect(capability.engineVersion).toBe('0.21');
      expect(capability.maxTensorParallelism).toBe(8);
      expect(capability.kvCacheElasticSharing).toBe(true);
      expect(capability.features).toEqual({ prefixCaching: true });
    });

    it('defaults to fallback capabilities when no catalog overrides', async () => {
      await registration.register();

      const infoCall = mockRedis._pipelineCalls.find(
        (c) => c.method === 'set' && (c.args[0] as string).endsWith(':info'),
      );
      const info = JSON.parse(infoCall!.args[1] as string) as WorkerInfo;
      const capability = info.capabilities[0];

      expect(capability.supportedModelTypes).toEqual(['LLM']);
      expect(capability.engineVersion).toBe('0.0.1-dev');
      expect(capability.maxTensorParallelism).toBe(1);
      expect(capability.kvCacheElasticSharing).toBe(false);
      expect(capability.features).toEqual({});
    });
  });

  describe('heartbeat', () => {
    it('updates heartbeat key on interval', async () => {
      registration = new WorkerRegistration(mockRedis as never, config, undefined, makeFetchFn());
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

    it('writes heartbeat with TTL when healthz is healthy', async () => {
      const fetchFn = makeFetchFn(true);
      registration = new WorkerRegistration(mockRedis as never, config, undefined, fetchFn);

      registration.startHeartbeat();
      await new Promise((r) => setTimeout(r, 350));
      registration.stopHeartbeat();

      expect(fetchFn).toHaveBeenCalledWith('http://127.0.0.1:9100/healthz');

      const hbCalls = mockRedis.set.mock.calls.filter((c) =>
        (c[0] as string).endsWith(':heartbeat'),
      );
      expect(hbCalls.length).toBeGreaterThanOrEqual(2);
      for (const call of hbCalls) {
        expect(call[2]).toBe('PX');
        expect(call[3]).toBe(config.heartbeatIntervalMs * 4);
      }
    });

    it('skips heartbeat write when healthz returns non-200', async () => {
      const fetchFn = makeFetchFn(false);
      registration = new WorkerRegistration(mockRedis as never, config, undefined, fetchFn);

      registration.startHeartbeat();
      await new Promise((r) => setTimeout(r, 350));
      registration.stopHeartbeat();

      expect(fetchFn).toHaveBeenCalled();
      const hbCalls = mockRedis._setHistory.filter((c) => c.key.endsWith(':heartbeat'));
      expect(hbCalls.length).toBe(0);
    });

    it('skips heartbeat write when healthz fetch throws', async () => {
      const fetchFn = vi.fn(() =>
        Promise.reject(new Error('connection refused')),
      ) as unknown as typeof fetch;
      registration = new WorkerRegistration(mockRedis as never, config, undefined, fetchFn);

      registration.startHeartbeat();
      await new Promise((r) => setTimeout(r, 350));
      registration.stopHeartbeat();

      expect(fetchFn).toHaveBeenCalled();
      const hbCalls = mockRedis._setHistory.filter((c) => c.key.endsWith(':heartbeat'));
      expect(hbCalls.length).toBe(0);
    });

    it('pushes a fresh memory report on every successful heartbeat tick', async () => {
      const fetchFn = makeFetchFn(true);
      registration = new WorkerRegistration(mockRedis as never, config, undefined, fetchFn);

      registration.startHeartbeat();
      await new Promise((r) => setTimeout(r, 350));
      registration.stopHeartbeat();

      const memCalls = mockRedis._setHistory.filter((c) => c.key.endsWith(':memory'));
      expect(memCalls.length).toBeGreaterThanOrEqual(2);
      for (const call of memCalls) {
        const report = JSON.parse(call.value) as WorkerMemoryReport;
        expect(report.reportedAt).toBeDefined();
      }
    });

    it('does not push a memory report when healthz is unhealthy', async () => {
      const fetchFn = makeFetchFn(false);
      registration = new WorkerRegistration(mockRedis as never, config, undefined, fetchFn);

      registration.startHeartbeat();
      await new Promise((r) => setTimeout(r, 350));
      registration.stopHeartbeat();

      const memCalls = mockRedis._setHistory.filter((c) => c.key.endsWith(':memory'));
      expect(memCalls.length).toBe(0);
    });

    it('a throwing measuredProvider never blocks the heartbeat SET or the memory push, across several ticks', async () => {
      // Fake timers drive several deterministic ticks (rather than racing real setTimeout waits)
      // so this test can assert ordering — the heartbeat SET and the memory push both still
      // happen on every tick — without relying on wall-clock timing.
      vi.useFakeTimers();
      try {
        const fetchFn = makeFetchFn(true);
        const measuredProvider = vi.fn(() => Promise.reject(new Error('NVML query failed')));
        registration = new WorkerRegistration(
          mockRedis as never,
          config,
          undefined,
          fetchFn,
          undefined,
          measuredProvider,
        );

        registration.startHeartbeat();
        await vi.advanceTimersByTimeAsync(config.heartbeatIntervalMs * 3);
        registration.stopHeartbeat();

        expect(measuredProvider.mock.calls.length).toBeGreaterThanOrEqual(2);

        const hbCalls = mockRedis._setHistory.filter((c) => c.key.endsWith(':heartbeat'));
        expect(hbCalls.length).toBeGreaterThanOrEqual(2);

        const memCalls = mockRedis._setHistory.filter((c) => c.key.endsWith(':memory'));
        expect(memCalls.length).toBeGreaterThanOrEqual(2);
        // Same tick count on both keys — the throwing provider never causes a tick to skip
        // the heartbeat SET or drop the memory push entirely.
        expect(memCalls.length).toBe(hbCalls.length);
        for (const call of memCalls) {
          const report = JSON.parse(call.value) as WorkerMemoryReport;
          expect(report.reportedAt).toBeDefined();
          for (const dev of report.devices) {
            // NVML provider is throwing every tick, and no ledgerInstancesProvider is wired here —
            // devices fall back to the (untouched) ledger, currently 0.
            expect(dev.memoryUsedBytes).toBe(0);
            expect(dev.deviceName).toBeUndefined();
          }
          expect(report.instances).toEqual([]);
        }
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('measured memory (NVML)', () => {
    it('folds measuredProvider device + instance samples into the report, incl. device stats', async () => {
      const sample: MeasuredMemorySample = {
        devices: [
          {
            deviceIndex: 0,
            memoryUsedBytes: 5_000_000,
            deviceName: 'NVIDIA GeForce RTX 4070 Ti',
            utilizationPercent: 42,
            temperatureC: 65,
          },
        ],
        instances: [
          {
            instanceId: 'inst-abc123',
            modelName: 'llama-3-8b',
            deviceIndex: 0,
            memoryUsedBytes: 4_500_000,
          },
        ],
      };
      const measuredProvider = vi.fn(() => Promise.resolve(sample));
      registration = new WorkerRegistration(
        mockRedis as never,
        config,
        undefined,
        undefined,
        undefined,
        measuredProvider,
      );

      await registration.register();

      const memoryCall = mockRedis._pipelineCalls.find(
        (c) => c.method === 'set' && (c.args[0] as string).endsWith(':memory'),
      );
      const report = JSON.parse(memoryCall!.args[1] as string) as WorkerMemoryReport;

      // Device 0 is NVML-measured, including the extra stats.
      expect(report.devices[0].memoryUsedBytes).toBe(5_000_000);
      expect(report.devices[0].deviceName).toBe('NVIDIA GeForce RTX 4070 Ti');
      expect(report.devices[0].utilizationPercent).toBe(42);
      expect(report.devices[0].temperatureC).toBe(65);
      // Device 1 has no NVML sample — falls back to the (untouched) ledger, currently 0, with no
      // device stats (the ledger has no notion of utilization/temperature/name).
      expect(report.devices[1].memoryUsedBytes).toBe(0);
      expect(report.devices[1].deviceName).toBeUndefined();
      expect(report.instances).toEqual(sample.instances);
    });

    it('falls back to the ledger for devices and to [] for instances when measuredProvider resolves null (CPU/stub box, no ledgerInstancesProvider wired)', async () => {
      const measuredProvider = vi.fn(() => Promise.resolve(null));
      registration = new WorkerRegistration(
        mockRedis as never,
        config,
        undefined,
        undefined,
        undefined,
        measuredProvider,
      );

      await registration.register();

      const memoryCall = mockRedis._pipelineCalls.find(
        (c) => c.method === 'set' && (c.args[0] as string).endsWith(':memory'),
      );
      const report = JSON.parse(memoryCall!.args[1] as string) as WorkerMemoryReport;

      expect(measuredProvider).toHaveBeenCalled();
      for (const dev of report.devices) {
        expect(dev.memoryUsedBytes).toBe(0);
        expect(dev.deviceName).toBeUndefined();
      }
      expect(report.instances).toEqual([]);
    });

    it('degrades to ledger fallback when measuredProvider throws', async () => {
      const measuredProvider = vi.fn(() => Promise.reject(new Error('NVML query failed')));
      registration = new WorkerRegistration(
        mockRedis as never,
        config,
        undefined,
        undefined,
        undefined,
        measuredProvider,
      );

      await expect(registration.register()).resolves.toBeUndefined();

      const memoryCall = mockRedis._pipelineCalls.find(
        (c) => c.method === 'set' && (c.args[0] as string).endsWith(':memory'),
      );
      const report = JSON.parse(memoryCall!.args[1] as string) as WorkerMemoryReport;

      expect(report.devices).toHaveLength(2);
      expect(report.instances).toEqual([]);
      expect(report.reportedAt).toBeDefined();
    });

    it('uses ledgerInstancesProvider to simulate instances[] when there is no NVML sample', async () => {
      const ledgerInstancesProvider = vi.fn(() =>
        Promise.resolve([
          {
            instanceId: 'inst-stub-1',
            modelName: 'stub-model',
            deviceIndex: 0,
            memoryUsedBytes: 2_000_000,
          },
        ]),
      );
      registration = new WorkerRegistration(
        mockRedis as never,
        config,
        undefined,
        undefined,
        undefined,
        undefined, // no measuredProvider at all — stub mode
        ledgerInstancesProvider,
      );

      await registration.register();

      const memoryCall = mockRedis._pipelineCalls.find(
        (c) => c.method === 'set' && (c.args[0] as string).endsWith(':memory'),
      );
      const report = JSON.parse(memoryCall!.args[1] as string) as WorkerMemoryReport;

      expect(ledgerInstancesProvider).toHaveBeenCalled();
      expect(report.instances).toEqual([
        {
          instanceId: 'inst-stub-1',
          modelName: 'stub-model',
          deviceIndex: 0,
          memoryUsedBytes: 2_000_000,
        },
      ]);
    });

    it('never calls ledgerInstancesProvider when the NVML measuredProvider succeeds', async () => {
      const sample: MeasuredMemorySample = {
        devices: [{ deviceIndex: 0, memoryUsedBytes: 5_000_000 }],
        instances: [],
      };
      const measuredProvider = vi.fn(() => Promise.resolve(sample));
      const ledgerInstancesProvider = vi.fn(() => Promise.resolve([]));
      registration = new WorkerRegistration(
        mockRedis as never,
        config,
        undefined,
        undefined,
        undefined,
        measuredProvider,
        ledgerInstancesProvider,
      );

      await registration.register();

      expect(measuredProvider).toHaveBeenCalled();
      expect(ledgerInstancesProvider).not.toHaveBeenCalled();
    });

    it('degrades to [] when ledgerInstancesProvider itself throws', async () => {
      const ledgerInstancesProvider = vi.fn(() => Promise.reject(new Error('worker unreachable')));
      registration = new WorkerRegistration(
        mockRedis as never,
        config,
        undefined,
        undefined,
        undefined,
        undefined,
        ledgerInstancesProvider,
      );

      await expect(registration.register()).resolves.toBeUndefined();

      const memoryCall = mockRedis._pipelineCalls.find(
        (c) => c.method === 'set' && (c.args[0] as string).endsWith(':memory'),
      );
      const report = JSON.parse(memoryCall!.args[1] as string) as WorkerMemoryReport;
      expect(report.instances).toEqual([]);
    });
  });

  describe('kvcached pool telemetry (#165)', () => {
    const kvStats: KVCacheStats = {
      totalBytes: 8_000,
      usedBytes: 3_000,
      preallocBytes: 1_000,
      freeBytes: 4_000,
    };

    function kvProvider(map: Map<number, KVCacheStats> | null) {
      return vi.fn(() => Promise.resolve(map));
    }

    it('relays the per-device kvCache block verbatim; devices without a pool omit it', async () => {
      const kvCacheDeviceProvider = kvProvider(new Map([[0, kvStats]]));
      registration = new WorkerRegistration(
        mockRedis as never,
        config,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        kvCacheDeviceProvider,
      );

      await registration.register();

      const memoryCall = mockRedis._pipelineCalls.find(
        (c) => c.method === 'set' && (c.args[0] as string).endsWith(':memory'),
      );
      const report = JSON.parse(memoryCall!.args[1] as string) as WorkerMemoryReport;

      expect(kvCacheDeviceProvider).toHaveBeenCalled();
      expect(report.devices[0].kvCache).toEqual(kvStats);
      // Device 1 has no pool — the field is absent, not zeroed.
      expect(report.devices[1].kvCache).toBeUndefined();
    });

    it('includes kvCache alongside NVML-measured devices (independent of the ledger fallback)', async () => {
      const sample: MeasuredMemorySample = {
        devices: [{ deviceIndex: 0, memoryUsedBytes: 5_000_000, deviceName: 'NVIDIA RTX 4090' }],
        instances: [],
      };
      const measuredProvider = vi.fn(() => Promise.resolve(sample));
      const kvCacheDeviceProvider = kvProvider(new Map([[0, kvStats], [1, kvStats]]));
      registration = new WorkerRegistration(
        mockRedis as never,
        config,
        undefined,
        undefined,
        undefined,
        measuredProvider,
        undefined,
        kvCacheDeviceProvider,
      );

      await registration.register();

      const memoryCall = mockRedis._pipelineCalls.find(
        (c) => c.method === 'set' && (c.args[0] as string).endsWith(':memory'),
      );
      const report = JSON.parse(memoryCall!.args[1] as string) as WorkerMemoryReport;

      expect(report.devices[0].memoryUsedBytes).toBe(5_000_000);
      expect(report.devices[0].kvCache).toEqual(kvStats);
      // Device 1 is ledger-fallback (no NVML sample) but still carries its pool stats.
      expect(report.devices[1].memoryUsedBytes).toBe(0);
      expect(report.devices[1].kvCache).toEqual(kvStats);
    });

    it('includes kvCache in no-NVML (ledger) mode too', async () => {
      const ledgerInstancesProvider = vi.fn(() =>
        Promise.resolve([
          { instanceId: 'inst-1', modelName: 'm', deviceIndex: 0, memoryUsedBytes: 2_000 },
        ]),
      );
      const kvCacheDeviceProvider = kvProvider(new Map([[0, kvStats]]));
      registration = new WorkerRegistration(
        mockRedis as never,
        config,
        undefined,
        undefined,
        undefined,
        undefined,
        ledgerInstancesProvider,
        kvCacheDeviceProvider,
      );

      await registration.register();

      const memoryCall = mockRedis._pipelineCalls.find(
        (c) => c.method === 'set' && (c.args[0] as string).endsWith(':memory'),
      );
      const report = JSON.parse(memoryCall!.args[1] as string) as WorkerMemoryReport;
      expect(report.devices[0].kvCache).toEqual(kvStats);
      expect(report.instances).toHaveLength(1);
    });

    it('omits kvCache entirely when the provider resolves null', async () => {
      const kvCacheDeviceProvider = kvProvider(null);
      registration = new WorkerRegistration(
        mockRedis as never,
        config,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        kvCacheDeviceProvider,
      );

      await registration.register();

      const memoryCall = mockRedis._pipelineCalls.find(
        (c) => c.method === 'set' && (c.args[0] as string).endsWith(':memory'),
      );
      const report = JSON.parse(memoryCall!.args[1] as string) as WorkerMemoryReport;
      for (const dev of report.devices) expect(dev.kvCache).toBeUndefined();
    });

    it('a throwing kvCacheDeviceProvider degrades to no kvCache, report still built', async () => {
      const kvCacheDeviceProvider = vi.fn(() => Promise.reject(new Error('runner unreachable')));
      registration = new WorkerRegistration(
        mockRedis as never,
        config,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        kvCacheDeviceProvider,
      );

      await expect(registration.register()).resolves.toBeUndefined();

      const memoryCall = mockRedis._pipelineCalls.find(
        (c) => c.method === 'set' && (c.args[0] as string).endsWith(':memory'),
      );
      const report = JSON.parse(memoryCall!.args[1] as string) as WorkerMemoryReport;
      expect(report.devices).toHaveLength(2);
      for (const dev of report.devices) expect(dev.kvCache).toBeUndefined();
      expect(report.reportedAt).toBeDefined();
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
