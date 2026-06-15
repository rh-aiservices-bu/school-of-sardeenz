export type AuthMode = 'none' | 'simple' | 'oauth';

export interface Config {
  readonly listenAddr: string;
  readonly listenPort: number;
  readonly logLevel: string;
  readonly controlPlaneUrl: string;
  readonly redisUrl: string;
  readonly redisKeyPrefix: string;
  readonly prometheusUrl: string;
  readonly corsOrigin: string;
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
    corsOrigin: optionalEnv('SARDEENZ_CORS_ORIGIN', 'http://localhost:5173'),
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
  };
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
