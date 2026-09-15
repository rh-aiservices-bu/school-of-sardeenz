import { describe, expect, it } from 'vitest';
import { InferenceConcurrencyLimiter } from '../inference-concurrency-limiter.js';

describe('InferenceConcurrencyLimiter', () => {
  it('enforces the exact cap and permits a replacement after release', () => {
    const limiter = new InferenceConcurrencyLimiter(2);
    const first = limiter.tryAcquire('alice');
    const second = limiter.tryAcquire('alice');

    expect(first).toBeTypeOf('function');
    expect(second).toBeTypeOf('function');
    expect(limiter.tryAcquire('alice')).toBeNull();

    first!();
    expect(limiter.tryAcquire('alice')).toBeTypeOf('function');
  });

  it('keeps users independent', () => {
    const limiter = new InferenceConcurrencyLimiter(1);
    expect(limiter.tryAcquire('alice')).toBeTypeOf('function');
    expect(limiter.tryAcquire('bob')).toBeTypeOf('function');
    expect(limiter.tryAcquire('alice')).toBeNull();
    expect(limiter.tryAcquire('bob')).toBeNull();
  });

  it('makes release idempotent without under-releasing another request', () => {
    const limiter = new InferenceConcurrencyLimiter(2);
    const first = limiter.tryAcquire('alice')!;
    const second = limiter.tryAcquire('alice')!;

    first();
    first();
    expect(limiter.tryAcquire('alice')).toBeTypeOf('function');
    expect(limiter.tryAcquire('alice')).toBeNull();
    second();
    expect(limiter.tryAcquire('alice')).toBeTypeOf('function');
  });
});
