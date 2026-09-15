import { describe, it, expect } from 'vitest';
import { isContainedIn } from '../path-containment.js';

describe('isContainedIn', () => {
  it('accepts a direct child of the root', () => {
    expect(isContainedIn('/weights/llama', '/weights')).toBe(true);
  });

  it('rejects the root itself', () => {
    expect(isContainedIn('/weights', '/weights')).toBe(false);
  });

  it('rejects a .. traversal that escapes the root', () => {
    expect(isContainedIn('/weights/../etc/passwd', '/weights')).toBe(false);
  });

  it('rejects a relative path', () => {
    expect(isContainedIn('weights/llama', '/weights')).toBe(false);
  });

  it('rejects a sibling directory that merely shares the root as a string prefix', () => {
    expect(isContainedIn('/weights-evil/llama', '/weights')).toBe(false);
  });

  it('rejects the root with a trailing separator (still equals the root, not a child)', () => {
    expect(isContainedIn('/weights/', '/weights')).toBe(false);
  });
});
