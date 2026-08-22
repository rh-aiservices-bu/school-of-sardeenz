import { describe, it, expect } from 'vitest';
import { WorkerStatus, DeviceType, ModelType, SleepLevel } from '@sardeenz/types';

import { PlacementPipeline, MostAvailableCapacityStrategy } from '../placement.js';
import type { WorkerRecord } from '../worker-pool.js';
import type { WorkerBudget, DeviceBudget } from '../memory-budget.js';

function makeWorker(
  workerId: string,
  capabilities: { runnerType: string; supportedDeviceTypes: DeviceType[] }[],
  devices: { deviceIndex: number; deviceType: DeviceType; memoryTotalBytes: number }[],
): WorkerRecord {
  return {
    workerId,
    status: WorkerStatus.ONLINE,
    capabilities: capabilities.map((c) => ({
      runnerType: c.runnerType,
      engineName: c.runnerType,
      supportedModelTypes: [ModelType.LLM],
      supportedDeviceTypes: c.supportedDeviceTypes,
      supportedSleepLevels: [SleepLevel.L1_HOST_RAM],
      maxTensorParallelism: 1,
      kvCacheElasticSharing: false,
    })),
    devices,
    lastHeartbeatAt: new Date().toISOString(),
    joinedAt: new Date().toISOString(),
    managementUrl: `http://${workerId}:9100`,
  };
}

