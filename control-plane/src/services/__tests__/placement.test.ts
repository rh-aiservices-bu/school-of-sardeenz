import { describe, it, expect } from 'vitest';
import { WorkerStatus } from '@sardeenz/types';

import { PlacementPipeline, MostAvailableCapacityStrategy } from '../placement.js';
import type { WorkerRecord } from '../worker-pool.js';
import type { WorkerBudget, DeviceBudget } from '../memory-budget.js';

function makeWorker(
  workerId: string,
  capabilities: { runnerType: string; supportedDeviceTypes: string[] }[],
  devices: { deviceIndex: number; deviceType: string; memoryTotalBytes: number }[],
): WorkerRecord {
  return {
    workerId,
    status: WorkerStatus.ONLINE,
    capabilities: capabilities.map((c) => ({
      runnerType: c.runnerType,
      engineName: c.runnerType,
      supportedModelTypes: ['text-generation'],
      supportedDeviceTypes: c.supportedDeviceTypes,
      supportedSleepLevels: ['L1_HOST_RAM'],
    })),
    devices,
    lastHeartbeatAt: new Date().toISOString(),
    joinedAt: new Date().toISOString(),
    managementUrl: null,
  };
}

function makeBudget(
  workerId: string,
  devices: { deviceIndex: number; deviceType: string; totalBytes: number; usedBytes: number }[],
): WorkerBudget {
  return {
    workerId,
    devices: devices.map(
      (d): DeviceBudget => ({
        deviceIndex: d.deviceIndex,
        deviceType: d.deviceType,
        totalBytes: d.totalBytes,
        usedBytes: d.usedBytes,
        reservedBytes: 0,
        availableBytes: d.totalBytes - d.usedBytes,
      }),
    ),
    lastReportAt: new Date().toISOString(),
    stale: false,
  };
}

