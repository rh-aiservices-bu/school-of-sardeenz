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
  advertiseHost: string;
}

export interface DevWorkerConfig {
  mode: WorkerMode;
  redisUrl: string;
  redisKeyPrefix: string;
  workerId: string;
  workerPort: number;
  advertiseHost: string;
  runnerPortStart: number;
  maxRunners: number;
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
  // The apptainer bind mounts, cache dir, and HOME all live under the weights/scratch dirs, so
  // derive their defaults from these rather than hard-coding /weights,/scratch. That way overriding
  // just the dirs (e.g. for local dev) also moves the binds + HOME; prod (/weights, /scratch) is
  // unchanged. SARDEENZ_APPTAINER_BINDS / SARDEENZ_APPTAINER_HOME still override explicitly.
  const weightsDir = envStr('SARDEENZ_WEIGHTS_DIR', '/weights');
  const scratchDir = envStr('SARDEENZ_SCRATCH_DIR', '/scratch');
  return {
    mode: resolveMode(),
    redisUrl: envStr('SARDEENZ_REDIS_URL', 'redis://localhost:6379'),
    redisKeyPrefix: envStr('SARDEENZ_REDIS_KEY_PREFIX', 'sardeenz'),
    workerId: envStr('SARDEENZ_WORKER_ID', 'dev-worker-0'),
    workerPort: envInt('SARDEENZ_WORKER_PORT', 9100),
    advertiseHost: envStr('SARDEENZ_WORKER_ADVERTISE_HOST', 'localhost'),
    runnerPortStart: envInt('SARDEENZ_RUNNER_PORT_START', 9101),
    maxRunners: envInt('SARDEENZ_MAX_RUNNERS', 32),
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
      weightsDir,
      scratchDir,
      binds: envList('SARDEENZ_APPTAINER_BINDS', [weightsDir, scratchDir]),
      runnerEntrypoint: envList('SARDEENZ_RUNNER_ENTRYPOINT', [
        'python3',
        '-m',
        'sardeenz_vllm_runner',
      ]),
      home: envStr('SARDEENZ_APPTAINER_HOME', `${scratchDir}/home`),
      verifySif: envBool('SARDEENZ_VERIFY_SIF', true),
      // 15 min by default — a large model's weight load + KV-cache alloc can take several minutes;
      // the worker keeps polling the runner's /health until then before declaring the start failed.
      healthTimeoutMs: envInt('SARDEENZ_HEALTH_TIMEOUT_MS', 900000),
      healthIntervalMs: envInt('SARDEENZ_HEALTH_INTERVAL_MS', 1000),
      // Larger than the in-SIF shim's own drain budget so the graceful stop (which reaps vLLM's
      // separate session) completes before the SIGKILL backstop — see apptainer-launcher.ts.
      stopGraceMs: envInt('SARDEENZ_STOP_GRACE_MS', 30000),
      advertiseHost: envStr('SARDEENZ_WORKER_ADVERTISE_HOST', 'localhost'),
    },
  };
}
