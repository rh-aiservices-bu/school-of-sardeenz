import { describe, it, expect, vi } from 'vitest';
import { detectNvidiaDevices, resolveDevices } from '../gpu-detect.js';
import type { NvmlReader } from '../nvml.js';
import type { DevWorkerConfig } from '../config.js';

const GIB = 1024 * 1024 * 1024;

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
    deviceMemoryBytes: 24 * GIB,
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

function makeReader(overrides: Partial<NvmlReader> = {}): NvmlReader {
  return {
    readDeviceMemory: vi.fn(() => null),
    readProcesses: vi.fn(() => null),
    readSample: vi.fn(() => null),
    shutdown: vi.fn(),
    ...overrides,
  };
}

describe('detectNvidiaDevices', () => {
  it('maps one NVML device (bytes passthrough)', () => {
    const reader = makeReader({
      readDeviceMemory: vi.fn(() => [
        { deviceIndex: 0, totalBytes: 8188 * 1024 * 1024, usedBytes: 0 },
      ]),
    });
    const devices = detectNvidiaDevices(reader);
    expect(devices).toEqual([
      { deviceIndex: 0, deviceType: 'CUDA', memoryTotalBytes: 8188 * 1024 * 1024 },
    ]);
  });

  it('maps multiple NVML devices with ascending indices', () => {
    const reader = makeReader({
      readDeviceMemory: vi.fn(() => [
        { deviceIndex: 0, totalBytes: 24564 * 1024 * 1024, usedBytes: 0 },
        { deviceIndex: 1, totalBytes: 24564 * 1024 * 1024, usedBytes: 0 },
      ]),
    });
    const devices = detectNvidiaDevices(reader);
    expect(devices).toHaveLength(2);
    expect(devices?.[0].deviceIndex).toBe(0);
    expect(devices?.[1].deviceIndex).toBe(1);
    expect(devices?.[1].memoryTotalBytes).toBe(24564 * 1024 * 1024);
  });

  it('returns null when NVML reports no devices', () => {
    const reader = makeReader({ readDeviceMemory: vi.fn(() => null) });
    expect(detectNvidiaDevices(reader)).toBeNull();
  });

  it('returns null on an empty device list', () => {
    const reader = makeReader({ readDeviceMemory: vi.fn(() => []) });
    expect(detectNvidiaDevices(reader)).toBeNull();
  });
});

describe('resolveDevices', () => {
  it('apptainer + CUDA detects real GPUs (source=nvml)', () => {
    const reader = makeReader({
      readDeviceMemory: vi.fn(() => [
        { deviceIndex: 0, totalBytes: 8188 * 1024 * 1024, usedBytes: 0 },
      ]),
    });
    const report = resolveDevices(
      makeConfig({ mode: 'apptainer', deviceCount: 2, deviceMemoryBytes: 24 * GIB }),
      reader,
    );
    expect(report.source).toBe('nvml');
    expect(report.devices).toEqual([
      { deviceIndex: 0, deviceType: 'CUDA', memoryTotalBytes: 8188 * 1024 * 1024 },
    ]);
  });

  it('apptainer falls back to configured fleet when NVML reader is null', () => {
    const report = resolveDevices(
      makeConfig({ mode: 'apptainer', deviceCount: 1, deviceMemoryBytes: 8 * GIB }),
      null,
    );
    expect(report.source).toBe('config');
    expect(report.devices).toEqual([
      { deviceIndex: 0, deviceType: 'CUDA', memoryTotalBytes: 8 * GIB },
    ]);
  });

  it('apptainer falls back to configured fleet when NVML reports no devices', () => {
    const reader = makeReader({ readDeviceMemory: vi.fn(() => null) });
    const report = resolveDevices(
      makeConfig({ mode: 'apptainer', deviceCount: 1, deviceMemoryBytes: 8 * GIB }),
      reader,
    );
    expect(report.source).toBe('config');
    expect(report.devices).toEqual([
      { deviceIndex: 0, deviceType: 'CUDA', memoryTotalBytes: 8 * GIB },
    ]);
  });

  it('stub mode never queries NVML — always the configured fleet', () => {
    const reader = makeReader();
    const report = resolveDevices(makeConfig({ mode: 'stub', deviceCount: 2 }), reader);
    expect(report.source).toBe('config');
    expect(report.devices).toHaveLength(2);
    expect(reader.readDeviceMemory).not.toHaveBeenCalled();
  });

  it('apptainer with a non-CUDA device type uses config (no NVML query)', () => {
    const reader = makeReader();
    const report = resolveDevices(
      makeConfig({ mode: 'apptainer', deviceType: 'ROCM', deviceCount: 1 }),
      reader,
    );
    expect(report.source).toBe('config');
    expect(reader.readDeviceMemory).not.toHaveBeenCalled();
  });
});
