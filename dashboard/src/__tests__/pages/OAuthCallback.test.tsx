/**
 * Tests for the OAuth callback page's single-use code exchange (issue #136).
 *
 * The page reads the real `window.location.search` (not the router location), so each case
 * sets the URL with `window.history.replaceState` before mounting. The real `AuthProvider`
 * runs, which is why every case stubs `fetch` for `/api/auth/config`, `/api/auth/exchange`
 * and `/api/auth/me` — the exchange result is validated server-side like any other login.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mock } from 'vitest';
import { StrictMode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider } from '../../contexts/AuthContext';
import { OAuthCallback } from '../../pages/Login/OAuthCallback';
import '../../i18n';

const EXCHANGED_TOKEN = 'exchanged.jwt.token';
const SESSION_KEY = 'sardeenz_auth_token';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

type ExchangeHandler = (init?: RequestInit) => Response;
type FetchMock = Mock<(input: string, init?: RequestInit) => Promise<Response>>;

function stubFetch(
  exchange: ExchangeHandler = () => jsonResponse({ token: EXCHANGED_TOKEN }),
): FetchMock {
  const fetchMock: FetchMock = vi.fn((input, init) => {
    if (input.endsWith('/auth/exchange')) return Promise.resolve(exchange(init));
    if (input.endsWith('/auth/config')) return Promise.resolve(jsonResponse({ authMode: 'oauth' }));
    if (input.endsWith('/auth/me')) {
      return Promise.resolve(
        jsonResponse({ username: 'alice', roles: ['admin'], authMode: 'oauth' }),
      );
    }
    return Promise.resolve(jsonResponse({ ok: true }));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function exchangeCalls(fetchMock: FetchMock) {
  return fetchMock.mock.calls.filter(([input]) => input.endsWith('/auth/exchange'));
}

function renderCallback(url: string, strict = false) {
  // The page reads window.location.search, which MemoryRouter never touches.
  window.history.replaceState(null, '', url);
  const tree = (
    <MemoryRouter initialEntries={[url]}>
      <AuthProvider>
        <Routes>
          <Route path="/oauth/callback" element={<OAuthCallback />} />
          <Route path="/login" element={<div data-testid="login-route" />} />
          <Route path="/" element={<div data-testid="home-route" />} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>
  );
  return render(strict ? <StrictMode>{tree}</StrictMode> : tree);
}

describe('OAuthCallback', () => {
  beforeEach(() => {
    sessionStorage.clear();
    window.history.replaceState(null, '', '/');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('exchanges the query code and stores the returned token', async () => {
    const fetchMock = stubFetch();
    renderCallback('/oauth/callback?code=abc');

    await waitFor(() => expect(exchangeCalls(fetchMock)).toHaveLength(1));
    const [input, init] = exchangeCalls(fetchMock)[0] ?? ['', undefined];
    expect(input).toBe('/api/auth/exchange');
    expect(init?.method).toBe('POST');
    const rawBody = init?.body;
    expect(JSON.parse(typeof rawBody === 'string' ? rawBody : '')).toEqual({ code: 'abc' });
    await waitFor(() => expect(sessionStorage.getItem(SESSION_KEY)).toBe(EXCHANGED_TOKEN));
  });

  it('never reads the token fragment', async () => {
    const fetchMock = stubFetch();
    renderCallback('/oauth/callback#token=leaked');

    expect(
      await screen.findByText('Login could not be completed. Please try again.'),
    ).toBeInTheDocument();
    expect(exchangeCalls(fetchMock)).toHaveLength(0);
    expect(sessionStorage.getItem(SESSION_KEY)).toBeNull();
  });

  it('renders the failure state with a link back to the login page', async () => {
    stubFetch(() =>
      jsonResponse({ error: 'Invalid or expired exchange code', code: 'INVALID_REQUEST' }, 400),
    );
    renderCallback('/oauth/callback?code=abc');

    expect(
      await screen.findByText('Login could not be completed. Please try again.'),
    ).toBeInTheDocument();
    const backLink = screen.getByRole('link', { name: 'Back to login' });
    expect(backLink).toHaveAttribute('href', '/login');
    expect(sessionStorage.getItem(SESSION_KEY)).toBeNull();
  });

  it('redeems the code exactly once under StrictMode', async () => {
    const fetchMock = stubFetch();
    renderCallback('/oauth/callback?code=abc', true);

    await waitFor(() => expect(sessionStorage.getItem(SESSION_KEY)).toBe(EXCHANGED_TOKEN));
    expect(exchangeCalls(fetchMock)).toHaveLength(1);
  });

  it('strips the query from the history entry after the exchange settles', async () => {
    stubFetch();
    renderCallback('/oauth/callback?code=abc');
    const replaceStateSpy = vi.spyOn(window.history, 'replaceState');

    await waitFor(() => expect(replaceStateSpy).toHaveBeenCalledWith(null, '', '/oauth/callback'));
    replaceStateSpy.mockRestore();
  });
});
