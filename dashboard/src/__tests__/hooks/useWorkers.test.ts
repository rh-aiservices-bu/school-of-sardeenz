import { describe, it, expect } from 'vitest';
import type { ControlPlaneComponents } from '@sardeenz/types';
import { WorkerStatus, ModelType, DeviceType } from '@sardeenz/types';
import {
  collectOnlineCapabilities,
  computeRunnerOptions,
  computeDeviceOptions,
  reconcileRunnerType,
  reconcileDeviceType,
  FALLBACK_RUNNER_OPTIONS,
  FALLBACK_DEVICE_TYPES,
} from '../../hooks/useWorkers';

type WorkerInfo = ControlPlaneComponents['schemas']['WorkerInfo'];
type WorkerRunnerCapability = ControlPlaneComponents['schemas']['WorkerRunnerCapability'];

function worker(overrides: Partial<WorkerInfo> = {}): WorkerInfo {
  return {
    workerId: 'w1',
    status: WorkerStatus.ONLINE,
    devices: [],
    ...overrides,
  };
}

function capability(overrides: Partial<WorkerRunnerCapability> = {}): WorkerRunnerCapability {
  return {
    runnerType: 'vllm',
    engineName: 'vLLM',
    supportedModelTypes: [ModelType.LLM],
    supportedDeviceTypes: [DeviceType.CUDA],
    maxTensorParallelism: 1,
    kvCacheElasticSharing: false,
    ...overrides,
  };
}

describe('collectOnlineCapabilities', () => {
  it('dedupes downstream: two ONLINE workers both advertising vllm yield one runner option', () => {
    const workers = [
      worker({ workerId: 'w1', runnerCapabilities: [capability({ runnerType: 'vllm' })] }),
      worker({ workerId: 'w2', runnerCapabilities: [capability({ runnerType: 'vllm' })] }),
    ];
    const caps = collectOnlineCapabilities(workers);
    expect(computeRunnerOptions(caps).options).toEqual([{ value: 'vllm', label: 'vLLM' }]);
  });

  it('excludes a non-ONLINE worker', () => {
    const workers = [
      worker({
        workerId: 'w1',
        status: WorkerStatus.OFFLINE,
        runnerCapabilities: [capability({ runnerType: 'vllm' })],
      }),
      worker({
        workerId: 'w2',
        status: WorkerStatus.DEGRADED,
        runnerCapabilities: [capability({ runnerType: 'triton' })],
      }),
    ];
    expect(collectOnlineCapabilities(workers)).toEqual([]);
  });

  it('a worker with runnerCapabilities undefined contributes nothing (no throw)', () => {
    const workers = [worker({ workerId: 'w1', runnerCapabilities: undefined })];
    expect(() => collectOnlineCapabilities(workers)).not.toThrow();
    expect(collectOnlineCapabilities(workers)).toEqual([]);
  });

  it('returns [] for undefined workers arg', () => {
    expect(collectOnlineCapabilities(undefined)).toEqual([]);
  });
});

describe('computeRunnerOptions', () => {
  it('sorts alphabetically by label and is not a fallback', () => {
    const caps = [
      capability({ runnerType: 'vllm', engineName: 'vLLM' }),
      capability({ runnerType: 'mlserver', engineName: 'MLServer' }),
    ];
    const result = computeRunnerOptions(caps);
    expect(result.isFallback).toBe(false);
    expect(result.options).toEqual([
      { value: 'mlserver', label: 'MLServer' },
      { value: 'vllm', label: 'vLLM' },
    ]);
  });

  it('labels from engineName', () => {
    const result = computeRunnerOptions([capability({ runnerType: 'vllm', engineName: 'vLLM' })]);
    expect(result.options).toEqual([{ value: 'vllm', label: 'vLLM' }]);
  });

  it('returns the fallback list when caps is empty', () => {
    const result = computeRunnerOptions([]);
    expect(result.options).toBe(FALLBACK_RUNNER_OPTIONS);
    expect(result.isFallback).toBe(true);
  });

  it('dedupes same runnerType, first engineName wins', () => {
    const caps = [
      capability({ runnerType: 'vllm', engineName: 'vLLM-first' }),
      capability({ runnerType: 'vllm', engineName: 'vLLM-second' }),
    ];
    const result = computeRunnerOptions(caps);
    expect(result.options).toEqual([{ value: 'vllm', label: 'vLLM-first' }]);
  });
});

