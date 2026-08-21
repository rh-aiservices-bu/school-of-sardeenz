import { describe, it, expect, vi } from 'vitest';
import { detectNvidiaDevices, resolveDevices, type ExecFn } from '../gpu-detect.js';
import type { DevWorkerConfig } from '../config.js';

const GIB = 1024 * 1024 * 1024;
const MIB = 1024 * 1024;

function makeConfig(overrides: Partial<DevWorkerConfig> = {}): DevWorkerConfig {
  return {
    redisUrl: 'redis://localhost:6379',
    redisKeyPrefix: 'sardeenz',
    workerId: 'test-worker-0',
    workerPort: 9100,
    advertiseHost: 'localhost',
    runnerPortStart: 9101,
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
    ...overrides,
  };
}

const execReturning = (stdout: string): ExecFn => vi.fn(() => Promise.resolve({ stdout }));
const execThrowing = (): ExecFn =>
  vi.fn(() => Promise.reject(new Error('spawn nvidia-smi ENOENT')));

describe('detectNvidiaDevices', () => {
  it('parses one GPU (MiB → bytes)', async () => {
    const devices = await detectNvidiaDevices(execReturning('8188\n'));
    expect(devices).toEqual([{ deviceIndex: 0, deviceType: 'CUDA', memoryTotalBytes: 8188 * MIB }]);
  });

  it('parses multiple GPUs with ascending indices', async () => {
    const devices = await detectNvidiaDevices(execReturning('24564\n24564\n'));
    expect(devices).toHaveLength(2);
    expect(devices?.[0].deviceIndex).toBe(0);
    expect(devices?.[1].deviceIndex).toBe(1);
    expect(devices?.[1].memoryTotalBytes).toBe(24564 * MIB);
  });

  it('returns null when nvidia-smi is unavailable', async () => {
    expect(await detectNvidiaDevices(execThrowing())).toBeNull();
  });

  it('returns null on empty output (no GPUs)', async () => {
    expect(await detectNvidiaDevices(execReturning('\n  \n'))).toBeNull();
  });

  it('returns null on non-numeric output rather than advertising a bogus fleet', async () => {
    expect(await detectNvidiaDevices(execReturning('No devices were found\n'))).toBeNull();
  });
});

describe('resolveDevices', () => {
  it('apptainer + CUDA detects real GPUs (source=nvidia-smi)', async () => {
    const report = await resolveDevices(
      makeConfig({ mode: 'apptainer', deviceCount: 2, deviceMemoryBytes: 24 * GIB }),
      execReturning('8188\n'),
    );
    expect(report.source).toBe('nvidia-smi');
    expect(report.devices).toEqual([
      { deviceIndex: 0, deviceType: 'CUDA', memoryTotalBytes: 8188 * MIB },
    ]);
  });

  it('apptainer falls back to configured fleet when nvidia-smi is absent', async () => {
    const report = await resolveDevices(
      makeConfig({ mode: 'apptainer', deviceCount: 1, deviceMemoryBytes: 8 * GIB }),
      execThrowing(),
    );
    expect(report.source).toBe('config');
    expect(report.devices).toEqual([
      { deviceIndex: 0, deviceType: 'CUDA', memoryTotalBytes: 8 * GIB },
    ]);
  });

  it('stub mode never shells out — always the configured fleet', async () => {
    const exec = execThrowing();
    const report = await resolveDevices(makeConfig({ mode: 'stub', deviceCount: 2 }), exec);
    expect(report.source).toBe('config');
    expect(report.devices).toHaveLength(2);
    expect(exec).not.toHaveBeenCalled();
  });

  it('apptainer with a non-CUDA device type uses config (no nvidia-smi)', async () => {
    const exec = execThrowing();
    const report = await resolveDevices(
      makeConfig({ mode: 'apptainer', deviceType: 'ROCM', deviceCount: 1 }),
      exec,
    );
    expect(report.source).toBe('config');
    expect(exec).not.toHaveBeenCalled();
  });
});
