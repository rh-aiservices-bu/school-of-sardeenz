export type AuthMode = 'none' | 'simple' | 'oauth';

export interface Config {
  readonly listenAddr: string;
  readonly listenPort: number;
  readonly logLevel: string;
  readonly controlPlaneUrl: string;
  readonly redisUrl: string;
  readonly redisKeyPrefix: string;
  readonly prometheusUrl: string;
  readonly inferenceUrl: string;
  readonly maxConcurrentInferenceRequestsPerUser: number;
  readonly authMode: AuthMode;
  readonly adminUsername: string;
  readonly adminPassword: string;
  readonly jwtSecret: string;
  readonly jwtExpirationHours: number;
  readonly oauthClientId: string;
  readonly oauthClientSecret: string;
  readonly oauthIssuerUrl: string;
  readonly k8sApiUrl: string;
  /** ServiceAccount bearer token override for local development. */
  readonly serviceAccountToken?: string;
  /** Path to the projected ServiceAccount token in a Kubernetes Pod. */
  readonly serviceAccountTokenPath?: string;
  readonly namespace: string;
  readonly controlPlaneApiToken: string;
  readonly publicUrl: string;
}

function optionalEnv(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

function positiveSafeIntegerEnv(name: string, fallback: number): number {
  const value = optionalEnv(name, String(fallback));
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return parsed;
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
    inferenceUrl: optionalEnv('SARDEENZ_INFERENCE_URL', 'http://localhost:8080'),
    maxConcurrentInferenceRequestsPerUser: positiveSafeIntegerEnv(
      'SARDEENZ_BFF_MAX_CONCURRENT_INFERENCE_REQUESTS_PER_USER',
      4,
    ),
    authMode,
    adminUsername: optionalEnv('ADMIN_USERNAME', 'admin'),
    adminPassword: optionalEnv('ADMIN_PASSWORD', ''),
    jwtSecret: optionalEnv('JWT_SECRET', ''),
    jwtExpirationHours: parseInt(optionalEnv('JWT_EXPIRATION_HOURS', '8'), 10),
    oauthClientId: optionalEnv('OAUTH_CLIENT_ID', 'sardeenz'),
    oauthClientSecret: optionalEnv('OAUTH_CLIENT_SECRET', ''),
    oauthIssuerUrl: optionalEnv('OAUTH_ISSUER_URL', ''),
    k8sApiUrl: optionalEnv('K8S_API_URL', ''),
    serviceAccountToken: optionalEnv('SERVICE_ACCOUNT_TOKEN', ''),
    serviceAccountTokenPath: optionalEnv(
      'SERVICE_ACCOUNT_TOKEN_PATH',
      '/var/run/secrets/kubernetes.io/serviceaccount/token',
    ),
    namespace: optionalEnv('NAMESPACE', 'sardeenz'),
    controlPlaneApiToken: optionalEnv('SARDEENZ_API_TOKEN', ''),
    publicUrl: optionalEnv('SARDEENZ_PUBLIC_URL', ''),
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

  if (config.authMode === 'oauth') {
    const missing: string[] = [];
    if (!config.oauthClientId) missing.push('OAUTH_CLIENT_ID');
    if (!config.oauthClientSecret) missing.push('OAUTH_CLIENT_SECRET');
    if (!config.oauthIssuerUrl) missing.push('OAUTH_ISSUER_URL');
    if (!config.k8sApiUrl) missing.push('K8S_API_URL');
    if (!config.publicUrl) missing.push('SARDEENZ_PUBLIC_URL');

    if (missing.length > 0) {
      throw new Error(
        `AUTH_MODE=oauth requires the following environment variables to be set: ${missing.join(', ')}. ` +
          'See docs/usage/deployment-security.md for details.',
      );
    }
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
