// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { Protocol } from '@sardeenz/types';
import {
  assertModelNameRoutableForProtocol,
  assertValidModelName,
} from '../model-name.js';
import { ControlPlaneError } from '../../errors.js';

describe('assertModelNameRoutableForProtocol', () => {
  it('throws INVALID_REQUEST for an oip model name containing a slash', () => {
    expect(() => assertModelNameRoutableForProtocol('org/model', Protocol.oip)).toThrow(
      ControlPlaneError,
    );
    expect(() => assertModelNameRoutableForProtocol('org/model', Protocol.oip)).toThrow(
      /single path segment|unroutable/,
    );
    let caught: unknown;
    try {
      assertModelNameRoutableForProtocol('org/model', Protocol.oip);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ControlPlaneError);
    expect((caught as ControlPlaneError).code).toBe('INVALID_REQUEST');
  });

  it('does not throw for an openai model name containing a slash', () => {
    expect(() => assertModelNameRoutableForProtocol('org/model', Protocol.openai)).not.toThrow();
  });

  it('does not throw for an oip model name without a slash', () => {
    expect(() => assertModelNameRoutableForProtocol('sentiment-hf', Protocol.oip)).not.toThrow();
  });

  it('assertValidModelName still accepts a slashed name (guards against accidental tightening)', () => {
    expect(() => assertValidModelName('meta-llama/Llama-3.1-8B-Instruct')).not.toThrow();
  });
});