describe('PlacementPipeline', () => {
  const pipeline = new PlacementPipeline();

  it('places a model on a worker with matching runner type and capacity', () => {
    const workers = [
      makeWorker(
        'w1',
        [{ runnerType: 'vllm', supportedDeviceTypes: ['CUDA'] }],
        [{ deviceIndex: 0, deviceType: 'CUDA', memoryTotalBytes: 16e9 }],
      ),
    ];
    const budgets = new Map([
      [
        'w1',
        makeBudget('w1', [{ deviceIndex: 0, deviceType: 'CUDA', totalBytes: 16e9, usedBytes: 0 }]),
      ],
    ]);

    const result = pipeline.place(
      { modelName: 'test', runnerType: 'vllm', requiredMemory: 8e9, tensorParallel: 1 },
      workers,
      budgets,
    );

    expect(result).not.toBeNull();
    expect(result!.workerId).toBe('w1');
    expect(result!.devices).toHaveLength(1);
  });

  it('returns null when no worker has the required runner type', () => {
    const workers = [
      makeWorker(
        'w1',
        [{ runnerType: 'triton', supportedDeviceTypes: ['CUDA'] }],
        [{ deviceIndex: 0, deviceType: 'CUDA', memoryTotalBytes: 16e9 }],
      ),
    ];
    const budgets = new Map([
      [
        'w1',
        makeBudget('w1', [{ deviceIndex: 0, deviceType: 'CUDA', totalBytes: 16e9, usedBytes: 0 }]),
      ],
    ]);

    const result = pipeline.place(
      { modelName: 'test', runnerType: 'vllm', requiredMemory: 8e9, tensorParallel: 1 },
      workers,
      budgets,
    );

    expect(result).toBeNull();
  });

  it('returns null when no worker has enough capacity', () => {
    const workers = [
      makeWorker(
        'w1',
        [{ runnerType: 'vllm', supportedDeviceTypes: ['CUDA'] }],
        [{ deviceIndex: 0, deviceType: 'CUDA', memoryTotalBytes: 16e9 }],
      ),
    ];
    const budgets = new Map([
      [
        'w1',
        makeBudget('w1', [
          { deviceIndex: 0, deviceType: 'CUDA', totalBytes: 16e9, usedBytes: 15e9 },
        ]),
      ],
    ]);

    const result = pipeline.place(
      { modelName: 'test', runnerType: 'vllm', requiredMemory: 8e9, tensorParallel: 1 },
      workers,
      budgets,
    );

    expect(result).toBeNull();
  });

  it('filters by device type when specified', () => {
    const workers = [
      makeWorker(
        'w1',
        [{ runnerType: 'vllm', supportedDeviceTypes: ['CUDA'] }],
        [{ deviceIndex: 0, deviceType: 'CUDA', memoryTotalBytes: 16e9 }],
      ),
      makeWorker(
        'w2',
        [{ runnerType: 'vllm', supportedDeviceTypes: ['ROCM'] }],
        [{ deviceIndex: 0, deviceType: 'ROCM', memoryTotalBytes: 32e9 }],
      ),
    ];
    const budgets = new Map([
      [
        'w1',
        makeBudget('w1', [{ deviceIndex: 0, deviceType: 'CUDA', totalBytes: 16e9, usedBytes: 0 }]),
      ],
      [
        'w2',
        makeBudget('w2', [{ deviceIndex: 0, deviceType: 'ROCM', totalBytes: 32e9, usedBytes: 0 }]),
      ],
    ]);

    const result = pipeline.place(
      {
        modelName: 'test',
        runnerType: 'vllm',
        requiredMemory: 8e9,
        deviceType: 'ROCM',
        tensorParallel: 1,
      },
      workers,
      budgets,
    );

    expect(result).not.toBeNull();
    expect(result!.workerId).toBe('w2');
  });

  it('selects the worker with most available capacity (spread strategy)', () => {
    const workers = [
      makeWorker(
        'w1',
        [{ runnerType: 'vllm', supportedDeviceTypes: ['CUDA'] }],
        [{ deviceIndex: 0, deviceType: 'CUDA', memoryTotalBytes: 16e9 }],
      ),
      makeWorker(
        'w2',
        [{ runnerType: 'vllm', supportedDeviceTypes: ['CUDA'] }],
        [{ deviceIndex: 0, deviceType: 'CUDA', memoryTotalBytes: 32e9 }],
      ),
    ];
    const budgets = new Map([
      [
        'w1',
        makeBudget('w1', [{ deviceIndex: 0, deviceType: 'CUDA', totalBytes: 16e9, usedBytes: 0 }]),
      ],
      [
        'w2',
        makeBudget('w2', [{ deviceIndex: 0, deviceType: 'CUDA', totalBytes: 32e9, usedBytes: 0 }]),
      ],
    ]);

    const result = pipeline.place(
      { modelName: 'test', runnerType: 'vllm', requiredMemory: 8e9, tensorParallel: 1 },
      workers,
      budgets,
    );

    expect(result!.workerId).toBe('w2');
  });

  it('handles tensor parallelism across multiple devices', () => {
    const workers = [
      makeWorker(
        'w1',
        [{ runnerType: 'vllm', supportedDeviceTypes: ['CUDA'] }],
        [
          { deviceIndex: 0, deviceType: 'CUDA', memoryTotalBytes: 16e9 },
          { deviceIndex: 1, deviceType: 'CUDA', memoryTotalBytes: 16e9 },
        ],
      ),
    ];
    const budgets = new Map([
      [
        'w1',
        makeBudget('w1', [
          { deviceIndex: 0, deviceType: 'CUDA', totalBytes: 16e9, usedBytes: 0 },
          { deviceIndex: 1, deviceType: 'CUDA', totalBytes: 16e9, usedBytes: 0 },
        ]),
      ],
    ]);

    const result = pipeline.place(
      { modelName: 'test', runnerType: 'vllm', requiredMemory: 20e9, tensorParallel: 2 },
      workers,
      budgets,
    );

    expect(result).not.toBeNull();
    expect(result!.workerId).toBe('w1');
    expect(result!.devices).toHaveLength(2);
  });

  it('rejects stale worker budgets', () => {
    const workers = [
      makeWorker(
        'w1',
        [{ runnerType: 'vllm', supportedDeviceTypes: ['CUDA'] }],
        [{ deviceIndex: 0, deviceType: 'CUDA', memoryTotalBytes: 16e9 }],
      ),
    ];
    const staleBudget = makeBudget('w1', [
      { deviceIndex: 0, deviceType: 'CUDA', totalBytes: 16e9, usedBytes: 0 },
    ]);
    staleBudget.stale = true;
    const budgets = new Map([['w1', staleBudget]]);

    const result = pipeline.place(
      { modelName: 'test', runnerType: 'vllm', requiredMemory: 8e9, tensorParallel: 1 },
      workers,
      budgets,
    );

    expect(result).toBeNull();
  });
});

describe('MostAvailableCapacityStrategy', () => {
  const strategy = new MostAvailableCapacityStrategy();

  it('selects the candidate with the most available memory', () => {
    const candidates = [
      { workerId: 'w1', capability: {} as never, devices: [], availableMemory: 8e9 },
      { workerId: 'w2', capability: {} as never, devices: [], availableMemory: 16e9 },
      { workerId: 'w3', capability: {} as never, devices: [], availableMemory: 4e9 },
    ];

    const selected = strategy.select(candidates);
    expect(selected.workerId).toBe('w2');
  });
});
