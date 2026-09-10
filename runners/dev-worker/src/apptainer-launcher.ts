import { spawn as nodeSpawn } from 'node:child_process';
import { realpath as nodeRealpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import type { LaunchHandle, LaunchSpec, LogSink, RunnerLauncher } from './launcher.js';

// Flags the platform owns via dedicated StartRunnerRequest fields / shim args. A user-supplied
// copy in engineArgs would collide (last-flag-wins could move the engine to the wrong port, or
// duplicate --tensor-parallel-size the shim already emits). Rejected before spawn (#126).
const RESERVED_ENGINE_FLAGS = new Set([
  '--port',
  '--host',
  '--model',
  '--served-model-name',
  '--tensor-parallel-size',
  '--engine-port',
]);

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
  /** Address advertised in the launch handle's `host` (control-plane-reachable). */
  advertiseHost: string;
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
  advertiseHost: 'localhost',
};

// Minimal child-process surface the launcher relies on — lets tests inject a fake.
export interface ChildHandle {
  readonly pid?: number;
  readonly exitCode?: number | null;
  readonly signalCode?: NodeJS.Signals | null;
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
  /** Resolves symlinks (used to catch symlink escapes in modelPath); injectable for tests. */
  realpath?: RealpathFn;
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

export type RealpathFn = (path: string) => Promise<string>;

const defaultRealpath: RealpathFn = (path) => nodeRealpath(path);

export class ApptainerLauncher implements RunnerLauncher {
  readonly serializeColdStarts = true;

  private readonly spawn: SpawnFn;
  private readonly runOnce: RunOnceFn;
  private readonly healthCheck: HealthCheckFn;
  private readonly sleep: SleepFn;
  private readonly now: NowFn;
  private readonly realpath: RealpathFn;

  constructor(
    private readonly config: ApptainerLauncherConfig,
    deps: ApptainerLauncherDeps = {},
  ) {
    this.spawn = deps.spawn ?? defaultSpawn;
    this.runOnce = deps.runOnce ?? defaultRunOnce;
    this.healthCheck = deps.healthCheck ?? defaultHealthCheck;
    this.sleep = deps.sleep ?? defaultSleep;
    this.now = deps.now ?? (() => Date.now());
    this.realpath = deps.realpath ?? defaultRealpath;
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

  // Guards against a modelPath that escapes the configured weights directory — either
  // syntactically (`..` traversal, a relative path) or via a symlink planted inside the weights
  // dir that resolves outside it. The control plane validates modelPath at deploy time too, but
  // the worker cannot trust that a request reaching it actually came through that check.
  private async validateModelPath(modelPath: string): Promise<void> {
    if (!modelPath.startsWith('/')) {
      throw new Error(`modelPath must be an absolute path: ${modelPath}`);
    }
    const root = resolve(this.config.weightsDir);
    const resolved = resolve(modelPath);
    // Must be a strict child of the root — the bare root itself isn't a launchable model dir.
    if (!resolved.startsWith(root + sep)) {
      throw new Error(`modelPath escapes the weights root ${root}: ${modelPath}`);
    }

    let real: string;
    try {
      real = await this.realpath(resolved);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`modelPath does not exist: ${modelPath}`);
      }
      throw err;
    }
    if (!real.startsWith(root + sep)) {
      throw new Error(
        `modelPath resolves outside the weights root ${root} via a symlink: ${modelPath}`,
      );
    }
  }

