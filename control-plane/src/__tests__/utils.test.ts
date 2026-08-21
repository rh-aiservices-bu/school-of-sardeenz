// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { delay, delaySafe } from '../utils.js';

describe('delay', () => {
  it('resolves after the given duration when not aborted', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const promise = delay(1000, controller.signal);

    await vi.advanceTimersByTimeAsync(1000);
    await expect(promise).resolves.toBeUndefined();
    vi.useRealTimers();
  });

  it('rejects immediately if the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(delay(1000, controller.signal)).rejects.toThrow();
  });

  it('rejects when the signal aborts mid-wait', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const promise = delay(1000, controller.signal);

    controller.abort();
    await expect(promise).rejects.toThrow();
    vi.useRealTimers();
  });
});

describe('delaySafe', () => {
  it('resolves after the given duration when not aborted', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const promise = delaySafe(1000, controller.signal);

    await vi.advanceTimersByTimeAsync(1000);
    await expect(promise).resolves.toBeUndefined();
    vi.useRealTimers();
  });

  it('resolves (does not reject) immediately if the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(delaySafe(1000, controller.signal)).resolves.toBeUndefined();
  });

  it('resolves (does not reject) when the signal aborts mid-wait', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const promise = delaySafe(1000, controller.signal);

    controller.abort();
    await expect(promise).resolves.toBeUndefined();
    vi.useRealTimers();
  });

  it('lets a while(!signal.aborted) polling loop fall through to code after the loop', async () => {
    vi.useFakeTimers();
    const signal = AbortSignal.timeout(500);
    let iterations = 0;
    let fellThrough = false;

    const loop = async () => {
      while (!signal.aborted) {
        iterations++;
        await delaySafe(100, signal);
      }
      fellThrough = true;
    };

    const promise = loop();
    await vi.advanceTimersByTimeAsync(500);
    await promise;

    expect(fellThrough).toBe(true);
    expect(iterations).toBeGreaterThan(0);
    vi.useRealTimers();
  });
});
