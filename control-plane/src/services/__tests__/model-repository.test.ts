import { describe, expect, it, vi } from 'vitest';

import type { DatabasePool } from '../../clients/database.js';
import { ModelRepository } from '../model-repository.js';

describe('ModelRepository.update', () => {
  it('replaces mutable fields and clears omitted optional values', async () => {
    const row = {
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
      created_at: new Date('2026-01-01T00:00:00Z'),
      updated_at: new Date('2026-01-02T00:00:00Z'),
    };
    const query = vi.fn().mockResolvedValue({ rows: [row], rowCount: 1 });
    const repository = new ModelRepository({ query } as unknown as DatabasePool);

    const updated = await repository.update('stable-name', {
      runnerType: 'mlserver',
      modelPath: '/weights/new',
      requiredMemory: 4096,
      tensorParallel: 1,
      pinned: false,
      allowCoLocation: false,
    });

    expect(updated).toMatchObject({
      name: 'stable-name',
      runnerType: 'mlserver',
      modelPath: '/weights/new',
      requiredMemory: 4096,
    });
    // The fixture carries allow_co_location: null — the nullable column maps to false (#276).
    expect(updated!.allowCoLocation).toBe(false);
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
    ]);
  });
});

describe('ModelRepository.create', () => {
  it('inserts 13 params with the allow_co_location default (#276)', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: 'model-2' }], rowCount: 1 });
    const repository = new ModelRepository({ query } as unknown as DatabasePool);

    await repository.create({
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
    ]);
  });
});
