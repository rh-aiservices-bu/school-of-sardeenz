import { spawn as nodeSpawn } from 'node:child_process';
import type { LaunchHandle, LaunchSpec, LogSink, RunnerLauncher } from './launcher.js';

// Production launcher: `apptainer exec`s an engine SIF from the shared module volume.
//
// Traceable to the Phase 4 spike:
//   - caches redirected to node-local /scratch (the SIF's baked cache dirs are read-only) — Gate 9d
//   - HOME on writable /scratch/home, set as a *process* env, never `--env HOME=…` (Apptainer
//     rejects it) — spike finding
//   - --nv only for CUDA devices; CUDA_VISIBLE_DEVICES scopes the assigned GPUs — Gate 7/9
//   - cold-starts are serialized by the RunnerManager (serializeColdStarts) — Gate 9c
//   - SIGTERM propagates to the exec'd process; stop() waits then SIGKILLs — Gate 5
//   - the SIF signature is verified before exec — ADR-017 / acceptance criteria

export interface ApptainerLauncherConfig {
  apptainerBin: string;
  modulesDir: string;
  weightsDir: string;
  scratchDir: string;
  /** Extra paths bind-mounted into the container. Weights + scratch must be here. */
  binds: string[];
  /** Entrypoint invoked inside the SIF (the runner-contract shim). */
  runnerEntrypoint: string[];
  /** Writable HOME on node-local scratch (spike finding — set as process env, not `--env`). */
  home: string;
  /** Run `apptainer verify <sif>` before exec and refuse unsigned/tampered SIFs. */
  verifySif: boolean;
  healthTimeoutMs: number;
  healthIntervalMs: number;
  stopGraceMs: number;
}

export const DEFAULT_APPTAINER_CONFIG: ApptainerLauncherConfig = {
  apptainerBin: 'apptainer',
  modulesDir: '/modules',
  weightsDir: '/weights',
  scratchDir: '/scratch',
  binds: ['/weights', '/scratch'],
  runnerEntrypoint: ['python3', '-m', 'sardeenz_vllm_runner'],
  home: '/scratch/home',
  verifySif: true,
  // 15 min — large models can take several minutes to load; see config.ts SARDEENZ_HEALTH_TIMEOUT_MS.
  healthTimeoutMs: 900_000,
  // Must exceed the in-SIF shim's own shutdown budget (uvicorn drain + its 15s vLLM process-group
  // stop) so the graceful path — which is the only one that reaps vLLM's separate session — can
  // finish before this SIGKILL backstop fires. The pod cgroup is the ultimate backstop if the
  // shim itself wedges.
  healthIntervalMs: 1_000,
  stopGraceMs: 30_000,
};

// Minimal child-process surface the launcher relies on — lets tests inject a fake.
export interface ChildHandle {
  readonly pid?: number;
  readonly exitCode?: number | null;
  /** Present when spawned with stdio piped (the default spawn); absent for injected fakes that
   * don't need log capture. */
  readonly stdout?: NodeJS.ReadableStream;
  readonly stderr?: NodeJS.ReadableStream;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: 'exit', listener: () => void): unknown;
  once(event: 'error', listener: (err: Error) => void): unknown;
}

export type SpawnFn = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv },
) => ChildHandle;

// stdout/stderr piped (not inherited) so the launcher can capture them into the RunnerLogBuffer;
// stdin stays 'ignore' — the runner entrypoint never reads from it.
const defaultSpawn: SpawnFn = (command, args, options) =>
  nodeSpawn(command, args, { env: options.env, stdio: ['ignore', 'pipe', 'pipe'] });

export type RunOnceFn = (command: string, args: string[]) => Promise<number>;

/** The runner's reported health, as returned by its `/health` endpoint. */
export interface HealthProbe {
  state: string;
  message?: string;
}
/** Probe a runner's `/health`. Resolves the reported state, or null if unreachable/not-ok yet. */
export type HealthCheckFn = (url: string) => Promise<HealthProbe | null>;
export type SleepFn = (ms: number) => Promise<void>;
export type NowFn = () => number;

export interface ApptainerLauncherDeps {
  spawn?: SpawnFn;
  /** Runs a command to completion, resolving its exit code (used for `apptainer verify`). */
  runOnce?: RunOnceFn;
  healthCheck?: HealthCheckFn;
  sleep?: SleepFn;
  now?: NowFn;
}

export interface ExecPlan {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  sifPath: string;
}

const defaultRunOnce: RunOnceFn = (command, args) =>
  new Promise((resolve, reject) => {
    const child = nodeSpawn(command, args, { stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? -1));
  });

