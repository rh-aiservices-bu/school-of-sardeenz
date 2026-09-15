import { describe, it, expect } from 'vitest';
import { ModelLifecycleState } from '@sardeenz/types';
import type { ModelInfo } from '../../../api/client';

const model = (modelName: string, state: ModelLifecycleState): ModelInfo => ({
  modelName,
  state,
  runnerType: 'vllm',
  instanceCount: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
});

// Mirrors InferenceWorkspace's `deployableModels` filter exactly.
function deployableModels(models: ModelInfo[]): ModelInfo[] {
  return models.filter(
    (m) => m.state === ModelLifecycleState.ACTIVE || m.state === ModelLifecycleState.SLEEPING,
  );
}

describe('playground sidebar model filter', () => {
  it('includes ACTIVE and SLEEPING models', () => {
    const models = [
      model('active-model', ModelLifecycleState.ACTIVE),
      model('sleeping-model', ModelLifecycleState.SLEEPING),
    ];
    expect(deployableModels(models).map((m) => m.modelName)).toEqual([
      'active-model',
      'sleeping-model',
    ]);
  });

  it('excludes PENDING, STARTING, STOPPING, STOPPED, DRAINING, and ERROR models', () => {
    const models = [
      model('pending-model', ModelLifecycleState.PENDING),
      model('starting-model', ModelLifecycleState.STARTING),
      model('stopping-model', ModelLifecycleState.STOPPING),
      model('stopped-model', ModelLifecycleState.STOPPED),
      model('draining-model', ModelLifecycleState.DRAINING),
      model('error-model', ModelLifecycleState.ERROR),
    ];
    expect(deployableModels(models)).toEqual([]);
  });

  it('returns an empty list for an empty input', () => {
    expect(deployableModels([])).toEqual([]);
  });
});
