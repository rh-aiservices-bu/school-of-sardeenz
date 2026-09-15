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
    });

    expect(updated).toMatchObject({
      name: 'stable-name',
      runnerType: 'mlserver',
      modelPath: '/weights/new',
      requiredMemory: 4096,
    });
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
    ]);
  });
});