const defaultHealthCheck: HealthCheckFn = async (url) => {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const body = (await res.json()) as { state?: string; message?: string };
    return { state: body.state ?? 'UNKNOWN', message: body.message };
  } catch {
    return null;
  }
};

const defaultSleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class ApptainerLauncher implements RunnerLauncher {
  readonly serializeColdStarts = true;

  private readonly spawn: SpawnFn;
  private readonly runOnce: RunOnceFn;
  private readonly healthCheck: HealthCheckFn;
  private readonly sleep: SleepFn;
  private readonly now: NowFn;

  constructor(
    private readonly config: ApptainerLauncherConfig,
    deps: ApptainerLauncherDeps = {},
  ) {
    this.spawn = deps.spawn ?? defaultSpawn;
    this.runOnce = deps.runOnce ?? defaultRunOnce;
    this.healthCheck = deps.healthCheck ?? defaultHealthCheck;
    this.sleep = deps.sleep ?? defaultSleep;
    this.now = deps.now ?? (() => Date.now());
  }

  // Resolve which SIF to exec. Prefer the explicit runtimeModule; fall back to
  // `<runnerType>-<engineConfig.version>`; a production start must resolve to a SIF.
  resolveSifPath(spec: LaunchSpec): string {
    const module = this.resolveModule(spec);
    return `${this.config.modulesDir}/${module}.sif`;
  }

  private resolveModule(spec: LaunchSpec): string {
    const module =
      spec.runtimeModule ??
      (typeof spec.engineConfig?.version === 'string' && spec.engineConfig.version.length > 0
        ? `${spec.runnerType}-${spec.engineConfig.version}`
        : undefined);
    if (module === undefined) {
      throw new Error(
        `Cannot resolve a runtime module for runner ${spec.runnerId}: ` +
          `set 'runtimeModule' (e.g. "vllm-0.21") or engineConfig.version`,
      );
    }
    // Guard against path traversal — the module becomes a filename segment under modulesDir.
    if (!/^[A-Za-z0-9_.-]+$/.test(module)) {
      throw new Error(
        `Invalid runtime module '${module}' (allowed: A-Z a-z 0-9 . _ -); refusing to build a SIF path`,
      );
    }
    return module;
  }

  // Pure command construction — no side effects, unit-tested directly.
  buildExecPlan(spec: LaunchSpec): ExecPlan {
    const sifPath = this.resolveSifPath(spec);
    const cacheDir = `${this.config.scratchDir}/cache`;

    // --cleanenv: do NOT leak the worker agent's environment (Redis URL, other config) into the
    // engine, and avoid host PATH/PYTHONPATH/LD_LIBRARY_PATH bleeding into the guest. Everything
    // the runner needs is passed explicitly via --env below (HOME is handled by Apptainer itself).
    const args: string[] = ['exec', '--cleanenv'];
    const useNv = spec.deviceType?.toUpperCase() === 'CUDA';
    if (useNv) args.push('--nv');

    for (const bind of this.config.binds) {
      args.push('--bind', bind);
    }

    const envFlags: Record<string, string> = {
      XDG_CACHE_HOME: cacheDir,
      HF_HOME: `${cacheDir}/huggingface`,
      FLASHINFER_WORKSPACE_DIR: `${cacheDir}/flashinfer`,
      ENABLE_KVCACHED: 'true',
      KVCACHED_AUTOPATCH: '1',
    };
    if (useNv) {
      envFlags.CUDA_VISIBLE_DEVICES = spec.devices.map((d) => d.deviceIndex).join(',');
      envFlags.SARDEENZ_DEVICE_INDICES = spec.devices.map((d) => d.deviceIndex).join(',');
    }
    // NOTE: HOME is deliberately NOT an `--env` flag — Apptainer rejects it. It is passed as a
    // process env var below so the container inherits a writable HOME on node-local scratch.
    for (const [key, value] of Object.entries(envFlags)) {
      args.push('--env', `${key}=${value}`);
    }

    args.push(sifPath, ...this.config.runnerEntrypoint);
    args.push('--model', spec.modelPath, '--port', String(spec.port));
    // Pin the engine's OpenAI port explicitly to the worker-allocated engine port rather than
    // relying on the shim's `--port + 1` default — the RunnerManager allocates management/engine
    // ports in pairs and must know exactly where inference is served to report it to the proxy.
    args.push('--engine-port', String(spec.enginePort));
    // Forward `--served-model-name` to `vllm serve` via the shim's `--` passthrough so vLLM
    // registers the model under the routing name (not its weights path) and client `model` fields
    // resolve — otherwise inference that reaches the engine 404s with "model does not exist". Using
    // the passthrough (rather than a dedicated shim flag) keeps this working with already-built SIFs,
    // whose baked-in shim CLI wouldn't recognise a new flag. Must come last: everything after `--`
    // goes to vLLM.
    args.push('--', '--served-model-name', spec.modelName);

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: this.config.home,
      APPTAINER_HOME: `${this.config.home}:${this.config.home}`,
    };

    return { command: this.config.apptainerBin, args, env, sifPath };
  }

  async start(
    spec: LaunchSpec,
    onLog?: LogSink,
    onStartupComplete?: () => void,
  ): Promise<LaunchHandle> {
    const plan = this.buildExecPlan(spec);

    // Trace the resolved SIF + exec so a stuck/failed cold-start is diagnosable (the two most
    // common failures — missing SIF and failed signature verify — both surface right here).
    console.log(
      `[worker] apptainer exec for ${spec.modelName}: ${plan.command} ${plan.args.join(' ')}`,
    );

    if (this.config.verifySif) {
      const code = await this.runOnce(this.config.apptainerBin, ['verify', plan.sifPath]);
      if (code !== 0) {
        throw new Error(
          `SIF signature verification failed for ${plan.sifPath} (apptainer verify exited ${code})`,
        );
      }
    }

    const child = this.spawn(plan.command, plan.args, { env: plan.env });

    // Forward captured output to `onLog` only until the runner finishes starting; after that we keep
    // reading (draining) the streams — a full stdio pipe would block the engine — but stop
    // forwarding, so post-startup request logs never reach the launch-log buffer. The listeners stay
    // attached for draining; `capturing` gates forwarding. Fake launchers injected by tests may not
    // expose stdout/stderr — the optional chaining guards that.
    let capturing = true;
    child.stdout?.on('data', (chunk: Buffer) => {
      if (capturing && onLog) onLog('stdout', chunk.toString());
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (capturing && onLog) onLog('stderr', chunk.toString());
    });

    // If the exec dies before becoming healthy, surface it instead of hanging on the health poll.
    let exited = false;
    const onExit = (): void => {
      exited = true;
    };
    child.once('exit', onExit);
    child.once('error', onExit);

    const handle: LaunchHandle = {
      host: '127.0.0.1',
      port: spec.port,
      enginePort: spec.enginePort,
      pid: child.pid,
      stop: () => this.stopChild(child),
    };

    try {
      await this.waitUntilHealthy(spec.port, () => exited);
    } catch (err) {
      // Only tear down a still-running exec; if it already died, there is nothing to signal.
      if (!exited) await this.stopChild(child).catch(() => {});
      throw err;
    }

    // Runner is serving and its startup output is fully captured — stop forwarding further output
    // (request logs) and signal the manager to seal/end the launch-log stream. vLLM's
    // "Application startup complete" prints before its /health returns 200, so it's already buffered.
    capturing = false;
    onStartupComplete?.();

    return handle;
  }

  private async waitUntilHealthy(port: number, hasExited: () => boolean): Promise<void> {
    const url = `http://127.0.0.1:${port}/health`;
    const deadline = this.now() + this.config.healthTimeoutMs;
    while (this.now() < deadline) {
      if (hasExited()) {
        throw new Error(`Runner on :${port} exited before becoming healthy`);
      }
      const probe = await this.healthCheck(url);
      if (probe) {
        if (probe.state === 'READY') return;
        // Fail fast: the runner reached a terminal error state (e.g. vLLM failed to load the model)
        // — don't keep polling until the health timeout when we already know it won't recover.
        if (probe.state === 'ERROR') {
          throw new Error(
            `Runner on :${port} reported ERROR while starting` +
              (probe.message ? `: ${probe.message}` : ''),
          );
        }
      }
      await this.sleep(this.config.healthIntervalMs);
    }
    throw new Error(
      `Runner on :${port} did not become healthy within ${this.config.healthTimeoutMs}ms`,
    );
  }

  // SIGTERM, then SIGKILL after the grace period if it hasn't exited (spike Gate 5: no orphan).
  private stopChild(child: ChildHandle): Promise<void> {
    return new Promise((resolve) => {
      // Already exited — nothing to signal.
      if (child.exitCode !== null && child.exitCode !== undefined) {
        resolve();
        return;
      }
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        clearTimeout(killTimer);
        resolve();
      };
      child.once('exit', finish);
      child.once('error', finish);
      child.kill('SIGTERM');
      const killTimer = setTimeout(() => {
        child.kill('SIGKILL');
      }, this.config.stopGraceMs);
      // Do not keep the event loop alive solely for the grace timer.
      if (typeof killTimer.unref === 'function') killTimer.unref();
    });
  }
}

export { defaultHealthCheck };
