/**
 * Per-process, per-user concurrency guard for inference responses. A release callback is
 * deliberately idempotent because a response can end, error, and close in quick succession.
 */
export class InferenceConcurrencyLimiter {
  private readonly activeByUsername = new Map<string, number>();

  constructor(private readonly maxConcurrentRequestsPerUser: number) {}

  tryAcquire(username: string): (() => void) | null {
    const active = this.activeByUsername.get(username) ?? 0;
    if (active >= this.maxConcurrentRequestsPerUser) return null;

    this.activeByUsername.set(username, active + 1);
    let released = false;

    return () => {
      if (released) return;
      released = true;

      const current = this.activeByUsername.get(username) ?? 0;
      if (current <= 1) {
        this.activeByUsername.delete(username);
      } else {
        this.activeByUsername.set(username, current - 1);
      }
    };
  }
}
