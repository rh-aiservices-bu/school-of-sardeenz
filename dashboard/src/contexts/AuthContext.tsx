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
    }
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

  // Boot: fetch auth config and check existing token
  useEffect(() => {
    let cancelled = false;

    async function init() {
      try {
        const baseUrl = import.meta.env.VITE_API_URL ?? '/api';
        const res = await fetch(`${baseUrl}/auth/config`);
        if (res.ok) {
          const data = (await res.json()) as { authMode: AuthMode };
          if (!cancelled) setAuthMode(data.authMode);
        }
      } catch {
        // If we can't reach the server, default to 'none'
      }

      // Check for existing token in sessionStorage
      const token = getStoredToken();
      if (token && !cancelled) {
        setUserFromToken(token);
      }

      // Check for OAuth callback token in URL fragment
      if (window.location.hash.startsWith('#token=')) {
        const token = window.location.hash.slice(7);
        storeToken(token);
        if (!cancelled) setUserFromToken(token);
        // Clean up the URL
        window.history.replaceState(null, '', window.location.pathname);
      }

      if (!cancelled) setIsLoading(false);
    }

    void init();
    return () => {
      cancelled = true;
    };
  }, [setUserFromToken]);

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

/** Helper to get the current auth token (for SSE query param). */
export function getAuthToken(): string | null {
  return getStoredToken();
}