describe('computeDeviceOptions', () => {
  it('unions supportedDeviceTypes across caps matching the runnerType, Any head first, sorted', () => {
    const caps = [
      capability({ runnerType: 'vllm', supportedDeviceTypes: [DeviceType.CUDA] }),
      capability({ runnerType: 'vllm', supportedDeviceTypes: [DeviceType.ROCM, DeviceType.CUDA] }),
    ];
    const result = computeDeviceOptions(caps, 'vllm', 'Any');
    expect(result.isFallback).toBe(false);
    expect(result.options).toEqual([
      { value: '', label: 'Any' },
      { value: 'CUDA', label: 'CUDA' },
      { value: 'ROCM', label: 'ROCM' },
    ]);
  });

  it('ignores caps for a different runnerType (CPU-only mlserver does not leak CUDA into vllm)', () => {
    const caps = [
      capability({ runnerType: 'mlserver', supportedDeviceTypes: [DeviceType.CPU] }),
      capability({ runnerType: 'vllm', supportedDeviceTypes: [DeviceType.CUDA] }),
    ];
    const result = computeDeviceOptions(caps, 'mlserver', 'Any');
    expect(result.options).toEqual([
      { value: '', label: 'Any' },
      { value: 'CPU', label: 'CPU' },
    ]);
  });

  it('falls back to [Any, CUDA, ROCM, CPU] when no caps match', () => {
    const result = computeDeviceOptions([], 'vllm', 'Any');
    expect(result.isFallback).toBe(true);
    expect(result.options).toEqual([
      { value: '', label: 'Any' },
      ...FALLBACK_DEVICE_TYPES.map((v) => ({ value: v, label: v })),
    ]);
  });
});

describe('reconcileRunnerType', () => {
  it('returns current unchanged when present in options', () => {
    const options = [
      { value: 'vllm', label: 'vLLM' },
      { value: 'mlserver', label: 'MLServer' },
    ];
    expect(reconcileRunnerType('vllm', options)).toBe('vllm');
  });

  it('returns the first option value when current is absent', () => {
    const options = [
      { value: 'mlserver', label: 'MLServer' },
      { value: 'triton', label: 'Triton' },
    ];
    expect(reconcileRunnerType('vllm', options)).toBe('mlserver');
  });

  it('returns current unchanged when options is empty', () => {
    expect(reconcileRunnerType('vllm', [])).toBe('vllm');
  });
});

describe('reconcileDeviceType', () => {
  it('returns current unchanged when present in options', () => {
    const options = [
      { value: '', label: 'Any' },
      { value: 'CUDA', label: 'CUDA' },
    ];
    expect(reconcileDeviceType('CUDA', options)).toBe('CUDA');
  });

  it('resets to "" when current is absent from the new options (stale device on runner change)', () => {
    const options = [
      { value: '', label: 'Any' },
      { value: 'CPU', label: 'CPU' },
    ];
    expect(reconcileDeviceType('CUDA', options)).toBe('');
  });

  it('resets to "" (not the first option) even when options is empty', () => {
    expect(reconcileDeviceType('CUDA', [])).toBe('');
  });

  it('leaves "" (Any) unchanged when still present', () => {
    const options = [
      { value: '', label: 'Any' },
      { value: 'CPU', label: 'CPU' },
    ];
    expect(reconcileDeviceType('', options)).toBe('');
  });
});
