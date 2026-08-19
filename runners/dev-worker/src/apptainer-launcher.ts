import { spawn as nodeSpawn } from 'node:child_process';
import type { LaunchHandle, LaunchSpec, RunnerLauncher } from './launcher.js';

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
  healthTimeoutMs: 300_000,
  healthIntervalMs: 1_000,
  stopGraceMs: 15_000,
};

// Minimal child-process surface the launcher relies on — lets tests inject a fake.
export interface ChildHandle {
  readonly pid?: number;
  readonly exitCode?: number | null;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: 'exit', listener: () => void): unknown;
  once(event: 'error', listener: (err: Error) => void): unknown;
}

export type SpawnFn = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv },
) => ChildHandle;

export type RunOnceFn = (command: string, args: string[]) => Promise<number>;
export type HealthCheckFn = (url: string) => Promise<boolean>;
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
    if (!res.ok) return false;
    const body = (await res.json()) as { state?: string };
    return body.state === 'READY';
  } catch {
    return false;
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
    this.spawn = deps.spawn ?? nodeSpawn;
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
    if (spec.runtimeModule) return spec.runtimeModule;
    const version = spec.engineConfig?.version;
    if (typeof version === 'string' && version.length > 0) {
      return `${spec.runnerType}-${version}`;
    }
    throw new Error(
      `Cannot resolve a runtime module for runner ${spec.runnerId}: ` +
        `set 'runtimeModule' (e.g. "vllm-0.21") or engineConfig.version`,
    );
  }

  // Pure command construction — no side effects, unit-tested directly.
  buildExecPlan(spec: LaunchSpec): ExecPlan {
    const sifPath = this.resolveSifPath(spec);
    const cacheDir = `${this.config.scratchDir}/cache`;

    const args: string[] = ['exec'];
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
    }
    // NOTE: HOME is deliberately NOT an `--env` flag — Apptainer rejects it. It is passed as a
    // process env var below so the container inherits a writable HOME on node-local scratch.
    for (const [key, value] of Object.entries(envFlags)) {
      args.push('--env', `${key}=${value}`);
    }

    args.push(sifPath, ...this.config.runnerEntrypoint);
    args.push('--model', spec.modelPath, '--port', String(spec.port));

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: this.config.home,
      APPTAINER_HOME: `${this.config.home}:${this.config.home}`,
    };

    return { command: this.config.apptainerBin, args, env, sifPath };
  }

  async start(spec: LaunchSpec): Promise<LaunchHandle> {
    const plan = this.buildExecPlan(spec);

    if (this.config.verifySif) {
      const code = await this.runOnce(this.config.apptainerBin, ['verify', plan.sifPath]);
      if (code !== 0) {
        throw new Error(
          `SIF signature verification failed for ${plan.sifPath} (apptainer verify exited ${code})`,
        );
      }
    }

    const child = this.spawn(plan.command, plan.args, { env: plan.env });

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

    return handle;
  }

  private async waitUntilHealthy(port: number, hasExited: () => boolean): Promise<void> {
    const url = `http://127.0.0.1:${port}/health`;
    const deadline = this.now() + this.config.healthTimeoutMs;
    while (this.now() < deadline) {
      if (hasExited()) {
        throw new Error(`Runner on :${port} exited before becoming healthy`);
      }
      if (await this.healthCheck(url)) return;
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
