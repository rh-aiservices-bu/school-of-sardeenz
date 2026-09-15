import { describe, expect, it } from 'vitest';
import {
  DeviceType,
  ModelLifecycleState,
  WorkerStatus,
  type ControlPlaneComponents,
} from '@sardeenz/types';
import {
  classifyMoveProgress,
  compatibleMoveDevices,
  isEligibleMoveTargetWorker,
  MOVE_REPLACEMENT_OBSERVATION_TIMEOUT_MS,
} from '../../utils/move';

type ModelDetail = ControlPlaneComponents['schemas']['ModelDetail'];
type WorkerInfo = ControlPlaneComponents['schemas']['WorkerInfo'];
type DeviceInfo = WorkerInfo['devices'][number];

const source = { instanceId: 'old', state: ModelLifecycleState.ACTIVE, createdAt: '' };
const replacement = { instanceId: 'new', state: ModelLifecycleState.STARTING, createdAt: '' };

const model = {
  runnerType: 'vllm',
  tensorParallel: 1,
  requiredMemory: 8_000,
  deviceType: DeviceType.CUDA,
} as ModelDetail;

function device(
  deviceIndex: number,
  deviceType: DeviceType,
  memoryAvailableBytes: number,
): DeviceInfo {
  return {
    deviceIndex,
    deviceType,
    memoryTotalBytes: 16_000,
    memoryUsedBytes: 16_000 - memoryAvailableBytes,
    memoryAvailableBytes,
  };
}

function worker(overrides: Partial<WorkerInfo> = {}): WorkerInfo {
  return {
    workerId: 'worker-2',
    status: WorkerStatus.ONLINE,
    devices: [device(0, DeviceType.CUDA, 16_000)],
    runnerCapabilities: [
      {
        runnerType: 'vllm',
        supportedDeviceTypes: [DeviceType.CUDA],
        maxTensorParallelism: 2,
      },
    ],
    ...overrides,
  } as WorkerInfo;
}

describe('classifyMoveProgress', () => {
  it('keeps a just-accepted replacement pending while stale detail omits it', () => {
    expect(classifyMoveProgress([source], 'old', 'new')).toBe('deploying');
  });

  it('only treats a replacement disappearance as failure after it was observed', () => {
    expect(classifyMoveProgress([source], 'old', 'new', true)).toBe('failed-before-cutover');
  });

  it('treats replacement ERROR and STOPPED as positive pre-cutover failure evidence', () => {
    expect(
      classifyMoveProgress(
        [{ ...replacement, state: ModelLifecycleState.ERROR }, source],
        'old',
        'new',
      ),
    ).toBe('failed-before-cutover');
    expect(
      classifyMoveProgress(
        [{ ...replacement, state: ModelLifecycleState.STOPPED }, source],
        'old',
        'new',
      ),
    ).toBe('failed-before-cutover');
  });

  it('eventually reports a missing pre-cutover replacement as failed instead of deploying forever', () => {
    const acceptedAt = 1_000;
    expect(
      classifyMoveProgress(
        [source],
        'old',
        'new',
        false,
        acceptedAt,
        acceptedAt + MOVE_REPLACEMENT_OBSERVATION_TIMEOUT_MS,
      ),
    ).toBe('failed-before-cutover');
  });
});

describe('move target eligibility', () => {
  it('filters devices with insufficient per-device VRAM or incompatible hardware', () => {
    const target = worker({
      devices: [
        device(0, DeviceType.CUDA, 7_999),
        device(1, DeviceType.ROCM, 16_000),
        device(2, DeviceType.CUDA, 8_000),
      ],
    });

    expect(compatibleMoveDevices(target, model).map((device) => device.deviceIndex)).toEqual([2]);
  });

  it('rejects offline workers and workers without the model runner capability', () => {
    expect(compatibleMoveDevices(worker({ status: WorkerStatus.OFFLINE }), model)).toHaveLength(0);
    expect(compatibleMoveDevices(worker({ runnerCapabilities: [] }), model)).toHaveLength(0);
  });

  it('keeps the source worker eligible only when a distinct device placement fits', () => {
    const source = { workerId: 'worker-1', deviceIndices: [0] };
    expect(isEligibleMoveTargetWorker(worker({ workerId: 'worker-1' }), model, source)).toBe(false);
    expect(
      isEligibleMoveTargetWorker(
        worker({
          workerId: 'worker-1',
          devices: [device(0, DeviceType.CUDA, 16_000), device(1, DeviceType.CUDA, 16_000)],
        }),
        model,
        source,
      ),
    ).toBe(true);
  });
});
