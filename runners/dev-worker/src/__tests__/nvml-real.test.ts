import { existsSync } from 'node:fs';
import { describe, it, expect, afterAll } from 'vitest';
import { createNvmlReader } from '../nvml.js';

// Deliberately does NOT mock '@rh-ai-bu/ts-nvml' (unlike nvml.test.ts) — this exercises the real
// package against whatever environment vitest runs in, which is why it branches:
//   - no GPU / no driver (CI, CPU dev boxes): Nvml.init() fails and createNvmlReader() must
//     degrade to null, never throw and never crash the worker;
//   - GPU present (local GPU dev boxes): init succeeds, and the real reader must actually read
//     devices end-to-end before being torn down.
//
// The presence check is done at collection time against the kernel char device (not via NVML —
// calling Nvml.init() here would claim the driver before the test body runs).
const gpuPresent = existsSync('/dev/nvidiactl');
let reader: Awaited<ReturnType<typeof createNvmlReader>>;

describe('createNvmlReader (real @rh-ai-bu/ts-nvml)', () => {
  afterAll(() => {
    reader?.shutdown();
  });

  it('resolves to null instead of throwing when NVML cannot be initialized', {
    skip: gpuPresent,
  }, async () => {
    reader = await createNvmlReader();
    expect(reader).toBeNull();
  });

  it('resolves to a working reader that reads real devices', { skip: !gpuPresent }, async () => {
    reader = await createNvmlReader();
    expect(reader).not.toBeNull();
    const sample = reader!.readSample();
    expect(sample).not.toBeNull();
    expect(sample!.devices.length).toBeGreaterThan(0);
    expect(sample!.devices[0].totalBytes).toBeGreaterThan(0);
  });
});
