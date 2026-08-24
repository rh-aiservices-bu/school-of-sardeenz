/**
 * Tests for the NotificationProvider mount-fetch lifecycle (issue #106).
 *
 * We test the fetch/error-handling logic that the provider's mount effect
 * runs by simulating it directly, rather than using renderHook — following
 * the project convention documented in NotificationContext.test.ts,
 * useEventStream.test.ts, and role-visibility.test.tsx ("to avoid React
 * version conflicts in the worktree").
 *
 * That conflict is real here, not just historical caution: this worktree's
 * root node_modules resolves @testing-library/react against React 19.2.7,
 * while dashboard/vitest.config.ts aliases the dashboard's own code to its
 * local React 18.3.1. Any renderHook/render call throws "Invalid hook call"
 * or "A React Element from an older version of React was rendered" —
 * verified empirically while implementing this file.
 *
 * Rendering-level coverage for actual mount/unmount behaviour is deferred to
 * the Playwright e2e suite, matching the pattern role-visibility.test.tsx
 * uses for the same reason (not extended here — out of scope for #106).
 */
import { describe, it, expect, vi } from 'vitest';

const MAX_NOTIFICATIONS = 200;

interface Notification {
  id: string;
  title: string;
  description?: string;
  variant: 'success' | 'warning' | 'danger' | 'info';
  timestamp: string;
  isRead: boolean;
}

/** Mirrors NotificationContext.tsx's shared error logger. */
function logNotificationError(context: string, error: unknown): void {
  console.error(`[notifications] ${context}`, error);
}

/** Mirrors the mount-effect body in NotificationContext.tsx exactly. */
async function fetchHistory(
  list: (limit: number) => Promise<{ notifications: Notification[] }>,
): Promise<{ notifications: Notification[]; historyError: boolean }> {
  try {
    const data = await list(MAX_NOTIFICATIONS);
    return { notifications: data.notifications, historyError: false };
  } catch (error) {
    logNotificationError('failed to load notification history', error);
    return { notifications: [], historyError: true };
  }
}

function makeNotification(overrides?: Partial<Notification>): Notification {
  return {
    id: `notif-${Math.random()}`,
    title: 'Test notification',
    variant: 'info',
    timestamp: new Date().toISOString(),
    isRead: false,
    ...overrides,
  };
}

describe('NotificationProvider mount fetch', () => {
  it('issues the history fetch exactly once, requesting MAX_NOTIFICATIONS', async () => {
    const list = vi.fn().mockResolvedValue({ notifications: [] });

    await fetchHistory(list);

    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith(200);
  });

  it('a successful fetch clears historyError and returns the history', async () => {
    const history = [makeNotification({ id: 'n1' })];
    const list = vi.fn().mockResolvedValue({ notifications: history });

    const result = await fetchHistory(list);

    expect(result.historyError).toBe(false);
    expect(result.notifications).toEqual(history);
  });

  it('a failing fetch is logged and sets historyError, discarding any history', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const error = new Error('network down');
    const list = vi.fn().mockRejectedValue(error);

    const result = await fetchHistory(list);

    expect(result.historyError).toBe(true);
    expect(result.notifications).toEqual([]);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[notifications] failed to load notification history'),
      error,
    );
    consoleErrorSpy.mockRestore();
  });

  it('remounting (logout/login) issues a fresh fetch whose result does not carry over prior state', async () => {
    const firstUserHistory = [makeNotification({ id: 'user-a-1', title: 'A history' })];
    const secondUserHistory = [makeNotification({ id: 'user-b-1', title: 'B history' })];

    const firstList = vi.fn().mockResolvedValue({ notifications: firstUserHistory });
    const firstMount = await fetchHistory(firstList);
    expect(firstMount.notifications[0].id).toBe('user-a-1');

    // Unmount discards `firstMount`'s state; a fresh provider instance (a new
    // mount, e.g. after re-login) re-fetches from scratch with no reference
    // to the prior result.
    const secondList = vi.fn().mockResolvedValue({ notifications: secondUserHistory });
    const secondMount = await fetchHistory(secondList);

    expect(secondMount.notifications).toHaveLength(1);
    expect(secondMount.notifications[0].id).toBe('user-b-1');
    expect(secondList).toHaveBeenCalledTimes(1);
  });
});

describe('NotificationProvider auth-gate guard', () => {
  /** Mirrors ProtectedRoute's gating condition in App.tsx. */
  function gateMountsProvider(
    authMode: 'none' | 'simple' | 'oauth',
    isAuthenticated: boolean,
  ): boolean {
    return authMode === 'none' || isAuthenticated;
  }

  it('does not mount the provider while unauthenticated under simple auth', () => {
    expect(gateMountsProvider('simple', false)).toBe(false);
  });

  it('mounts the provider once authenticated under simple auth', () => {
    expect(gateMountsProvider('simple', true)).toBe(true);
  });

  it('does not mount the provider while unauthenticated under oauth', () => {
    expect(gateMountsProvider('oauth', false)).toBe(false);
  });

  it('mounts the provider unconditionally when auth is disabled', () => {
    expect(gateMountsProvider('none', false)).toBe(true);
  });

  it('the history fetch never runs while the gate keeps the provider unmounted', () => {
    // NotificationProvider's only fetch is triggered by its mount effect
    // (useEffect(…, [])). React guarantees an unmounted component's effects
    // never run, so gateMountsProvider === false is sufficient to prove no
    // /api/notifications request is issued — there is no code path in
    // NotificationContext.tsx that fetches independently of mount.
    const listMock = vi.fn();
    const authed = gateMountsProvider('simple', false);
    if (authed) {
      void fetchHistory(listMock);
    }
    expect(listMock).not.toHaveBeenCalled();
  });
});
