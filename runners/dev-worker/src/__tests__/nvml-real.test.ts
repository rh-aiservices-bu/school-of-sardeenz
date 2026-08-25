import { describe, it, expect } from 'vitest';
import { createNvmlReader } from '../nvml.js';

// Deliberately does NOT mock '@rh-ai-bu/ts-nvml' (unlike nvml.test.ts) — this exercises the real
// package against this environment, which has no GPU and no libnvidia-ml.so.1. The point of
// createNvmlReader() is that this must degrade to null, never throw and never crash the worker.
describe('createNvmlReader (real @rh-ai-bu/ts-nvml, no GPU in this environment)', () => {
  it('resolves to null instead of throwing when NVML cannot be initialized', async () => {
    await expect(createNvmlReader()).resolves.toBeNull();
  });
});
