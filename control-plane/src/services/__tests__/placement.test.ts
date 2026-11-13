import { describe, it, expect } from 'vitest';
import {
  WorkerStatus,
  DeviceType,
  ModelType,
  SleepLevel,
  ModelLifecycleState,
} from '@sardeenz/types';

import { PlacementPipeline, MostAvailableCapacityStrategy, coLocationGroup } from '../placement.js';
import type { CoLocationContext } from '../placement.js';
import type { WorkerRecord } from '../worker-pool.js';
import type { WorkerBudget, DeviceBudget } from '../memory-budget.js';
import type { InstanceState } from '../model-lifecycle.js';

function makeWorker(
  workerId: string,
  capabilities: {
    runnerType: string;
    supportedDeviceTypes: DeviceType[];
    maxTensorParallelism?: number;
    kvCacheElasticSharing?: boolean;
  }[],
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
      maxTensorParallelism: c.maxTensorParallelism ?? 1,
      kvCacheElasticSharing: c.kvCacheElasticSharing ?? false,
    })),
    devices,
    lastHeartbeatAt: new Date().toISOString(),
    joinedAt: new Date().toISOString(),
    managementUrl: `http://${workerId}:9100`,
  };
}

function makeBudget(
  workerId: string,
  devices: {
    deviceIndex: number;
    deviceType: DeviceType;
    totalBytes: number;
    usedBytes: number;
    kvCache?: { totalBytes: number; usedBytes: number; preallocBytes: number; freeBytes: number };
  }[],
): WorkerBudget {
  return {
    workerId,
    devices: devices.map((d): DeviceBudget => ({
      deviceIndex: d.deviceIndex,
      deviceType: d.deviceType,
      totalBytes: d.totalBytes,
      usedBytes: d.usedBytes,
      availableBytes: d.totalBytes - d.usedBytes,
      ...(d.kvCache !== undefined ? { kvCache: d.kvCache } : {}),
    })),
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

  it('validates an exact fixed target and rejects an insufficient selected GPU', () => {
    const workers = [
      makeWorker(
        'w1',
        [
          {
            runnerType: 'vllm',
            supportedDeviceTypes: [DeviceType.CUDA],
            maxTensorParallelism: 2,
          },
        ],
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
          { deviceIndex: 1, deviceType: DeviceType.CUDA, totalBytes: 16e9, usedBytes: 15e9 },
        ]),
      ],
    ]);
    const request = {
      modelName: 'test',
      runnerType: 'vllm',
      requiredMemory: 8e9,
      tensorParallel: 1,
    };

    expect(pipeline.placeFixed(request, 'w1', [0], workers, budgets)?.devices).toEqual([
      { deviceIndex: 0, deviceType: DeviceType.CUDA },
    ]);
    expect(pipeline.placeFixed(request, 'w1', [1], workers, budgets)).toBeNull();
  });

  it('rejects fixed targets above runner TP capability and unsupported actual device types', () => {
    const workers = [
      makeWorker(
        'w1',
        [{ runnerType: 'vllm', supportedDeviceTypes: [DeviceType.CUDA] }],
        [
          { deviceIndex: 0, deviceType: DeviceType.CUDA, memoryTotalBytes: 16e9 },
          { deviceIndex: 1, deviceType: DeviceType.ROCM, memoryTotalBytes: 16e9 },
        ],
      ),
    ];
    const budgets = new Map([
      [
        'w1',
        makeBudget('w1', [
          { deviceIndex: 0, deviceType: DeviceType.CUDA, totalBytes: 16e9, usedBytes: 0 },
          { deviceIndex: 1, deviceType: DeviceType.ROCM, totalBytes: 16e9, usedBytes: 0 },
        ]),
      ],
    ]);

    expect(
      pipeline.placeFixed(
        { modelName: 'test', runnerType: 'vllm', requiredMemory: 8e9, tensorParallel: 2 },
        'w1',
        [0, 1],
        workers,
        budgets,
      ),
    ).toBeNull();
    expect(
      pipeline.placeFixed(
        { modelName: 'test', runnerType: 'vllm', requiredMemory: 8e9, tensorParallel: 1 },
        'w1',
        [1],
        workers,
        budgets,
      ),
    ).toBeNull();
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
        [
          {
            runnerType: 'vllm',
            supportedDeviceTypes: [DeviceType.CUDA],
            maxTensorParallelism: 2,
          },
        ],
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

/**
 * #276 — co-location placement policy. Fixtures: one worker 'w1' whose device 0 carries a
 * resident instance; the device's availableBytes already nets the resident's hold, so tests
 * express residency purely through usedBytes + an instance snapshot in the CoLocationContext.
 */
describe('PlacementPipeline co-location policy (#276)', () => {
  const G = 1e9;
  const baseRequest = {
    modelName: 'new-model',
    runnerType: 'vllm',
    requiredMemory: 4 * G,
    tensorParallel: 1,
  };
  const kvPool = { totalBytes: 8 * G, usedBytes: 5 * G, preallocBytes: 0, freeBytes: 3 * G };

  function makeInstance(
    overrides: Partial<InstanceState> & Pick<InstanceState, 'instanceId' | 'modelName'>,
  ): InstanceState {
    return {
      state: ModelLifecycleState.ACTIVE,
      workerId: 'w1',
      runnerHost: null,
      runnerPort: null,
      runnerId: null,
      deviceIndices: [0],
      lastInferenceAt: null,
      stateChangedAt: '2026-01-01T00:00:00Z',
      errorMessage: null,
      ...overrides,
    };
  }

  function makeContext(
    instances: InstanceState[],
    opts: { runnerTypeByModel?: Map<string, string>; holds?: Map<string, Set<string>> } = {},
  ): CoLocationContext {
    return {
      instances,
      runnerTypeByModel: opts.runnerTypeByModel ?? new Map([['resident-model', 'vllm']]),
      holdsByDevice: opts.holds ?? new Map(),
    };
  }

  function colocatedBudget(kvCache?: {
    totalBytes: number;
    usedBytes: number;
    preallocBytes: number;
    freeBytes: number;
  }): WorkerBudget {
    return makeBudget('w1', [
      {
        deviceIndex: 0,
        deviceType: DeviceType.CUDA,
        totalBytes: 16 * G,
        usedBytes: 15 * G,
        ...(kvCache !== undefined ? { kvCache } : {}),
      },
    ]);
  }

  function elasticWorker(): WorkerRecord {
    return makeWorker(
      'w1',
      [
        {
          runnerType: 'vllm',
          supportedDeviceTypes: [DeviceType.CUDA],
          kvCacheElasticSharing: true,
        },
        { runnerType: 'mlserver', supportedDeviceTypes: [DeviceType.CUDA] },
      ],
      [{ deviceIndex: 0, deviceType: DeviceType.CUDA, memoryTotalBytes: 16 * G }],
    );
  }

  function elasticResident(): InstanceState[] {
    return [makeInstance({ instanceId: 'i-res', modelName: 'resident-model' })];
  }

  it('places an opted-in elastic model past naive capacity when the resident is elastic', () => {
    const pipeline = new PlacementPipeline(undefined, { maxPoolHeadroomPercent: 50 });
    const result = pipeline.place(
      { ...baseRequest, allowCoLocation: true },
      [elasticWorker()],
      new Map([['w1', colocatedBudget(kvPool)]]),
      makeContext(elasticResident()),
    );
    expect(result?.devices).toEqual([{ deviceIndex: 0, deviceType: DeviceType.CUDA }]);
    expect(result?.coLocated).toBe(true);
  });

  it('rejects co-location when a resident runner type is non-elastic', () => {
    const pipeline = new PlacementPipeline(undefined, { maxPoolHeadroomPercent: 50 });
    const result = pipeline.place(
      { ...baseRequest, allowCoLocation: true },
      [elasticWorker()],
      new Map([['w1', colocatedBudget(kvPool)]]),
      makeContext([makeInstance({ instanceId: 'i-res', modelName: 'ml-model' })], {
        runnerTypeByModel: new Map([['ml-model', 'mlserver']]),
      }),
    );
    expect(result).toBeNull();
  });

  it('treats an unresolvable co-resident capability as non-elastic (fail-closed)', () => {
    const pipeline = new PlacementPipeline(undefined, { maxPoolHeadroomPercent: 50 });
    // Case 1: the co-resident's ModelRecord was deleted (modelName unresolvable).
    const deletedRecord = pipeline.place(
      { ...baseRequest, allowCoLocation: true },
      [elasticWorker()],
      new Map([['w1', colocatedBudget(kvPool)]]),
      makeContext(elasticResident(), { runnerTypeByModel: new Map() }),
    );
    expect(deletedRecord).toBeNull();

    // Case 2: the worker no longer reports the co-resident's runner type.
    const noWorkerCap = pipeline.place(
      { ...baseRequest, allowCoLocation: true },
      [
        makeWorker(
          'w1',
          [
            {
              runnerType: 'vllm',
              supportedDeviceTypes: [DeviceType.CUDA],
              kvCacheElasticSharing: true,
            },
          ],
          [{ deviceIndex: 0, deviceType: DeviceType.CUDA, memoryTotalBytes: 16 * G }],
        ),
      ],
      new Map([['w1', colocatedBudget(kvPool)]]),
      makeContext(elasticResident(), {
        runnerTypeByModel: new Map([['resident-model', 'triton']]),
      }),
    );
    expect(noWorkerCap).toBeNull();
  });

  it('keeps plain capacity when the request does not opt in', () => {
    const pipeline = new PlacementPipeline(undefined, { maxPoolHeadroomPercent: 50 });
    const result = pipeline.place(
      baseRequest,
      [elasticWorker()],
      new Map([['w1', colocatedBudget(kvPool)]]),
      makeContext(elasticResident()),
    );
    expect(result).toBeNull();
  });

  it('keeps plain capacity when the request runner type is non-elastic', () => {
    const pipeline = new PlacementPipeline(undefined, { maxPoolHeadroomPercent: 50 });
    const result = pipeline.place(
      { ...baseRequest, runnerType: 'mlserver', allowCoLocation: true },
      [elasticWorker()],
      new Map([['w1', colocatedBudget(kvPool)]]),
      makeContext(elasticResident()),
    );
    expect(result).toBeNull();
  });

  it('gives no headroom when the device reports no kvCache pool (absent means absent)', () => {
    const pipeline = new PlacementPipeline(undefined, { maxPoolHeadroomPercent: 50 });
    const result = pipeline.place(
      { ...baseRequest, allowCoLocation: true },
      [elasticWorker()],
      new Map([['w1', colocatedBudget(undefined)]]),
      makeContext(elasticResident()),
    );
    expect(result).toBeNull();
  });

  it('fails closed when a member-state resident has unknown placement (deviceIndices null)', () => {
    // Review round 1 (qual MEDIUM-2): coLocationGroup's spec-pinned predicate makes a
    // null-deviceIndices instance a member of no device, so without this guard the elastic
    // headroom would be granted next to a co-resident whose per-device capability cannot be
    // resolved — a fail-open edge in the OOM guard. The legacy resident blocks headroom on
    // every device of its worker. The model name maps to the elastic runner type so the
    // unresolvable-capability arm can never stand in for the unknown-placement assertion.
    const pipeline = new PlacementPipeline(undefined, { maxPoolHeadroomPercent: 50 });
    const withLegacyResident = pipeline.place(
      { ...baseRequest, allowCoLocation: true },
      [elasticWorker()],
      new Map([['w1', colocatedBudget(kvPool)]]),
      makeContext([
        makeInstance({
          instanceId: 'i-legacy',
          modelName: 'resident-model',
          deviceIndices: null,
        }),
      ]),
    );
    expect(withLegacyResident).toBeNull();

    // Empty deviceIndices is the same unknown-placement class.
    const withEmptyIndices = pipeline.place(
      { ...baseRequest, allowCoLocation: true },
      [elasticWorker()],
      new Map([['w1', colocatedBudget(kvPool)]]),
      makeContext([
        makeInstance({
          instanceId: 'i-legacy',
          modelName: 'resident-model',
          deviceIndices: [],
        }),
      ]),
    );
    expect(withEmptyIndices).toBeNull();

    // A same-placement elastic resident still gets headroom — the guard is about unknown
    // placement, not about residency itself.
    const withElasticResident = pipeline.place(
      { ...baseRequest, allowCoLocation: true },
      [elasticWorker()],
      new Map([['w1', colocatedBudget(kvPool)]]),
      makeContext(elasticResident()),
    );
    expect(withElasticResident?.coLocated).toBe(true);
  });

  it('fails closed for an ERROR zombie with unknown placement that retains a hold', () => {
    // Review round 2 (MEDIUM-2): coLocationGroup counts an ERROR instance that still holds
    // reservation bytes as a device member, but its device-scoped predicate hides a legacy
    // (null deviceIndices) one — exactly the runnerStartAmbiguous class the wake path
    // documents (a non-elastic runner that may still be live on the device). Without the
    // zombie arm of the guard the elastic headroom is granted next to it. Available 1 GiB +
    // kvPool headroom (cap 50% of 8 GiB = 4 GiB) ≥ the 4 GiB request, so the placement would
    // succeed without the guard; the control below (no hold) proves the hold is what trips it.
    const pipeline = new PlacementPipeline(undefined, { maxPoolHeadroomPercent: 50 });
    const zombie = makeInstance({
      instanceId: 'i-zombie',
      modelName: 'resident-model',
      state: ModelLifecycleState.ERROR,
      deviceIndices: null,
    });
    const withZombie = pipeline.place(
      { ...baseRequest, allowCoLocation: true },
      [elasticWorker()],
      new Map([['w1', colocatedBudget(kvPool)]]),
      makeContext([zombie], { holds: new Map([['w1:0', new Set(['i-zombie'])]]) }),
    );
    expect(withZombie).toBeNull();

    // Control: the same ERROR instance without a retained hold is not a member of any
    // device's co-location group and must not block the placement.
    const withoutHold = pipeline.place(
      { ...baseRequest, allowCoLocation: true },
      [elasticWorker()],
      new Map([['w1', colocatedBudget(kvPool)]]),
      makeContext([zombie]),
    );
    expect(withoutHold?.coLocated).toBe(true);
  });

  it('does not inflate headroom past the pool totalBytes when the report claims free > total', () => {
    // The partition is not validated at parse time (telemetry-tolerant). This distinguishes
    // the consumption-time clamp from the cap term alone: cap 200% of an 8 GiB pool is 16 GiB,
    // so an unclamped min(free+prealloc, cap-term) would grant 20 GiB of headroom on a
    // config-construction that bypasses the 0–100 validation. With the clamp, 1 GiB available
    // + 8 GiB headroom = 9 GiB: a 9 GiB+1 request is rejected and exactly 9 GiB passes. The
    // pipeline under test is constructed directly with cap 200 — impossible through loadConfig,
    // which enforces the 0–100 domain at boot.
    const pipeline = new PlacementPipeline(undefined, { maxPoolHeadroomPercent: 200 });
    const malformed = { totalBytes: 8 * G, usedBytes: 0, preallocBytes: 0, freeBytes: 20 * G };
    const above = pipeline.place(
      { ...baseRequest, requiredMemory: 9 * G + 1, allowCoLocation: true },
      [elasticWorker()],
      new Map([['w1', colocatedBudget(malformed)]]),
      makeContext(elasticResident()),
    );
    expect(above).toBeNull();

    const exact = pipeline.place(
      { ...baseRequest, requiredMemory: 9 * G, allowCoLocation: true },
      [elasticWorker()],
      new Map([['w1', colocatedBudget(malformed)]]),
      makeContext(elasticResident()),
    );
    expect(exact?.coLocated).toBe(true);
  });

  it('caps headroom at the configured percent of pool totalBytes', () => {
    // free+prealloc = 6 GiB, cap 50% of 8 GiB = 4 GiB ⇒ headroom 4 GiB; 1 GiB avail + 4 = 5 GiB.
    const pipeline = new PlacementPipeline(undefined, { maxPoolHeadroomPercent: 50 });
    const overPool = {
      totalBytes: 8 * G,
      usedBytes: 2 * G,
      preallocBytes: 3 * G,
      freeBytes: 3 * G,
    };
    const above = pipeline.place(
      { ...baseRequest, requiredMemory: 5 * G + 1, allowCoLocation: true },
      [elasticWorker()],
      new Map([['w1', colocatedBudget(overPool)]]),
      makeContext(elasticResident()),
    );
    expect(above).toBeNull(); // above the capped figure

    const exact = pipeline.place(
      { ...baseRequest, requiredMemory: 5 * G, allowCoLocation: true },
      [elasticWorker()],
      new Map([['w1', colocatedBudget(overPool)]]),
      makeContext(elasticResident()),
    );
    expect(exact?.coLocated).toBe(true); // exactly at the capped figure

    // Cap 0 disables elastic headroom entirely — plain byte-fit only.
    const disabled = new PlacementPipeline(undefined, { maxPoolHeadroomPercent: 0 });
    const result = disabled.place(
      { ...baseRequest, allowCoLocation: true },
      [elasticWorker()],
      new Map([['w1', colocatedBudget(kvPool)]]),
      makeContext(elasticResident()),
    );
    expect(result).toBeNull();
  });

  it('applies the elastic predicate per device for a TP request', () => {
    const pipeline = new PlacementPipeline(undefined, { maxPoolHeadroomPercent: 50 });
    const worker = makeWorker(
      'w1',
      [
        {
          runnerType: 'vllm',
          supportedDeviceTypes: [DeviceType.CUDA],
          maxTensorParallelism: 2,
          kvCacheElasticSharing: true,
        },
      ],
      [
        { deviceIndex: 0, deviceType: DeviceType.CUDA, memoryTotalBytes: 16 * G },
        { deviceIndex: 1, deviceType: DeviceType.CUDA, memoryTotalBytes: 16 * G },
      ],
    );
    const budget = makeBudget('w1', [
      {
        deviceIndex: 0,
        deviceType: DeviceType.CUDA,
        totalBytes: 16 * G,
        usedBytes: 15 * G,
        kvCache: kvPool,
      },
      {
        deviceIndex: 1,
        deviceType: DeviceType.CUDA,
        totalBytes: 16 * G,
        usedBytes: 15 * G, // no pool ⇒ no headroom ⇒ short
      },
    ]);
    const result = pipeline.place(
      { ...baseRequest, tensorParallel: 2, allowCoLocation: true },
      [worker],
      new Map([['w1', budget]]),
      makeContext(elasticResident()),
    );
    expect(result).toBeNull();
  });

  it('placeFixed applies the same elastic rules and still never evicts', () => {
    const pipeline = new PlacementPipeline(undefined, { maxPoolHeadroomPercent: 50 });
    // Elastic resident + opt-in → accepted past capacity.
    const ok = pipeline.placeFixed(
      { ...baseRequest, allowCoLocation: true },
      'w1',
      [0],
      [elasticWorker()],
      new Map([['w1', colocatedBudget(kvPool)]]),
      makeContext(elasticResident()),
    );
    expect(ok?.devices).toEqual([{ deviceIndex: 0, deviceType: DeviceType.CUDA }]);
    expect(ok?.coLocated).toBe(true);

    // Non-elastic resident → null (no eviction attempted).
    const guarded = pipeline.placeFixed(
      { ...baseRequest, allowCoLocation: true },
      'w1',
      [0],
      [elasticWorker()],
      new Map([['w1', colocatedBudget(kvPool)]]),
      makeContext([makeInstance({ instanceId: 'i-res', modelName: 'ml-model' })], {
        runnerTypeByModel: new Map([['ml-model', 'mlserver']]),
      }),
    );
    expect(guarded).toBeNull();
  });

  describe('coLocationGroup membership', () => {
    const heldIds = new Set(['i-zombie']);

    it('includes sleeping members and ERROR members only with a retained hold', () => {
      const instances = [
        makeInstance({ instanceId: 'i-active', modelName: 'm', state: ModelLifecycleState.ACTIVE }),
        makeInstance({
          instanceId: 'i-sleep',
          modelName: 'm',
          state: ModelLifecycleState.SLEEPING,
        }),
        makeInstance({ instanceId: 'i-zombie', modelName: 'm', state: ModelLifecycleState.ERROR }),
        makeInstance({ instanceId: 'i-nohold', modelName: 'm', state: ModelLifecycleState.ERROR }),
      ];
      const group = coLocationGroup('w1', 0, instances, heldIds);
      expect(group.map((s) => s.instanceId).sort()).toEqual(['i-active', 'i-sleep', 'i-zombie']);
    });

    it('excludes PENDING, STOPPING and STOPPED instances', () => {
      const instances = [
        makeInstance({
          instanceId: 'i-pending',
          modelName: 'm',
          state: ModelLifecycleState.PENDING,
        }),
        makeInstance({
          instanceId: 'i-stopping',
          modelName: 'm',
          state: ModelLifecycleState.STOPPING,
        }),
        makeInstance({
          instanceId: 'i-stopped',
          modelName: 'm',
          state: ModelLifecycleState.STOPPED,
        }),
      ];
      expect(coLocationGroup('w1', 0, instances, heldIds)).toEqual([]);
    });

    it('scopes by worker and device', () => {
      const instances = [
        makeInstance({ instanceId: 'i-other-worker', modelName: 'm', workerId: 'w2' }),
        makeInstance({ instanceId: 'i-other-device', modelName: 'm', deviceIndices: [1] }),
      ];
      expect(coLocationGroup('w1', 0, instances, heldIds)).toEqual([]);
    });

    it('without heldInstanceIds, ERROR instances never join', () => {
      const instances = [
        makeInstance({ instanceId: 'i-active', modelName: 'm', state: ModelLifecycleState.ACTIVE }),
        makeInstance({ instanceId: 'i-zombie', modelName: 'm', state: ModelLifecycleState.ERROR }),
      ];
      const group = coLocationGroup('w1', 0, instances);
      expect(group.map((s) => s.instanceId)).toEqual(['i-active']);
    });
  });
});