  // Pure command construction — no side effects, unit-tested directly.
  async buildExecPlan(spec: LaunchSpec): Promise<ExecPlan> {
    await this.validateModelPath(spec.modelPath);
    const sifPath = this.resolveSifPath(spec);
    const cacheDir = `${this.config.scratchDir}/cache`;

    // --cleanenv: do NOT leak the worker agent's environment (Redis URL, other config) into the
    // engine, and avoid host PATH/PYTHONPATH/LD_LIBRARY_PATH bleeding into the guest. Everything
    // the runner needs is passed explicitly via --env below (HOME is handled by Apptainer itself).
    // Note: --cleanenv does NOT block APPTAINERENV_*/SINGULARITYENV_* — Apptainer injects those
    // into the guest regardless, so they are stripped from the spawned process's env below.
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
      // MLServer's gRPC/metrics servers bind even in REST-only use; pass explicit ports from the
      // worker's 4-port block so the shim never derives them via +10000/+20000 (and never trips the
      // 65535 ceiling). vLLM ignores these. (#160)
      SARDEENZ_MLSERVER_GRPC_PORT: String(spec.grpcPort),
      SARDEENZ_MLSERVER_METRICS_PORT: String(spec.metricsPort),
    };
    // vLLM 0.24 may select Model Runner V2 by default, but kvcached's autopatch targets Model
    // Runner V1. Pass this explicitly as well as baking it into the SIF so already-published 0.24
    // modules become usable as soon as the worker is upgraded.
    if (sifPath.endsWith('/vllm-0.24.sif')) {
      envFlags.VLLM_USE_V2_MODEL_RUNNER = '0';
    }
    if (useNv) {
      envFlags.CUDA_VISIBLE_DEVICES = spec.devices.map((d) => d.deviceIndex).join(',');
      envFlags.SARDEENZ_DEVICE_INDICES = spec.devices.map((d) => d.deviceIndex).join(',');
    }
    // NOTE: HOME is deliberately NOT an `--env` flag — Apptainer rejects it. It is passed as a
    // process env var below so the container inherits a writable HOME on node-local scratch.
    for (const [key, value] of Object.entries(envFlags)) {
      args.push('--env', `${key}=${value}`);
    }

