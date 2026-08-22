export type AuthMode = 'none' | 'simple' | 'oauth';

export interface Config {
  readonly listenAddr: string;
  readonly listenPort: number;
  readonly logLevel: string;
  readonly controlPlaneUrl: string;
  readonly redisUrl: string;
  readonly redisKeyPrefix: string;
  readonly prometheusUrl: string;
  readonly authMode: AuthMode;
  readonly adminUsername: string;
  readonly adminPassword: string;
  readonly jwtSecret: string;
  readonly jwtExpirationHours: number;
  readonly oauthClientId: string;
  readonly oauthClientSecret: string;
  readonly oauthIssuerUrl: string;
  readonly k8sApiUrl: string;
  readonly namespace: string;
  readonly controlPlaneApiToken: string;
}

function optionalEnv(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export function loadConfig(): Config {
  const listenAddr = optionalEnv('SARDEENZ_BFF_LISTEN_ADDR', '0.0.0.0:4000');
  const [host, portStr] = listenAddr.includes(':')
    ? [
        listenAddr.slice(0, listenAddr.lastIndexOf(':')),
        listenAddr.slice(listenAddr.lastIndexOf(':') + 1),
      ]
    : [listenAddr, '4000'];

  const authMode = optionalEnv('AUTH_MODE', 'none') as AuthMode;
  if (!['none', 'simple', 'oauth'].includes(authMode)) {
    throw new Error(`Invalid AUTH_MODE: ${authMode}. Must be none, simple, or oauth.`);
  }

  return {
    listenAddr: host ?? '0.0.0.0',
    listenPort: parseInt(portStr ?? '4000', 10),
    logLevel: optionalEnv('SARDEENZ_LOG_LEVEL', 'info'),
    controlPlaneUrl: optionalEnv('SARDEENZ_CONTROL_PLANE_URL', 'http://localhost:3000'),
    redisUrl: optionalEnv('SARDEENZ_REDIS_URL', 'redis://localhost:6379'),
    redisKeyPrefix: optionalEnv('SARDEENZ_REDIS_KEY_PREFIX', 'sardeenz'),
    prometheusUrl: optionalEnv('SARDEENZ_PROMETHEUS_URL', 'http://localhost:9090'),
    authMode,
    adminUsername: optionalEnv('ADMIN_USERNAME', 'admin'),
    adminPassword: optionalEnv('ADMIN_PASSWORD', ''),
    jwtSecret: optionalEnv('JWT_SECRET', ''),
    jwtExpirationHours: parseInt(optionalEnv('JWT_EXPIRATION_HOURS', '8'), 10),
    oauthClientId: optionalEnv('OAUTH_CLIENT_ID', 'sardeenz'),
    oauthClientSecret: optionalEnv('OAUTH_CLIENT_SECRET', ''),
    oauthIssuerUrl: optionalEnv('OAUTH_ISSUER_URL', ''),
    k8sApiUrl: optionalEnv('K8S_API_URL', ''),
    namespace: optionalEnv('NAMESPACE', 'sardeenz'),
    controlPlaneApiToken: optionalEnv('SARDEENZ_API_TOKEN', ''),
  };
}

export interface AuthConfigLogger {
  warn: (msg: string) => void;
}

/**
 * Validate auth configuration for security. Must be called at startup.
 *
 * - Fails in production when AUTH_MODE=none (unauthenticated admin access).
 * - Fails when AUTH_MODE=simple but ADMIN_PASSWORD is empty/unset.
 * - Logs a prominent warning in development when AUTH_MODE=none.
 */
export function validateAuthConfig(config: Config, logger?: AuthConfigLogger): void {
  const isProduction = process.env['NODE_ENV'] === 'production';

  if (config.authMode === 'none') {
    if (isProduction) {
      throw new Error(
        'AUTH_MODE=none is not allowed in production. ' +
          'Set AUTH_MODE to "simple" or "oauth" and configure the required credentials. ' +
          'See docs/usage/deployment-security.md for details.',
      );
    }

    // Development/test: warn loudly
    const warn = logger?.warn ?? console.warn.bind(console);
    warn(
      '⚠ AUTH_MODE=none — all routes are unprotected. ' +
        'Do NOT expose this instance beyond a trusted development network.',
    );
  }

  if (config.authMode === 'simple' && !config.adminPassword) {
    throw new Error(
      'ADMIN_PASSWORD must be explicitly set and non-empty when AUTH_MODE=simple. ' +
        'An empty password would allow unauthenticated admin access.',
    );
  }
}

export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) {
      parsed.password = '***';
    }
    return parsed.toString();
  } catch {
    return '(invalid URL)';
  }
}
