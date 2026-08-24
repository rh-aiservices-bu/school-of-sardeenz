/**
 * ModelDeploy runner/device option tests.
 *
 * Following the project convention (see MemoryVisualization.test.tsx,
 * role-visibility.test.tsx), we test the pure helpers that drive the form's
 * option lists and default reconciliation directly, rather than rendering
 * <ModelDeploy> with @testing-library/react (PF/React version conflicts in
 * this worktree). Full rendering coverage is left to the Playwright e2e suite.
 */
import { describe, it, expect } from 'vitest';
import type { ControlPlaneComponents } from '@sardeenz/types';
import { ModelType, DeviceType } from '@sardeenz/types';
import {
  computeRunnerOptions,
  computeDeviceOptions,
  reconcileRunnerType,
  reconcileDeviceType,
} from '../../hooks/useWorkers';

type WorkerRunnerCapability = ControlPlaneComponents['schemas']['WorkerRunnerCapability'];

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

describe('ModelDeploy: Runner Type select', () => {
  it('lists one option per advertised runner type', () => {
    const caps = [
      capability({ runnerType: 'vllm', engineName: 'vLLM' }),
      capability({ runnerType: 'mlserver', engineName: 'MLServer' }),
    ];
    const { options } = computeRunnerOptions(caps);
    expect(options).toHaveLength(2);
  });

  it('the fallback helper text appears only when isFallback', () => {
    expect(computeRunnerOptions([]).isFallback).toBe(true);
    expect(computeRunnerOptions([capability()]).isFallback).toBe(false);
  });

  it('the default selection is corrected when vllm is absent', () => {
    const noVllm = [
      { value: 'mlserver', label: 'MLServer' },
      { value: 'triton', label: 'Triton' },
    ];
    expect(reconcileRunnerType('vllm', noVllm)).toBe('mlserver');

    const withVllm = [
      { value: 'vllm', label: 'vLLM' },
      { value: 'triton', label: 'Triton' },
    ];
    expect(reconcileRunnerType('vllm', withVllm)).toBe('vllm');
  });
});

describe('ModelDeploy: Device Type select', () => {
  it('excludes device types the selected runner does not support', () => {
    const caps = [
      capability({ runnerType: 'mlserver', supportedDeviceTypes: [DeviceType.CPU] }),
      capability({ runnerType: 'vllm', supportedDeviceTypes: [DeviceType.CUDA, DeviceType.ROCM] }),
    ];
    const { options } = computeDeviceOptions(caps, 'mlserver', 'Any');
    expect(options).toEqual([
      { value: '', label: 'Any' },
      { value: 'CPU', label: 'CPU' },
    ]);
  });

  it('a stale deviceType is reset when switching to a runner that cannot serve it', () => {
    // Operator picks CUDA under vllm, then switches to a CPU-only runner. The device
    // options recomputed for the new runner no longer include CUDA, so the previously
    // selected deviceType must be reconciled back to '' (Any) rather than left dangling
    // on a value absent from the new option list.
    const caps = [
      capability({ runnerType: 'vllm', supportedDeviceTypes: [DeviceType.CUDA, DeviceType.ROCM] }),
      capability({ runnerType: 'mlserver', supportedDeviceTypes: [DeviceType.CPU] }),
    ];
    const nextOptions = computeDeviceOptions(caps, 'mlserver', 'Any').options;
    expect(reconcileDeviceType('CUDA', nextOptions)).toBe('');
  });

  it('a still-valid deviceType survives a runner change', () => {
    // Both the old and new runner support CPU, so a CPU selection should be preserved.
    const caps = [
      capability({ runnerType: 'vllm', supportedDeviceTypes: [DeviceType.CUDA, DeviceType.CPU] }),
      capability({ runnerType: 'mlserver', supportedDeviceTypes: [DeviceType.CPU] }),
    ];
    const nextOptions = computeDeviceOptions(caps, 'mlserver', 'Any').options;
    expect(reconcileDeviceType('CPU', nextOptions)).toBe('CPU');
  });
});
