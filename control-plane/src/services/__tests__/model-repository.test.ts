import { describe, expect, it, vi } from 'vitest';

import type { DatabasePool } from '../../clients/database.js';
import { ModelRepository } from '../model-repository.js';

// A complete models row as RETURNING * produces it. allow_co_location stays nullable (008),
// allow_unsafe_weights is NOT NULL (009), so it is always a real boolean (#336).
const baseRow = {
  id: 'model-1',
  name: 'stable-name',
  runner_type: 'mlserver',
  model_path: '/weights/new',
  required_memory: '4096',
  device_type: null,
  tensor_parallel: 1,
  engine_config: null,
  engine_args: null,
  runtime_module: null,
  served_model_name: null,
  display_name: null,
  pinned: false,
  allow_co_location: null,
  allow_unsafe_weights: false,
  created_at: new Date('2026-01-01T00:00:00Z'),
  updated_at: new Date('2026-01-02T00:00:00Z'),
};

describe('ModelRepository.update', () => {
  it('replaces mutable fields and clears omitted optional values', async () => {
    const row = { ...baseRow, allow_unsafe_weights: true };
    const query = vi.fn().mockResolvedValue({ rows: [row], rowCount: 1 });
    const repository = new ModelRepository({ query } as unknown as DatabasePool);

    const updated = await repository.update('stable-name', {
      runnerType: 'mlserver',
      modelPath: '/weights/new',
      requiredMemory: 4096,
      tensorParallel: 1,
      pinned: false,
      allowCoLocation: false,
      allowUnsafeWeights: true,
    });

    expect(updated).toMatchObject({
      name: 'stable-name',
      runnerType: 'mlserver',
      modelPath: '/weights/new',
      requiredMemory: 4096,
    });
    // The fixture carries allow_co_location: null — the nullable column maps to false (#276).
    expect(updated!.allowCoLocation).toBe(false);
    expect(updated!.allowUnsafeWeights).toBe(true);
    expect(query.mock.calls[0]?.[1]).toEqual([
      'stable-name',
      'mlserver',
      '/weights/new',
      4096,
      null,
      1,
      null,
      null,
      false,
      null,
      null,
      null,
      false,
      true,
    ]);
  });

  it('writes allowUnsafeWeights: false when the operator clears the opt-in (#336)', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [baseRow], rowCount: 1 });
    const repository = new ModelRepository({ query } as unknown as DatabasePool);

    const updated = await repository.update('stable-name', {
      runnerType: 'mlserver',
      modelPath: '/weights/new',
      requiredMemory: 4096,
      tensorParallel: 1,
      pinned: false,
      allowCoLocation: false,
      allowUnsafeWeights: false,
    });

    expect(updated!.allowUnsafeWeights).toBe(false);
    const values = query.mock.calls[0]?.[1] as unknown[];
    expect(values[13]).toBe(false);
  });
});

describe('ModelRepository.create', () => {
  it('inserts 14 params with the allow_co_location and allow_unsafe_weights defaults (#276, #336)', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [baseRow], rowCount: 1 });
    const repository = new ModelRepository({ query } as unknown as DatabasePool);

    const created = await repository.create({
      name: 'new-model',
      runnerType: 'vllm',
      modelPath: '/weights/new-model',
      pinned: true,
    });

    expect(query.mock.calls[0]?.[1]).toEqual([
      'new-model', // $1 name
      'vllm', // $2 runner_type
      '/weights/new-model', // $3 model_path
      null, // $4 required_memory
      null, // $5 device_type
      1, // $6 tensor_parallel
      null, // $7 engine_config
      null, // $8 runtime_module
      true, // $9 pinned
      null, // $10 engine_args
      null, // $11 served_model_name
      null, // $12 display_name
      false, // $13 allow_co_location — omitted → column default false
      false, // $14 allow_unsafe_weights — omitted → column default false
    ]);
    expect(created.allowUnsafeWeights).toBe(false);
  });

  it('round-trips allowUnsafeWeights: true (#336)', async () => {
    const query = vi
      .fn()
      .mockResolvedValue({ rows: [{ ...baseRow, allow_unsafe_weights: true }], rowCount: 1 });
    const repository = new ModelRepository({ query } as unknown as DatabasePool);

    const created = await repository.create({
      name: 'pickle-model',
      runnerType: 'mlserver',
      modelPath: '/weights/pickle-model',
      allowUnsafeWeights: true,
    });

    const values = query.mock.calls[0]?.[1] as unknown[];
    expect(values[13]).toBe(true);
    expect(created.allowUnsafeWeights).toBe(true);
  });
});
