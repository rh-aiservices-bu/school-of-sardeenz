/**
 * ModelDeploy tests: the pure helpers that drive the form's option lists and default
 * reconciliation, plus rendered coverage of the weights opt-in switch (#336).
 *
 * Following the project convention (see MemoryVisualization.test.tsx, role-visibility.test.tsx),
 * most cases test the helpers directly. PatternFly renders under Vitest since #176 (see
 * src/__tests__/render-probes.test.tsx); multi-step form flows still stay in e2e.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { ControlPlaneComponents } from '@sardeenz/types';
import { CatalogItemState, DeviceType, ModelLifecycleState, ModelType } from '@sardeenz/types';
import {
  computeRunnerOptions,
  computeDeviceOptions,
  reconcileRunnerType,
  reconcileDeviceType,
} from '../../hooks/useWorkers';
// Real i18next instance: the page and its labels resolve through it.
import '../../i18n';
import { ModelDeploy } from '../../pages/Models/ModelDeploy';
import { useCatalog } from '../../hooks/useCatalog';
import { useDeployModel, useModel, useUpdateModel } from '../../hooks/useModels';
import { useRunnerTypes, useWorkerCapabilities } from '../../hooks/useWorkers';

// The page's data hooks are mocked per case; the pure helpers above stay real (importOriginal).
vi.mock('../../hooks/useModels', () => ({
  useDeployModel: vi.fn(),
  useUpdateModel: vi.fn(),
  useModel: vi.fn(),
}));
vi.mock('../../hooks/useCatalog', () => ({ useCatalog: vi.fn() }));
vi.mock('../../hooks/useWeights', () => ({
  useWeights: vi.fn(() => ({ data: undefined, isLoading: false, isError: false, error: null })),
}));
vi.mock('../../hooks/useWorkers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../hooks/useWorkers')>();
  return { ...actual, useRunnerTypes: vi.fn(), useWorkerCapabilities: vi.fn() };
});

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

// --- Rendered form: the weights opt-in switch (#336) ---------------------------------------------

const CATALOG_MODULE = {
  entry: { runnerType: 'vllm', sifName: 'vllm-0.21' },
  status: { state: CatalogItemState.IMPORTED },
};

const STORED_MODEL = {
  modelName: 'm1',
  displayName: 'Model One',
  state: ModelLifecycleState.STOPPED,
  runnerType: 'vllm',
  modelPath: '/weights/m1',
  requiredMemory: 8 * 1024 ** 3,
  deviceType: undefined,
  tensorParallel: 1,
  engineConfig: undefined,
  engineArgs: [],
  runtimeModule: 'vllm-0.21',
  servedModelName: undefined,
  pinned: false,
  allowCoLocation: false,
  allowUnsafeWeights: true,
  instances: [],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

function stubHooks(options: { deployMutate?: ReturnType<typeof vi.fn> } = {}) {
  vi.mocked(useDeployModel).mockReturnValue({
    mutate: options.deployMutate ?? vi.fn(),
    isError: false,
    error: null,
    isPending: false,
  } as unknown as ReturnType<typeof useDeployModel>);
  vi.mocked(useUpdateModel).mockReturnValue({
    mutate: vi.fn(),
    isError: false,
    error: null,
    isPending: false,
  } as unknown as ReturnType<typeof useUpdateModel>);
  vi.mocked(useModel).mockReturnValue({
    data: STORED_MODEL,
    isLoading: false,
    error: null,
  } as unknown as ReturnType<typeof useModel>);
  vi.mocked(useCatalog).mockReturnValue({
    data: { runners: [CATALOG_MODULE] },
  } as unknown as ReturnType<typeof useCatalog>);
  vi.mocked(useRunnerTypes).mockReturnValue({
    options: [{ value: 'vllm', label: 'vLLM' }],
    isFallback: false,
  });
  vi.mocked(useWorkerCapabilities).mockReturnValue({
    capabilities: [],
  } as unknown as ReturnType<typeof useWorkerCapabilities>);
}

// Exact labels: /model name/i also matches the "Served Model Name" field.
function fillRequiredDeployFields() {
  fireEvent.change(screen.getByLabelText(/^Model Name/), { target: { value: 'm1' } });
  fireEvent.change(screen.getByLabelText(/^Model Path/), { target: { value: '/weights/m1' } });
  fireEvent.change(screen.getByLabelText(/^Required Memory/), { target: { value: '8' } });
  fireEvent.change(screen.getByLabelText(/^Runtime Module/), { target: { value: 'vllm-0.21' } });
}

function renderDeploy(entry = '/models/deploy') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/models/deploy" element={<ModelDeploy />} />
        <Route path="/models/:modelName/edit" element={<ModelDeploy edit />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ModelDeploy: allowUnsafeWeights switch (#336)', () => {
  it('renders the switch off by default with the warning hint', () => {
    stubHooks();
    renderDeploy();

    const toggle = screen.getByRole('switch', { name: /allow unsafe/i });
    expect(toggle).not.toBeChecked();
    expect(screen.getByText(/can execute arbitrary code on the worker/i)).toBeInTheDocument();
  });

  it('submits allowUnsafeWeights: true when toggled', () => {
    const deployMutate = vi.fn();
    stubHooks({ deployMutate });
    renderDeploy();

    fillRequiredDeployFields();
    fireEvent.click(screen.getByRole('switch', { name: /allow unsafe/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Deploy' }));

    expect(deployMutate).toHaveBeenCalledTimes(1);
    const body = deployMutate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body.allowUnsafeWeights).toBe(true);
  });

  it('submits allowUnsafeWeights: false when untouched', () => {
    const deployMutate = vi.fn();
    stubHooks({ deployMutate });
    renderDeploy();

    fillRequiredDeployFields();
    fireEvent.click(screen.getByRole('button', { name: 'Deploy' }));

    expect(deployMutate).toHaveBeenCalledTimes(1);
    const body = deployMutate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body.allowUnsafeWeights).toBe(false);
  });

  it('hydrates the switch from the stored model in the edit form', () => {
    stubHooks();
    renderDeploy('/models/m1/edit');

    expect(screen.getByRole('switch', { name: /allow unsafe/i })).toBeChecked();
  });
});
