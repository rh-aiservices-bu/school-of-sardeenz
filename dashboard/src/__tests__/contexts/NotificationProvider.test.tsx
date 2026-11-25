/**
 * Tests for NotificationProvider mount-fetch lifecycle and the ProtectedRoute
 * auth gate (issue #106, #148, #176).
 *
 * The auth-gate cases below render the real `ProtectedRoute`
 * (src/components/ProtectedRoute.tsx) inside a `MemoryRouter`, with a mocked
 * `useAuth`. Letting the real gate mount is only possible because
 * dashboard/vitest.config.ts keeps the router on the dashboard-local React
 * 18.3.1 (issue #176); before that the router bound the hoisted React 19 copy
 * and threw "Cannot read properties of null (reading 'useRef')". The
 * mount-fetch block is retained as a direct test of the effect body (it mirrors
 * NotificationContext.tsx exactly); the logic-simulation convention notes in
 * the other dashboard test files are still accurate for them — only this file
 * has been converted.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from '../../contexts/AuthContext';
import type { AuthState } from '../../contexts/AuthContext';
import { api } from '../../api/client';
import { NotificationProvider } from '../../contexts/NotificationContext';
import { ProtectedRoute } from '../../components/ProtectedRoute';
// Real i18next instance: the gate renders t('loading') into the Spinner's aria-label.
import '../../i18n';

vi.mock('../../api/client', () => ({
  api: {
    notifications: {
      list: vi.fn(),
      markRead: vi.fn(),
      markAllRead: vi.fn(),
      remove: vi.fn(),
      clearAll: vi.fn(),
    },
  },
}));

vi.mock('../../contexts/AuthContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../contexts/AuthContext')>();
  return { ...actual, useAuth: vi.fn() };
});

const mockedList = vi.mocked(api.notifications.list);

/**
 * Renders the real ProtectedRoute (src/components/ProtectedRoute.tsx) inside a
 * MemoryRouter with a mocked useAuth. `initialEntries` pins the origin the gate
 * remembers in `state.from`; the `/login` route stands in for the app's login
 * page so the unauthenticated redirect is observable.
 */
function renderGate(auth: Partial<AuthState>, children: ReactNode) {
  const state: AuthState = {
    isAuthenticated: false,
    isAdmin: false,
    user: null,
    authMode: 'simple',
    isLoading: false,
    login: async () => {},
    logout: () => {},
    loginError: null,
    ...auth,
  };
  vi.mocked(useAuth).mockReturnValue(state);
  return render(
    <AuthProvider>
      <MemoryRouter initialEntries={['/gpu-memory']}>
        <Routes>
          <Route path="/gpu-memory" element={<ProtectedRoute>{children}</ProtectedRoute>} />
          <Route path="/login" element={<div data-testid="login-route" />} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );
}

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

describe('NotificationProvider auth gate (real render)', () => {
  beforeEach(() => {
    vi.mocked(useAuth).mockReset();
    mockedList.mockReset();
    mockedList.mockResolvedValue({ notifications: [] });
  });

  it('does NOT mount NotificationProvider (no history fetch) while unauthenticated under simple auth', async () => {
    renderGate(
      { authMode: 'simple', isAuthenticated: false },
      <NotificationProvider>PROVIDER_MOUNTED</NotificationProvider>,
    );
    expect(await screen.findByTestId('login-route')).toBeInTheDocument();
    expect(screen.queryByText('PROVIDER_MOUNTED')).not.toBeInTheDocument();
    expect(mockedList).not.toHaveBeenCalled();
  });

  it('does NOT mount NotificationProvider while unauthenticated under oauth', async () => {
    renderGate(
      { authMode: 'oauth', isAuthenticated: false },
      <NotificationProvider>PROVIDER_MOUNTED</NotificationProvider>,
    );
    expect(await screen.findByTestId('login-route')).toBeInTheDocument();
    expect(mockedList).not.toHaveBeenCalled();
  });

  it('mounts NotificationProvider and fires the history fetch once authenticated', async () => {
    renderGate(
      {
        authMode: 'simple',
        isAuthenticated: true,
        isAdmin: true,
        user: { username: 'alice', roles: ['admin'], authMode: 'simple' },
      },
      <NotificationProvider>PROVIDER_MOUNTED</NotificationProvider>,
    );
    expect(await screen.findByText('PROVIDER_MOUNTED')).toBeInTheDocument();
    await vi.waitFor(() => expect(mockedList).toHaveBeenCalledTimes(1));
    expect(mockedList).toHaveBeenCalledWith(200);
  });

  it('mounts NotificationProvider unconditionally when auth is disabled', async () => {
    renderGate({ authMode: 'none' }, <NotificationProvider>PROVIDER_MOUNTED</NotificationProvider>);
    expect(await screen.findByText('PROVIDER_MOUNTED')).toBeInTheDocument();
    await vi.waitFor(() => expect(mockedList).toHaveBeenCalledTimes(1));
  });

  it('renders the loading spinner (not the children) while auth state is loading', async () => {
    renderGate(
      { isLoading: true, isAuthenticated: false },
      <NotificationProvider>PROVIDER_MOUNTED</NotificationProvider>,
    );
    expect(await screen.findByRole('progressbar')).toBeInTheDocument();
    expect(screen.queryByText('PROVIDER_MOUNTED')).not.toBeInTheDocument();
    expect(mockedList).not.toHaveBeenCalled();
  });
});
