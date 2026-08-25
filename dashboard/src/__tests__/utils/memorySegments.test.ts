import { describe, it, expect } from 'vitest';
import {
  colorTokenForModel,
  colorHexForModel,
  MODEL_PALETTE,
  MODEL_PALETTE_HEX,
} from '../../utils/memorySegments';

describe('colorTokenForModel — stability', () => {
  it('is stable for the same modelName across repeated calls', () => {
    expect(colorTokenForModel('llama-3-8b')).toBe(colorTokenForModel('llama-3-8b'));
  });

  it('two replicas of one model resolve to the same token', () => {
    expect(colorTokenForModel('mistral-7b')).toBe(colorTokenForModel('mistral-7b'));
  });

  it('different names generally differ', () => {
    expect(colorTokenForModel('model-a')).not.toBe(colorTokenForModel('model-b'));
  });

  it('always returns a value from MODEL_PALETTE', () => {
    expect(MODEL_PALETTE).toContain(colorTokenForModel('anything'));
  });
});

describe('colorHexForModel — nivo-compatible concrete colors', () => {
  it('is stable for the same modelName across repeated calls', () => {
    expect(colorHexForModel('llama-3-8b')).toBe(colorHexForModel('llama-3-8b'));
  });

  it('always returns a value from MODEL_PALETTE_HEX', () => {
    expect(MODEL_PALETTE_HEX).toContain(colorHexForModel('anything'));
  });

  it('a model maps to the same palette index whether rendered as CSS var or hex', () => {
    // Both palettes are the same length and use the same hash, so the index a model name
    // resolves to is identical across the two — verified indirectly by checking both
    // functions are deterministic per name (exact index parity is an implementation detail).
    const tokenIndex = MODEL_PALETTE.indexOf(colorTokenForModel('shared-model'));
    const hexIndex = MODEL_PALETTE_HEX.indexOf(colorHexForModel('shared-model'));
    expect(tokenIndex).toBe(hexIndex);
  });

  it('every hex value is a valid #RRGGBB literal (nivo requires a concrete color)', () => {
    for (const hex of MODEL_PALETTE_HEX) {
      expect(hex).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });
});
