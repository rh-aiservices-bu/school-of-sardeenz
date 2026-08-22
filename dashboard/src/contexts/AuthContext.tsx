import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
  type ReactNode,
} from 'react';
import type { AuthMode } from './auth-types';

export type { AuthMode };

export interface AuthUser {
  username: string;
  roles: string[];
  authMode: 'simple' | 'oauth' | 'none';
}

export interface AuthState {
  isAuthenticated: boolean;
  /** True when the user holds the `admin` role (write access). False for `admin-readonly`. */
  isAdmin: boolean;
  user: AuthUser | null;
  authMode: AuthMode;
  isLoading: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
  loginError: string | null;
}

const SESSION_KEY = 'sardeenz_auth_token';

/** Decode a JWT payload without verification (for display only). */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const encoded = parts[1];
    if (!encoded) return null;
    const payload = atob(encoded.replace(/-/g, '+').replace(/_/g, '/'));
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

function getStoredToken(): string | null {
  try {
    return sessionStorage.getItem(SESSION_KEY);
  } catch {
    return null;
  }
}

function storeToken(token: string): void {
  try {
    sessionStorage.setItem(SESSION_KEY, token);
  } catch {
    // sessionStorage may be unavailable
  }
}

function clearToken(): void {
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // ignore
  }
}

const AuthContext = createContext<AuthState>({
  isAuthenticated: false,
  isAdmin: false,
  user: null,
  authMode: 'none',
  isLoading: true,
  login: async () => {},
  logout: () => {},
  loginError: null,
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [authMode, setAuthMode] = useState<AuthMode>('none');
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loginError, setLoginError] = useState<string | null>(null);
  const logoutTimerRef = useRef<ReturnType<typeof setTimeout>>();

  const logout = useCallback(() => {
    clearToken();
    setUser(null);
    if (logoutTimerRef.current) {
      clearTimeout(logoutTimerRef.current);
      logoutTimerRef.current = undefined;
    }
    const baseUrl = import.meta.env.VITE_API_URL ?? '/api';
    void fetch(`${baseUrl}/auth/logout`, { method: 'POST' });
  }, []);

  // Listen for 401 events from the API client
  useEffect(() => {
    const handler = () => logout();
    window.addEventListener('auth:unauthorized', handler);
    return () => window.removeEventListener('auth:unauthorized', handler);
  }, [logout]);

  // Set auto-logout timer based on JWT exp
  const scheduleAutoLogout = useCallback(
    (token: string) => {
      if (logoutTimerRef.current) {
        clearTimeout(logoutTimerRef.current);
        logoutTimerRef.current = undefined;
      }
      const payload = decodeJwtPayload(token);
      if (!payload || typeof payload['exp'] !== 'number') return;
      const expiresAt = payload['exp'] * 1000;
      const delay = expiresAt - Date.now() - 30_000; // 30s before expiry
      if (delay > 0) {
        logoutTimerRef.current = setTimeout(logout, delay);
      }
    },
    [logout],
  );

  // Clear the pending auto-logout timer on unmount to avoid a stray logout() call.
  useEffect(() => {
    return () => {
      if (logoutTimerRef.current) {
        clearTimeout(logoutTimerRef.current);
      }
    };
  }, []);

  // Extract user info from JWT
  const setUserFromToken = useCallback(
    (token: string) => {
      const payload = decodeJwtPayload(token);
      if (!payload) return;
      const authUser: AuthUser = {
        username: (payload['username'] as string) ?? 'unknown',
        roles: (payload['roles'] as string[]) ?? [],
        authMode: (payload['authMode'] as AuthUser['authMode']) ?? 'simple',
      };
      setUser(authUser);
      scheduleAutoLogout(token);
    },
    [scheduleAutoLogout],
  );

  // Validate a token server-side and set user from the verified response
  const validateTokenServerSide = useCallback(
    async (token: string, baseUrl: string, cancelled: { value: boolean }) => {
      try {
        const res = await fetch(`${baseUrl}/auth/me`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.ok && !cancelled.value) {
          const data = (await res.json()) as {
            username: string;
            roles: string[];
            authMode: AuthUser['authMode'];
          };
          setUser({ username: data.username, roles: data.roles, authMode: data.authMode });
          scheduleAutoLogout(token);
          return true;
        }
      } catch {
        // Server unreachable — fall through
      }
      if (!cancelled.value) {
        clearToken();
        setUser(null);
      }
      return false;
    },
    [scheduleAutoLogout],
  );

  // Boot: fetch auth config and validate existing token server-side
  useEffect(() => {
    const cancelled = { value: false };

    async function init() {
      try {
        const baseUrl = import.meta.env.VITE_API_URL ?? '/api';
        const res = await fetch(`${baseUrl}/auth/config`);
        if (res.ok) {
          const data = (await res.json()) as { authMode: AuthMode };
          if (!cancelled.value) setAuthMode(data.authMode);
        }

        // Check for OAuth callback token in URL fragment
        if (window.location.hash.startsWith('#token=')) {
          const fragmentToken = window.location.hash.slice(7);
          storeToken(fragmentToken);
          if (!cancelled.value) {
            await validateTokenServerSide(fragmentToken, baseUrl, cancelled);
          }
          window.history.replaceState(null, '', window.location.pathname);
        } else {
          // Validate existing cached token server-side
          const token = getStoredToken();
          if (token && !cancelled.value) {
            await validateTokenServerSide(token, baseUrl, cancelled);
          }
        }
      } catch {
        // If we can't reach the server, default to 'none'
      }

      if (!cancelled.value) setIsLoading(false);
    }

    void init();
    return () => {
      cancelled.value = true;
    };
  }, [validateTokenServerSide]);

  const login = useCallback(
    async (username: string, password: string) => {
      setLoginError(null);
      const baseUrl = import.meta.env.VITE_API_URL ?? '/api';

      const res = await fetch(`${baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        const message = body.error ?? `Login failed (${res.status})`;
        setLoginError(message);
        throw new Error(message);
      }

      const data = (await res.json()) as { token: string };
      storeToken(data.token);
      setUserFromToken(data.token);
    },
    [setUserFromToken],
  );

  const isAuthenticated = authMode === 'none' || user !== null;
  // In 'none' mode the synthetic user has 'admin' role; otherwise require explicit membership.
  const isAdmin = authMode === 'none' || (user?.roles.includes('admin') ?? false);

  return (
    <AuthContext.Provider
      value={{ isAuthenticated, isAdmin, user, authMode, isLoading, login, logout, loginError }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  return useContext(AuthContext);
}
