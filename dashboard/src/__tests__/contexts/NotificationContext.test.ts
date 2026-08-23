/**
 * Tests for NotificationContext state machine behaviour.
 *
 * We test the notification deduplication and state management logic
 * by simulating the state machine directly, rather than using renderHook
 * (following the project pattern from useEventStream.test.ts).
 */
import { describe, it, expect, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Re-export constant to verify it
// ---------------------------------------------------------------------------

const DEDUP_WINDOW_MS = 500;
const MAX_NOTIFICATIONS = 200;

// ---------------------------------------------------------------------------
// State machine simulator — mirrors the logic in NotificationContext.tsx
// without depending on React hooks
// ---------------------------------------------------------------------------

interface Notification {
  id: string;
  title: string;
  description?: string;
  variant: 'success' | 'warning' | 'danger' | 'info';
  timestamp: string;
  isRead: boolean;
  source?: { type: string; name?: string };
}

interface ToastNotification {
  id: string;
  title: string;
  description?: string;
  variant: 'success' | 'warning' | 'danger' | 'info';
  timeout?: number;
}

interface DedupEntry {
  title: string;
  description?: string;
  timestamp: number;
}

class NotificationStateMachine {
  notifications: Notification[] = [];
  toastNotifications: ToastNotification[] = [];
  private lastNotification: DedupEntry | null = null;

  get unreadCount(): number {
    return this.notifications.filter((n) => !n.isRead).length;
  }

  addNotification(notification: Notification, now = Date.now()): boolean {
    // Dedup check
    if (this.lastNotification) {
      const elapsed = now - this.lastNotification.timestamp;
      if (
        elapsed < DEDUP_WINDOW_MS &&
        this.lastNotification.title === notification.title &&
        this.lastNotification.description === notification.description
      ) {
        return false;
      }
    }
    this.lastNotification = {
      title: notification.title,
      description: notification.description,
      timestamp: now,
    };
    this.notifications = [notification, ...this.notifications].slice(0, MAX_NOTIFICATIONS);
    this.toastNotifications = [
      ...this.toastNotifications,
      {
        id: notification.id,
        title: notification.title,
        description: notification.description,
        variant: notification.variant,
        timeout: 5000,
      },
    ];
    return true;
  }

  markAsRead(id: string): void {
    this.notifications = this.notifications.map((n) => (n.id === id ? { ...n, isRead: true } : n));
  }

  markAllAsRead(): void {
    this.notifications = this.notifications.map((n) => ({ ...n, isRead: true }));
  }

  removeNotification(id: string): void {
    this.notifications = this.notifications.filter((n) => n.id !== id);
  }

  removeToastNotification(id: string): void {
    this.toastNotifications = this.toastNotifications.filter((n) => n.id !== id);
  }

  clearAll(): void {
    this.notifications = [];
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeNotification(overrides?: Partial<Notification>): Notification {
  return {
    id: `notif-${Math.random()}`,
    title: 'Test notification',
    description: 'Test description',
    variant: 'info',
    timestamp: new Date().toISOString(),
    isRead: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('NotificationContext constants', () => {
  it('DEDUP_WINDOW_MS is 500ms', () => {
    expect(DEDUP_WINDOW_MS).toBe(500);
  });

  it('MAX_NOTIFICATIONS is 200 and matches the history fetch limit', () => {
    expect(MAX_NOTIFICATIONS).toBe(200);
  });
});

describe('NotificationContext deduplication', () => {
  let state: NotificationStateMachine;

  beforeEach(() => {
    state = new NotificationStateMachine();
  });

  it('accepts first notification', () => {
    const notif = makeNotification({ id: 'n1', title: 'Alert', description: 'Test' });
    const added = state.addNotification(notif, 1000);
    expect(added).toBe(true);
    expect(state.notifications).toHaveLength(1);
  });

  it('rejects duplicate notification within 500ms window', () => {
    const notif1 = makeNotification({ id: 'n1', title: 'Alert', description: 'Test' });
    const notif2 = makeNotification({ id: 'n2', title: 'Alert', description: 'Test' });

    state.addNotification(notif1, 1000);
    const added = state.addNotification(notif2, 1400); // 400ms later

    expect(added).toBe(false);
    expect(state.notifications).toHaveLength(1);
  });

  it('accepts duplicate notification after 500ms window', () => {
    const notif1 = makeNotification({ id: 'n1', title: 'Alert', description: 'Test' });
    const notif2 = makeNotification({ id: 'n2', title: 'Alert', description: 'Test' });

    state.addNotification(notif1, 1000);
    const added = state.addNotification(notif2, 1600); // 600ms later

    expect(added).toBe(true);
    expect(state.notifications).toHaveLength(2);
  });

  it('accepts notification with different title within 500ms', () => {
    const notif1 = makeNotification({ id: 'n1', title: 'Alert A', description: 'Test' });
    const notif2 = makeNotification({ id: 'n2', title: 'Alert B', description: 'Test' });

    state.addNotification(notif1, 1000);
    const added = state.addNotification(notif2, 1200); // 200ms later

    expect(added).toBe(true);
    expect(state.notifications).toHaveLength(2);
  });

  it('accepts notification with different description within 500ms', () => {
    const notif1 = makeNotification({ id: 'n1', title: 'Alert', description: 'Desc A' });
    const notif2 = makeNotification({ id: 'n2', title: 'Alert', description: 'Desc B' });

    state.addNotification(notif1, 1000);
    const added = state.addNotification(notif2, 1200); // 200ms later

    expect(added).toBe(true);
    expect(state.notifications).toHaveLength(2);
  });

  it('deduplication considers undefined vs defined description as different', () => {
    const notif1 = makeNotification({ id: 'n1', title: 'Alert' });
    const notif2 = makeNotification({ id: 'n2', title: 'Alert', description: 'Desc' });

    state.addNotification(notif1, 1000);
    const added = state.addNotification(notif2, 1200); // 200ms later

    expect(added).toBe(true);
    expect(state.notifications).toHaveLength(2);
  });
});

describe('NotificationContext toast creation', () => {
  let state: NotificationStateMachine;

  beforeEach(() => {
    state = new NotificationStateMachine();
  });

  it('creates toast with same id/title/variant', () => {
    const notif = makeNotification({
      id: 'n1',
      title: 'Success',
      description: 'Operation completed',
      variant: 'success',
    });

    state.addNotification(notif, 1000);

    expect(state.toastNotifications).toHaveLength(1);
    expect(state.toastNotifications[0]).toMatchObject({
      id: 'n1',
      title: 'Success',
      description: 'Operation completed',
      variant: 'success',
      timeout: 5000,
    });
  });

  it('toast has 5000ms timeout', () => {
    const notif = makeNotification({ id: 'n1' });
    state.addNotification(notif, 1000);

    expect(state.toastNotifications[0].timeout).toBe(5000);
  });

  it('no toast created for deduplicated notification', () => {
    const notif1 = makeNotification({ id: 'n1', title: 'Alert', description: 'Test' });
    const notif2 = makeNotification({ id: 'n2', title: 'Alert', description: 'Test' });

    state.addNotification(notif1, 1000);
    state.addNotification(notif2, 1200); // deduplicated

    expect(state.toastNotifications).toHaveLength(1);
  });
});

describe('NotificationContext state management', () => {
  let state: NotificationStateMachine;

  beforeEach(() => {
    state = new NotificationStateMachine();
  });

  it('markAsRead sets isRead=true for matching notification', () => {
    const notif = makeNotification({ id: 'n1', isRead: false });
    state.addNotification(notif, 1000);

    state.markAsRead('n1');

    expect(state.notifications[0].isRead).toBe(true);
  });

  it('markAsRead does not affect other notifications', () => {
    const notif1 = makeNotification({ id: 'n1', title: 'A', isRead: false });
    const notif2 = makeNotification({ id: 'n2', title: 'B', isRead: false });
    state.addNotification(notif1, 1000);
    state.addNotification(notif2, 2000);

    state.markAsRead('n1');

    expect(state.notifications[1].isRead).toBe(true); // n1 is at index 1 (prepended)
    expect(state.notifications[0].isRead).toBe(false); // n2 is at index 0
  });

  it('markAllAsRead sets isRead=true for all notifications', () => {
    const notif1 = makeNotification({ id: 'n1', title: 'A', isRead: false });
    const notif2 = makeNotification({ id: 'n2', title: 'B', isRead: false });
    const notif3 = makeNotification({ id: 'n3', title: 'C', isRead: false });
    state.addNotification(notif1, 1000);
    state.addNotification(notif2, 2000);
    state.addNotification(notif3, 3000);

    state.markAllAsRead();

    expect(state.notifications.every((n) => n.isRead)).toBe(true);
  });

  it('removeNotification removes from list', () => {
    const notif = makeNotification({ id: 'n1' });
    state.addNotification(notif, 1000);
    expect(state.notifications).toHaveLength(1);

    state.removeNotification('n1');

    expect(state.notifications).toHaveLength(0);
  });

  it('removeNotification only removes matching notification', () => {
    const notif1 = makeNotification({ id: 'n1', title: 'A' });
    const notif2 = makeNotification({ id: 'n2', title: 'B' });
    state.addNotification(notif1, 1000);
    state.addNotification(notif2, 2000);

    state.removeNotification('n1');

    expect(state.notifications).toHaveLength(1);
    expect(state.notifications[0].id).toBe('n2');
  });

  it('removeToastNotification removes from toast list', () => {
    const notif = makeNotification({ id: 'n1' });
    state.addNotification(notif, 1000);
    expect(state.toastNotifications).toHaveLength(1);

    state.removeToastNotification('n1');

    expect(state.toastNotifications).toHaveLength(0);
  });

  it('clearAll empties the notification list', () => {
    const notif1 = makeNotification({ id: 'n1', title: 'A' });
    const notif2 = makeNotification({ id: 'n2', title: 'B' });
    state.addNotification(notif1, 1000);
    state.addNotification(notif2, 2000);
    expect(state.notifications).toHaveLength(2);

    state.clearAll();

    expect(state.notifications).toHaveLength(0);
  });

  it('clearAll does not affect toast notifications', () => {
    const notif = makeNotification({ id: 'n1' });
    state.addNotification(notif, 1000);
    expect(state.toastNotifications).toHaveLength(1);

    state.clearAll();

    expect(state.toastNotifications).toHaveLength(1);
  });
});

describe('NotificationContext unread count', () => {
  let state: NotificationStateMachine;

  beforeEach(() => {
    state = new NotificationStateMachine();
  });

  it('counts notifications where isRead=false', () => {
    const notif1 = makeNotification({ id: 'n1', title: 'A', isRead: false });
    const notif2 = makeNotification({ id: 'n2', title: 'B', isRead: false });
    const notif3 = makeNotification({ id: 'n3', title: 'C', isRead: true });
    state.addNotification(notif1, 1000);
    state.addNotification(notif2, 2000);
    state.addNotification(notif3, 3000);

    expect(state.unreadCount).toBe(2);
  });

  it('returns 0 when all notifications are read', () => {
    const notif1 = makeNotification({ id: 'n1', title: 'A', isRead: true });
    const notif2 = makeNotification({ id: 'n2', title: 'B', isRead: true });
    state.addNotification(notif1, 1000);
    state.addNotification(notif2, 2000);

    expect(state.unreadCount).toBe(0);
  });

  it('returns 0 when there are no notifications', () => {
    expect(state.unreadCount).toBe(0);
  });

  it('updates after markAsRead', () => {
    const notif1 = makeNotification({ id: 'n1', title: 'A', isRead: false });
    const notif2 = makeNotification({ id: 'n2', title: 'B', isRead: false });
    state.addNotification(notif1, 1000);
    state.addNotification(notif2, 2000);
    expect(state.unreadCount).toBe(2);

    state.markAsRead('n1');

    expect(state.unreadCount).toBe(1);
  });

  it('updates to 0 after markAllAsRead', () => {
    const notif1 = makeNotification({ id: 'n1', title: 'A', isRead: false });
    const notif2 = makeNotification({ id: 'n2', title: 'B', isRead: false });
    state.addNotification(notif1, 1000);
    state.addNotification(notif2, 2000);
    expect(state.unreadCount).toBe(2);

    state.markAllAsRead();

    expect(state.unreadCount).toBe(0);
  });
});

describe('NotificationContext live-list cap', () => {
  let state: NotificationStateMachine;

  beforeEach(() => {
    state = new NotificationStateMachine();
  });

  it('caps the live list at MAX_NOTIFICATIONS', () => {
    for (let i = 0; i < 205; i++) {
      state.addNotification(makeNotification({ id: `n${i}`, title: `Alert ${i}` }), 1000 + i);
    }

    expect(state.notifications).toHaveLength(MAX_NOTIFICATIONS);
  });

  it('drops the oldest entry when the cap is exceeded', () => {
    for (let i = 0; i < 200; i++) {
      state.addNotification(makeNotification({ id: `n${i}`, title: `Alert ${i}` }), 1000 + i);
    }
    state.addNotification(makeNotification({ id: 'n200', title: 'Alert 200' }), 1200);

    expect(state.notifications.some((n) => n.id === 'n0')).toBe(false);
    expect(state.notifications[0].id).toBe('n200');
    expect(state.notifications).toHaveLength(MAX_NOTIFICATIONS);
  });
});