function makeBudget(
  workerId: string,
  devices: { deviceIndex: number; deviceType: DeviceType; totalBytes: number; usedBytes: number }[],
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
        [{ runnerType: 'vllm', supportedDeviceTypes: [DeviceType.CUDA] }],
        [{ deviceIndex: 0, deviceType: DeviceType.CUDA, memoryTotalBytes: 16e9 }],
      ),
    ];
    const budgets = new Map([
      [
        'w1',
        makeBudget('w1', [
          { deviceIndex: 0, deviceType: DeviceType.CUDA, totalBytes: 16e9, usedBytes: 0 },
        ]),
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
        [{ runnerType: 'triton', supportedDeviceTypes: [DeviceType.CUDA] }],
        [{ deviceIndex: 0, deviceType: DeviceType.CUDA, memoryTotalBytes: 16e9 }],
      ),
    ];
    const budgets = new Map([
      [
        'w1',
        makeBudget('w1', [
          { deviceIndex: 0, deviceType: DeviceType.CUDA, totalBytes: 16e9, usedBytes: 0 },
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

  it('returns null when no worker has enough capacity', () => {
    const workers = [
      makeWorker(
        'w1',
        [{ runnerType: 'vllm', supportedDeviceTypes: [DeviceType.CUDA] }],
        [{ deviceIndex: 0, deviceType: DeviceType.CUDA, memoryTotalBytes: 16e9 }],
      ),
    ];
    const budgets = new Map([
      [
        'w1',
        makeBudget('w1', [
          { deviceIndex: 0, deviceType: DeviceType.CUDA, totalBytes: 16e9, usedBytes: 15e9 },
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
        [{ runnerType: 'vllm', supportedDeviceTypes: [DeviceType.CUDA] }],
        [{ deviceIndex: 0, deviceType: DeviceType.CUDA, memoryTotalBytes: 16e9 }],
      ),
      makeWorker(
        'w2',
        [{ runnerType: 'vllm', supportedDeviceTypes: [DeviceType.ROCM] }],
        [{ deviceIndex: 0, deviceType: DeviceType.ROCM, memoryTotalBytes: 32e9 }],
      ),
    ];
    const budgets = new Map([
      [
        'w1',
        makeBudget('w1', [
          { deviceIndex: 0, deviceType: DeviceType.CUDA, totalBytes: 16e9, usedBytes: 0 },
        ]),
      ],
      [
        'w2',
        makeBudget('w2', [
          { deviceIndex: 0, deviceType: DeviceType.ROCM, totalBytes: 32e9, usedBytes: 0 },
        ]),
      ],
    ]);

    const result = pipeline.place(
      {
        modelName: 'test',
        runnerType: 'vllm',
        requiredMemory: 8e9,
        deviceType: DeviceType.ROCM,
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
        [{ runnerType: 'vllm', supportedDeviceTypes: [DeviceType.CUDA] }],
        [{ deviceIndex: 0, deviceType: DeviceType.CUDA, memoryTotalBytes: 16e9 }],
      ),
      makeWorker(
        'w2',
        [{ runnerType: 'vllm', supportedDeviceTypes: [DeviceType.CUDA] }],
        [{ deviceIndex: 0, deviceType: DeviceType.CUDA, memoryTotalBytes: 32e9 }],
      ),
    ];
    const budgets = new Map([
      [
        'w1',
        makeBudget('w1', [
          { deviceIndex: 0, deviceType: DeviceType.CUDA, totalBytes: 16e9, usedBytes: 0 },
        ]),
      ],
      [
        'w2',
        makeBudget('w2', [
          { deviceIndex: 0, deviceType: DeviceType.CUDA, totalBytes: 32e9, usedBytes: 0 },
        ]),
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
        [{ runnerType: 'vllm', supportedDeviceTypes: [DeviceType.CUDA] }],
        [
          { deviceIndex: 0, deviceType: DeviceType.CUDA, memoryTotalBytes: 16e9 },
          { deviceIndex: 1, deviceType: DeviceType.CUDA, memoryTotalBytes: 16e9 },
        ],
      ),
    ];
    const budgets = new Map([
      [
        'w1',
        makeBudget('w1', [
          { deviceIndex: 0, deviceType: DeviceType.CUDA, totalBytes: 16e9, usedBytes: 0 },
          { deviceIndex: 1, deviceType: DeviceType.CUDA, totalBytes: 16e9, usedBytes: 0 },
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

  it('excludes DEGRADED workers from placement', () => {
    const workers = [
      {
        ...makeWorker(
          'w1',
          [{ runnerType: 'vllm', supportedDeviceTypes: [DeviceType.CUDA] }],
          [{ deviceIndex: 0, deviceType: DeviceType.CUDA, memoryTotalBytes: 16e9 }],
        ),
        status: WorkerStatus.DEGRADED,
      },
    ];
    const budgets = new Map([
      [
        'w1',
        makeBudget('w1', [
          { deviceIndex: 0, deviceType: DeviceType.CUDA, totalBytes: 16e9, usedBytes: 0 },
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

  it('excludes OFFLINE workers from placement', () => {
    const workers = [
      {
        ...makeWorker(
          'w1',
          [{ runnerType: 'vllm', supportedDeviceTypes: [DeviceType.CUDA] }],
          [{ deviceIndex: 0, deviceType: DeviceType.CUDA, memoryTotalBytes: 16e9 }],
        ),
        status: WorkerStatus.OFFLINE,
      },
    ];
    const budgets = new Map([
      [
        'w1',
        makeBudget('w1', [
          { deviceIndex: 0, deviceType: DeviceType.CUDA, totalBytes: 16e9, usedBytes: 0 },
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

  it('selects the only ONLINE worker when others are unhealthy', () => {
    const workers = [
      {
        ...makeWorker(
          'w1',
          [{ runnerType: 'vllm', supportedDeviceTypes: [DeviceType.CUDA] }],
          [{ deviceIndex: 0, deviceType: DeviceType.CUDA, memoryTotalBytes: 16e9 }],
        ),
        status: WorkerStatus.DEGRADED,
      },
      {
        ...makeWorker(
          'w2',
          [{ runnerType: 'vllm', supportedDeviceTypes: [DeviceType.CUDA] }],
          [{ deviceIndex: 0, deviceType: DeviceType.CUDA, memoryTotalBytes: 16e9 }],
        ),
        status: WorkerStatus.OFFLINE,
      },
      makeWorker(
        'w3',
        [{ runnerType: 'vllm', supportedDeviceTypes: [DeviceType.CUDA] }],
        [{ deviceIndex: 0, deviceType: DeviceType.CUDA, memoryTotalBytes: 16e9 }],
      ),
    ];
    const budgets = new Map([
      [
        'w1',
        makeBudget('w1', [
          { deviceIndex: 0, deviceType: DeviceType.CUDA, totalBytes: 16e9, usedBytes: 0 },
        ]),
      ],
      [
        'w2',
        makeBudget('w2', [
          { deviceIndex: 0, deviceType: DeviceType.CUDA, totalBytes: 16e9, usedBytes: 0 },
        ]),
      ],
      [
        'w3',
        makeBudget('w3', [
          { deviceIndex: 0, deviceType: DeviceType.CUDA, totalBytes: 16e9, usedBytes: 0 },
        ]),
      ],
    ]);

    const result = pipeline.place(
      { modelName: 'test', runnerType: 'vllm', requiredMemory: 8e9, tensorParallel: 1 },
      workers,
      budgets,
    );

    expect(result).not.toBeNull();
    expect(result!.workerId).toBe('w3');
  });

  it('rejects stale worker budgets', () => {
    const workers = [
      makeWorker(
        'w1',
        [{ runnerType: 'vllm', supportedDeviceTypes: [DeviceType.CUDA] }],
        [{ deviceIndex: 0, deviceType: DeviceType.CUDA, memoryTotalBytes: 16e9 }],
      ),
    ];
    const staleBudget = makeBudget('w1', [
      { deviceIndex: 0, deviceType: DeviceType.CUDA, totalBytes: 16e9, usedBytes: 0 },
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

describe('PlacementPipeline.eligibleWorkerIds', () => {
  const pipeline = new PlacementPipeline();

  it('returns worker ids matching runner type and hardware, ignoring capacity', () => {
    const workers = [
      makeWorker(
        'w1',
        [{ runnerType: 'vllm', supportedDeviceTypes: [DeviceType.CUDA] }],
        [{ deviceIndex: 0, deviceType: DeviceType.CUDA, memoryTotalBytes: 16e9 }],
      ),
      makeWorker(
        'w2',
        [{ runnerType: 'triton', supportedDeviceTypes: [DeviceType.CUDA] }],
        [{ deviceIndex: 0, deviceType: DeviceType.CUDA, memoryTotalBytes: 16e9 }],
      ),
    ];

    const eligible = pipeline.eligibleWorkerIds(
      { modelName: 'test', runnerType: 'vllm', requiredMemory: 8e9, tensorParallel: 1 },
      workers,
    );

    expect(eligible).toEqual(new Set(['w1']));
  });

  it('excludes unhealthy workers', () => {
    const workers = [
      {
        ...makeWorker(
          'w1',
          [{ runnerType: 'vllm', supportedDeviceTypes: [DeviceType.CUDA] }],
          [{ deviceIndex: 0, deviceType: DeviceType.CUDA, memoryTotalBytes: 16e9 }],
        ),
        status: WorkerStatus.OFFLINE,
      },
    ];

    const eligible = pipeline.eligibleWorkerIds(
      { modelName: 'test', runnerType: 'vllm', requiredMemory: 8e9, tensorParallel: 1 },
      workers,
    );

    expect(eligible.size).toBe(0);
  });

  it('filters by device type when specified', () => {
    const workers = [
      makeWorker(
        'w1',
        [{ runnerType: 'vllm', supportedDeviceTypes: [DeviceType.CUDA] }],
        [{ deviceIndex: 0, deviceType: DeviceType.CUDA, memoryTotalBytes: 16e9 }],
      ),
      makeWorker(
        'w2',
        [{ runnerType: 'vllm', supportedDeviceTypes: [DeviceType.ROCM] }],
        [{ deviceIndex: 0, deviceType: DeviceType.ROCM, memoryTotalBytes: 32e9 }],
      ),
    ];

    const eligible = pipeline.eligibleWorkerIds(
      {
        modelName: 'test',
        runnerType: 'vllm',
        requiredMemory: 8e9,
        deviceType: DeviceType.ROCM,
        tensorParallel: 1,
      },
      workers,
    );

    expect(eligible).toEqual(new Set(['w2']));
  });

  it('returns an empty set when no worker matches', () => {
    const workers = [
      makeWorker(
        'w1',
        [{ runnerType: 'triton', supportedDeviceTypes: [DeviceType.CUDA] }],
        [{ deviceIndex: 0, deviceType: DeviceType.CUDA, memoryTotalBytes: 16e9 }],
      ),
    ];

    const eligible = pipeline.eligibleWorkerIds(
      { modelName: 'test', runnerType: 'vllm', requiredMemory: 8e9, tensorParallel: 1 },
      workers,
    );

    expect(eligible.size).toBe(0);
  });

  it('returns an empty set when there are no workers', () => {
    const eligible = pipeline.eligibleWorkerIds(
      { modelName: 'test', runnerType: 'vllm', requiredMemory: 8e9, tensorParallel: 1 },
      [],
    );

    expect(eligible.size).toBe(0);
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
