export interface DevWorkerConfig {
  redisUrl: string;
  redisKeyPrefix: string;
  workerId: string;
  workerPort: number;
  runnerPortStart: number;
  deviceCount: number;
  deviceType: string;
  deviceMemoryBytes: number;
  runnerType: string;
  startupDelayMs: number;
  sleepDelayMs: number;
  wakeDelayMs: number;
  inferenceDelayMs: number;
  heartbeatIntervalMs: number;
}

function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed)) {
    throw new Error(`Invalid integer for ${key}: ${raw}`);
  }
  return parsed;
}

function envStr(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

const GIB = 1024 * 1024 * 1024;

export function loadConfig(): DevWorkerConfig {
  return {
    redisUrl: envStr('SARDEENZ_REDIS_URL', 'redis://localhost:6379'),
    redisKeyPrefix: envStr('SARDEENZ_REDIS_KEY_PREFIX', 'sardeenz'),
    workerId: envStr('SARDEENZ_WORKER_ID', 'dev-worker-0'),
    workerPort: envInt('SARDEENZ_WORKER_PORT', 9100),
    runnerPortStart: envInt('SARDEENZ_RUNNER_PORT_START', 9101),
    deviceCount: envInt('SARDEENZ_DEVICE_COUNT', 2),
    deviceType: envStr('SARDEENZ_DEVICE_TYPE', 'CUDA'),
    deviceMemoryBytes: envInt('SARDEENZ_DEVICE_MEMORY_GB', 24) * GIB,
    runnerType: envStr('SARDEENZ_RUNNER_TYPE', 'vllm'),
    startupDelayMs: envInt('SARDEENZ_STARTUP_DELAY_MS', 3000),
    sleepDelayMs: envInt('SARDEENZ_SLEEP_DELAY_MS', 500),
    wakeDelayMs: envInt('SARDEENZ_WAKE_DELAY_MS', 1500),
    inferenceDelayMs: envInt('SARDEENZ_INFERENCE_DELAY_MS', 200),
    heartbeatIntervalMs: envInt('SARDEENZ_HEARTBEAT_INTERVAL_MS', 5000),
  };
}
