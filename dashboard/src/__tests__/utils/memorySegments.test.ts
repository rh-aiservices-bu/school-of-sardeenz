import { describe, it, expect } from 'vitest';
import {
  colorTokenForModel,
  colorHexForModel,
  MODEL_PALETTE,
  MODEL_PALETTE_HEX,
  assignModelColors,
  hexForColorIndex,
  tokenForColorIndex,
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

describe('assignModelColors — collision-free within a set', () => {
  it('gives every model in a set of up to palette-size names a distinct color', () => {
    const names = Array.from({ length: MODEL_PALETTE_HEX.length }, (_, i) => `model-${i}`);
    const assignment = assignModelColors(names);
    expect(assignment.size).toBe(names.length);
    expect(new Set(assignment.values()).size).toBe(names.length);
  });

  it('separates names that collide under the plain hash', () => {
    const names = Array.from({ length: 40 }, (_, i) => `m${i}`);
    const byHash = new Map<string, string[]>();
    for (const n of names) {
      const hex = colorHexForModel(n);
      byHash.set(hex, [...(byHash.get(hex) ?? []), n]);
    }
    const colliding = Array.from(byHash.values()).find((group) => group.length >= 2);
    expect(colliding).toBeDefined();
    const assignment = assignModelColors(colliding!);
    expect(assignment.get(colliding![0])).not.toBe(assignment.get(colliding![1]));
  });

  it('keeps a model on its hash slot when nothing collides', () => {
    const assignment = assignModelColors(['solo-model']);
    expect(hexForColorIndex(assignment.get('solo-model')!)).toBe(colorHexForModel('solo-model'));
  });

  it('is independent of input order and ignores duplicates', () => {
    const a = assignModelColors(['x', 'y', 'z', 'y']);
    const b = assignModelColors(['z', 'y', 'x']);
    expect(Array.from(a.entries()).sort()).toEqual(Array.from(b.entries()).sort());
    expect(a.size).toBe(3);
  });

  it('spreads repeats evenly once every slot is taken', () => {
    const names = Array.from({ length: MODEL_PALETTE_HEX.length * 2 }, (_, i) => `n${i}`);
    const uses = new Array<number>(MODEL_PALETTE_HEX.length).fill(0);
    for (const slot of assignModelColors(names).values()) uses[slot] += 1;
    expect(Math.max(...uses)).toBe(2);
    expect(Math.min(...uses)).toBe(2);
  });

  it('token and hex palettes stay the same length', () => {
    expect(MODEL_PALETTE.length).toBe(MODEL_PALETTE_HEX.length);
    expect(tokenForColorIndex(3)).toBe(MODEL_PALETTE[3]);
  });
});
