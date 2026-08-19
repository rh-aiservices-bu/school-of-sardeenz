// Launch mode: 'stub' forks in-process runner stubs (dev, Phase 3.6); 'apptainer' execs engine
// SIFs off the shared module volume (prod, Phase 4). Both share registration/management/heartbeat.
export type WorkerMode = 'stub' | 'apptainer';

export interface ApptainerConfig {
  apptainerBin: string;
  modulesDir: string;
  weightsDir: string;
  scratchDir: string;
  binds: string[];
  runnerEntrypoint: string[];
  home: string;
  verifySif: boolean;
  healthTimeoutMs: number;
  healthIntervalMs: number;
  stopGraceMs: number;
}

export interface DevWorkerConfig {
  mode: WorkerMode;
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
  apptainer: ApptainerConfig;
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

function envBool(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function envList(key: string, fallback: string[]): string[] {
  const raw = process.env[key];
  if (!raw) return fallback;
  return raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// Resolve the launch mode from `--mode <m>` / `--mode=<m>` (argv wins) then SARDEENZ_WORKER_MODE.
function resolveMode(argv: string[] = process.argv.slice(2)): WorkerMode {
  let value: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--mode') value = argv[i + 1];
    else if (arg.startsWith('--mode=')) value = arg.slice('--mode='.length);
  }
  value = value ?? process.env.SARDEENZ_WORKER_MODE;
  if (value === 'apptainer' || value === 'stub') return value;
  if (value !== undefined) {
    throw new Error(`Invalid worker mode: ${value} (expected 'stub' or 'apptainer')`);
  }
  return 'stub';
}

const GIB = 1024 * 1024 * 1024;

export function loadConfig(): DevWorkerConfig {
  return {
    mode: resolveMode(),
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
    apptainer: {
      apptainerBin: envStr('SARDEENZ_APPTAINER_BIN', 'apptainer'),
      modulesDir: envStr('SARDEENZ_MODULES_DIR', '/modules'),
      weightsDir: envStr('SARDEENZ_WEIGHTS_DIR', '/weights'),
      scratchDir: envStr('SARDEENZ_SCRATCH_DIR', '/scratch'),
      binds: envList('SARDEENZ_APPTAINER_BINDS', ['/weights', '/scratch']),
      runnerEntrypoint: envList('SARDEENZ_RUNNER_ENTRYPOINT', [
        'python3',
        '-m',
        'sardeenz_vllm_runner',
      ]),
      home: envStr('SARDEENZ_APPTAINER_HOME', '/scratch/home'),
      verifySif: envBool('SARDEENZ_VERIFY_SIF', true),
      healthTimeoutMs: envInt('SARDEENZ_HEALTH_TIMEOUT_MS', 300000),
      healthIntervalMs: envInt('SARDEENZ_HEALTH_INTERVAL_MS', 1000),
      stopGraceMs: envInt('SARDEENZ_STOP_GRACE_MS', 15000),
    },
  };
}
