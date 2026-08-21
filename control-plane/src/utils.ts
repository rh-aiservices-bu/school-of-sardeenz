/** Delay helper that respects an AbortSignal. */
export function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abortError = (): Error =>
      signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError');

    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Like `delay`, but resolves instead of rejecting when the signal aborts. Callers that poll in a
 * `while (!signal.aborted)` loop until a timeout need the loop condition itself to end the loop —
 * if the delay rejects on abort, that rejection propagates out of the loop and skips the
 * timeout-handling code that follows it.
 */
export function delaySafe(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
