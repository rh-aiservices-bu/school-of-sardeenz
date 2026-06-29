export interface Config {
  readonly listenAddr: string;
  readonly listenPort: number;
  readonly logLevel: string;
  readonly redisUrl: string;
  readonly databaseUrl: string;
  readonly redisKeyPrefix: string;
  readonly leaseName: string;
  readonly leaseNamespace: string;
  readonly workerHeartbeatTimeoutSecs: number;
  readonly parkingTimeoutSecs: number;
  readonly evictionMaxPerCycle: number;
  readonly sleepTimeoutSecs: number;
  readonly wakeTimeoutSecs: number;
  readonly healthCheckIntervalSecs: number;
  readonly deployTimeoutSecs: number;
  readonly reconciliationIntervalSecs: number;
}

export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`Required environment variable ${name} is not set`);
  }
  return value;
}

function optionalEnv(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Environment variable ${name} must be an integer, got: ${raw}`);
  }
  return parsed;
}

export function loadConfig(): Config {
  const listenAddr = optionalEnv('SARDEENZ_LISTEN_ADDR', '0.0.0.0:3000');
  const [host, portStr] = listenAddr.includes(':')
    ? [
        listenAddr.slice(0, listenAddr.lastIndexOf(':')),
        listenAddr.slice(listenAddr.lastIndexOf(':') + 1),
      ]
    : [listenAddr, '3000'];

  return {
    listenAddr: host ?? '0.0.0.0',
    listenPort: parseInt(portStr ?? '3000', 10),
    logLevel: optionalEnv('SARDEENZ_LOG_LEVEL', 'info'),
    redisUrl: optionalEnv('SARDEENZ_REDIS_URL', 'redis://localhost:6379'),
    databaseUrl: optionalEnv('SARDEENZ_DATABASE_URL', 'postgresql://sardeenz:sardeenz@localhost:5432/sardeenz'),
    redisKeyPrefix: optionalEnv('SARDEENZ_REDIS_KEY_PREFIX', 'sardeenz'),
    leaseName: optionalEnv('SARDEENZ_LEASE_NAME', 'sardeenz-control-plane'),
    leaseNamespace: optionalEnv('SARDEENZ_LEASE_NAMESPACE', 'default'),
    workerHeartbeatTimeoutSecs: intEnv('SARDEENZ_WORKER_HEARTBEAT_TIMEOUT_SECS', 30),
    parkingTimeoutSecs: intEnv('SARDEENZ_PARKING_TIMEOUT_SECS', 120),
    evictionMaxPerCycle: intEnv('SARDEENZ_EVICTION_MAX_PER_CYCLE', 3),
    sleepTimeoutSecs: intEnv('SARDEENZ_SLEEP_TIMEOUT_SECS', 300),
    wakeTimeoutSecs: intEnv('SARDEENZ_WAKE_TIMEOUT_SECS', 300),
    healthCheckIntervalSecs: intEnv('SARDEENZ_HEALTH_CHECK_INTERVAL_SECS', 10),
    deployTimeoutSecs: intEnv('SARDEENZ_DEPLOY_TIMEOUT_SECS', 600),
    reconciliationIntervalSecs: intEnv('SARDEENZ_RECONCILIATION_INTERVAL_SECS', 30),
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
