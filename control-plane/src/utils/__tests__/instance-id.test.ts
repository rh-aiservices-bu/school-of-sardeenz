// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { assertValidInstanceId } from '../instance-id.js';
import { ControlPlaneError } from '../../errors.js';

describe('assertValidInstanceId (#236)', () => {
  it.each([
    ['mint shape', 'inst-abc123def456'],
    ['legacy charset (dots, underscores, hyphens)', 'a.b_c-d'],
    ['64-character boundary', '0'.repeat(64)],
  ])('accepts an instanceId that %s', (_desc, instanceId) => {
    expect(() => assertValidInstanceId(instanceId)).not.toThrow();
  });

  it.each([
    ['contains a colon (extra redisKey segment)', 'foo:bar'],
    ['contains a glob asterisk', 'foo*bar'],
    ['contains a glob question mark', 'foo?bar'],
    ['contains a glob bracket', 'foo[bar]'],
    ['contains a slash (path segment escape)', 'foo/bar'],
    ['contains whitespace', 'foo bar'],
    ['is empty', ''],
    ['exceeds 64 characters', 'a'.repeat(65)],
  ])('rejects an instanceId that %s', (_desc, instanceId) => {
    let caught: unknown;
    try {
      assertValidInstanceId(instanceId);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ControlPlaneError);
    expect((caught as ControlPlaneError).code).toBe('INVALID_REQUEST');
    expect((caught as ControlPlaneError).message).toContain('^[A-Za-z0-9._-]{1,64}$');
  });
});