    args.push(
      sifPath,
      ...(spec.entrypoint && spec.entrypoint.length
        ? spec.entrypoint
        : this.config.runnerEntrypoint),
    );
    args.push('--model', spec.modelPath, '--port', String(spec.port));
    // Pin the engine's OpenAI port explicitly to the worker-allocated engine port rather than
    // relying on the shim's `--port + 1` default — the RunnerManager allocates management/engine
    // ports in pairs and must know exactly where inference is served to report it to the proxy.
    args.push('--engine-port', String(spec.enginePort));
    // Forward tensor-parallel to the shim (before `--`). The shim converts >1 to vLLM's
    // --tensor-parallel-size; without this a tensorParallel:2 deploy silently ran single-GPU (#126).
    if (spec.tensorParallel > 1) {
      args.push('--tensor-parallel', String(spec.tensorParallel));
    }
    // Forward `--served-model-name` to `vllm serve` via the shim's `--` passthrough so vLLM
    // registers the model under the routing name (not its weights path) and client `model` fields
    // resolve — otherwise inference that reaches the engine 404s with "model does not exist". Using
    // the passthrough (rather than a dedicated shim flag) keeps this working with already-built SIFs,
    // whose baked-in shim CLI wouldn't recognise a new flag. Must come last: everything after `--`
    // goes to vLLM. When `servedModelName` is set and differs from `modelName`, both names are
    // emitted with the served name first — vLLM's first-name semantics make the engine report the
    // served name in the response `model` field and the Prometheus `model_name` tag, while still
    // accepting the configuration name so forwarded requests resolve (ADR-020). Argv is
    // byte-identical to prior behavior when `servedModelName` is unset or equal to `modelName`.
    const servedNames: string[] =
      spec.servedModelName && spec.servedModelName !== spec.modelName
        ? [spec.servedModelName, spec.modelName]
        : [spec.modelName];
    args.push('--', '--served-model-name', ...servedNames);
    // Verbatim user engine args, appended after --served-model-name so vllm serve receives them
    // (cli.py forwards everything after `--`). Reject reserved flags the platform controls, matching
    // on the key half so `--port=9999` can't slip past. Thrown here (before spawn) so the deploy
    // fails with a clear message instead of a runner on a port the control plane can never reach.
    if (spec.engineArgs?.length) {
      for (const token of spec.engineArgs) {
        if (!token.startsWith('--')) continue;
        const key = token.split('=', 1)[0];
        if (RESERVED_ENGINE_FLAGS.has(key)) {
          throw new Error(
            `Engine arg '${key}' is reserved and controlled by the platform; ` +
              `remove it from engineArgs`,
          );
        }
        // vLLM's CLI is argparse-derived with allow_abbrev=True: an unambiguous prefix of a
        // reserved flag still expands to it (e.g. --hos -> --host, --tensor-parallel ->
        // --tensor-parallel-size), and since engineArgs are appended after the shim's own
        // --host/--port (last-flag-wins), an abbreviation would silently override them (#126
        // review). Only reject when the USER key is a proper prefix of a reserved flag — the
        // reverse (a reserved flag being a prefix of the user's longer, distinct flag, e.g.
        // --model-impl) is never expanded onto the reserved flag by argparse and must stay
        // allowed.
        if (key.length > 2) {
          const abbreviated = [...RESERVED_ENGINE_FLAGS].find(
            (reserved) => reserved !== key && reserved.startsWith(key),
          );
          if (abbreviated) {
            throw new Error(
              `Engine arg '${key}' is an ambiguous abbreviation of reserved flag '${abbreviated}' ` +
                `(vLLM's argparse expands unambiguous prefixes); remove it from engineArgs`,
            );
          }
        }
      }
      args.push(...spec.engineArgs);
    }

    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith('APPTAINERENV_') || key.startsWith('SINGULARITYENV_')) {
        delete env[key];
      }
    }
    env.HOME = this.config.home;
    env.APPTAINER_HOME = `${this.config.home}:${this.config.home}`;

    return { command: this.config.apptainerBin, args, env, sifPath };
  }

  async start(
    spec: LaunchSpec,
    onLog?: LogSink,
    onStartupComplete?: () => void,
    onExit?: () => void,
  ): Promise<LaunchHandle> {
    const plan = await this.buildExecPlan(spec);

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
    const exitHandler = (): void => {
      exited = true;
    };
    child.once('exit', exitHandler);
    child.once('error', exitHandler);

    const handle: LaunchHandle = {
      host: this.config.advertiseHost,
      port: spec.port,
      enginePort: spec.enginePort,
      pid: child.pid,
      stop: () => this.stopChild(child, () => exited),
    };

    try {
      await this.waitUntilHealthy(spec.port, () => exited);
    } catch (err) {
      // Only tear down a still-running exec; if it already died, there is nothing to signal.
      if (!exited) await this.stopChild(child, () => exited).catch(() => {});
      throw err;
    }

    // Runner is serving and its startup output is fully captured — stop forwarding further output
    // (request logs) and signal the manager to seal/end the launch-log stream. vLLM's
    // "Application startup complete" prints before its /health returns 200, so it's already buffered.
    capturing = false;
    onStartupComplete?.();

    // Post-startup supervision: if the runner exits on its own from here on (not via a deliberate
    // stop()), let the manager know so it can reap the record and free device memory instead of
    // leaving a phantom reservation.
    if (onExit) {
      child.once('exit', () => onExit());
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
  private stopChild(child: ChildHandle, hasExited: () => boolean): Promise<void> {
    return new Promise((resolve) => {
      // Already exited — nothing to signal. Covers both a normal exit (exitCode set) and a
      // signal-killed child (exitCode null, signalCode set) — hasExited() tracks either.
      if (hasExited()) {
        resolve();
        return;
      }
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        clearTimeout(killTimer);
        clearTimeout(backstopTimer);
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
      // Backstop: if the child never emits 'exit' at all (e.g. a fake/child whose process group
      // vanished without the event firing), resolve anyway so stop() can't hang forever. Deliberately
      // not unref()'d — a stop() caller waiting on this promise should keep the process alive until
      // it settles.
      const backstopTimer = setTimeout(finish, this.config.stopGraceMs + 5_000);
    });
  }
}

export { defaultHealthCheck };
