import type { DevWorkerConfig } from './config.js';
import type { WorkerRegistration } from './registration.js';
import type { LaunchHandle, LogSink, RunnerLauncher } from './launcher.js';
import { StubLauncher } from './stub-launcher.js';
import { RunnerLogBuffer } from './runner-log-buffer.js';
import { randomUUID } from 'node:crypto';
import { createServer as netCreateServer } from 'node:net';

/** One instance's ledger-simulated bytes on one device — see getLedgerInstanceShares(). */
export interface LedgerInstanceShare {
  instanceId: string;
  modelName: string;
  deviceIndex: number;
  bytes: number;
}

// Tries to bind 127.0.0.1:port; resolves true if the port is free, false if already in use.
export function probePortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = netCreateServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

export interface RunnerRecord {
  runnerId: string;
  instanceId: string;
  modelName: string;
  /** Management port (runner-contract API). */
  port: number;
  /** Inference port (`/v1/*`) the proxy targets — equals `port` for the single-server stub. */
  enginePort: number;
  host: string;
  requiredMemory: number;
  devices: { deviceIndex: number; deviceType: string }[];
  handle: LaunchHandle;
}

export interface StartRunnerParams {
  modelName: string;
  /**
   * Control-plane-assigned instance identity (#120). Disambiguates replicas of the same model on
   * this worker — the sole conflict/lookup key, replacing the pre-#120 one-runner-per-model rule.
   * The route layer generates a fallback when the caller omits it (older/back-compat callers);
   * the control plane always sends one.
   */
  instanceId: string;
  runnerType: string;
  modelPath: string;
  requiredMemory: number;
  deviceType?: string;
  tensorParallel: number;
  runtimeModule?: string;
  engineConfig?: Record<string, unknown>;
  engineArgs?: string[];
  /** Optional engine-reported model identity (ADR-020); passed through to the launcher. */
  servedModelName?: string;
  /** Optional verbatim argv from catalog metadata (#125); passed through to the launcher. */
  entrypoint?: string[];
  devices: { deviceIndex: number; deviceType: string }[];
}

export class RunnerManager {
  private readonly runners = new Map<string, RunnerRecord>();
  // modelName -> runnerIds. A Set, not a single id, because #120 allows N replicas of one model
  // on this worker; insertion order is preserved (JS Set iteration order), which
  // getRunnerIdForModel relies on to return the most-recently-started runner.
  private readonly modelRunners = new Map<string, Set<string>>();
  // instanceId -> runnerId. The unambiguous lookup/conflict key — unlike modelName, an instanceId
  // identifies exactly one runner even with replicas.
  private readonly instanceRunners = new Map<string, string>();
  private readonly launcher: RunnerLauncher;
  private readonly logBuffer: RunnerLogBuffer;
  private readonly usedPorts = new Set<number>();
  private readonly probePort?: (port: number) => Promise<boolean>;
  // Serializes cold-starts when the launcher requires it (real engine cold-starts spike host RAM
  // and OOM a peer if run concurrently — spike Gate 9c). A promise chain acts as an async mutex.
  private coldStartChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly config: DevWorkerConfig,
    private readonly registration: WorkerRegistration,
    launcher?: RunnerLauncher,
    logBuffer?: RunnerLogBuffer,
    probePort?: (port: number) => Promise<boolean>,
    private readonly fetchFn: typeof fetch = globalThis.fetch,
  ) {
    this.launcher = launcher ?? new StubLauncher(config);
    this.logBuffer = logBuffer ?? new RunnerLogBuffer();
    this.probePort = probePort;
  }

  getLogBuffer(): RunnerLogBuffer {
    return this.logBuffer;
  }

  async startRunner(
    params: StartRunnerParams,
  ): Promise<{ runnerId: string; host: string; port: number; enginePort: number }> {
    if (this.instanceRunners.has(params.instanceId)) {
      throw new ConflictError(`Runner for instance ${params.instanceId} already exists`);
    }

    const runnerId = `runner-${randomUUID().slice(0, 8)}`;
    const { port, enginePort } = await this.allocatePorts();

    // Reserve the instance slot up-front so concurrent starts of the same instance race to
    // ConflictError rather than both proceeding. Also register under modelName — a Set now
    // (#120), since several instances of the same model may run concurrently on this worker.
    this.instanceRunners.set(params.instanceId, runnerId);
    let modelRunnerIds = this.modelRunners.get(params.modelName);
    if (!modelRunnerIds) {
      modelRunnerIds = new Set();
      this.modelRunners.set(params.modelName, modelRunnerIds);
    }
    modelRunnerIds.add(runnerId);

    // Post-startup supervision: if the runner's process exits on its own (crash, OOM-kill, etc.)
    // rather than via a deliberate stopRunner(), reap its record and free its device memory so a
    // dead runner doesn't leave a phantom VRAM reservation. Guarded on `this.runners.has` so this
    // no-ops when stopRunner() has already removed the record before calling handle.stop() (see
    // stopRunner's ordering below) — otherwise a deliberate stop would double-free memory.
    const handleUnexpectedExit = (): void => {
      if (!this.runners.has(runnerId)) return;
      const record = this.runners.get(runnerId)!;
      for (const device of record.devices) {
        const perDeviceMemory = Math.floor(record.requiredMemory / record.devices.length);
        this.registration.freeMemory(device.deviceIndex, perDeviceMemory);
      }
      this.runners.delete(runnerId);
      this.usedPorts.delete(record.port);
      this.instanceRunners.delete(record.instanceId);
      this.modelRunners.get(record.modelName)?.delete(runnerId);
      if (this.modelRunners.get(record.modelName)?.size === 0) {
        this.modelRunners.delete(record.modelName);
      }
      this.logBuffer.markEnded(runnerId);
      this.logBuffer.retain(runnerId);
      console.log(
        `[worker] Runner ${runnerId} (${params.modelName}/${params.instanceId}) exited unexpectedly — cleaned up`,
      );
    };

    try {
      const handle = await this.launch(
        {
          runnerId,
          modelName: params.modelName,
          modelPath: params.modelPath,
          runnerType: params.runnerType || this.config.runnerType,
          runtimeModule: params.runtimeModule,
          deviceType: params.deviceType || this.config.deviceType,
          requiredMemory: params.requiredMemory,
          tensorParallel: params.tensorParallel,
          engineConfig: params.engineConfig,
          engineArgs: params.engineArgs,
          servedModelName: params.servedModelName,
          entrypoint: params.entrypoint,
          devices: params.devices,
          port,
          enginePort,
        },
        (stream, content) => this.logBuffer.append(runnerId, stream, content),
        // Once the engine has finished starting, end the launch-log stream: connected viewers stop
        // streaming and the buffered startup logs are sealed for later "View starting logs" reopens,
        // so post-startup request logs never reach the control plane. The buffer is kept until the
        // runner is stopped (drop() in stopRunner).
        () => this.logBuffer.markEnded(runnerId),
        handleUnexpectedExit,
      );

      const record: RunnerRecord = {
        runnerId,
        instanceId: params.instanceId,
        modelName: params.modelName,
        port: handle.port,
        enginePort: handle.enginePort,
        host: handle.host,
        requiredMemory: params.requiredMemory,
        devices: params.devices,
        handle,
      };
      this.runners.set(runnerId, record);

      for (const device of params.devices) {
        const perDeviceMemory = Math.floor(params.requiredMemory / params.devices.length);
        this.registration.allocateMemory(device.deviceIndex, perDeviceMemory);
      }

      console.log(
        `[worker] Started runner ${runnerId} for ${params.modelName}/${params.instanceId} on ${handle.host}:${handle.port}` +
          (handle.enginePort !== handle.port ? ` (inference on :${handle.enginePort})` : ''),
      );

      return { runnerId, host: handle.host, port: handle.port, enginePort: handle.enginePort };
    } catch (err) {
      // Roll back the reserved instance/model slots so a failed start doesn't permanently block
      // either the instance id or (transitively) the model.
      this.usedPorts.delete(port);
      this.instanceRunners.delete(params.instanceId);
      this.modelRunners.get(params.modelName)?.delete(runnerId);
      if (this.modelRunners.get(params.modelName)?.size === 0) {
        this.modelRunners.delete(params.modelName);
      }
      // Seal the launch-log stream (any SSE client attached mid-launch gets its `end` frame) and
      // schedule the buffer for later cleanup — there's no stopRunner() call for a failed launch to
      // drop() it, so without retain() the failure logs (and their listeners) would leak forever.
      this.logBuffer.markEnded(runnerId);
      this.logBuffer.retain(runnerId);
      throw err;
    }
  }

  // Run the launcher, serializing cold-starts when the launcher requires it.
  private launch(
    spec: Parameters<RunnerLauncher['start']>[0],
    onLog?: LogSink,
    onStartupComplete?: () => void,
    onExit?: () => void,
  ): Promise<LaunchHandle> {
    if (!this.launcher.serializeColdStarts) {
      return this.launcher.start(spec, onLog, onStartupComplete, onExit);
    }
    const result = this.coldStartChain.then(() =>
      this.launcher.start(spec, onLog, onStartupComplete, onExit),
    );
    // Keep the chain alive regardless of this start's success/failure.
    this.coldStartChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async stopRunner(runnerId: string): Promise<void> {
    const record = this.runners.get(runnerId);
    if (!record) {
      throw new NotFoundError(`Runner ${runnerId} not found`);
    }

    // Remove the record and free memory BEFORE stopping the process: the process exiting in
    // response to stop() fires the launcher's post-startup supervision callback
    // (handleUnexpectedExit in startRunner), which guards on `this.runners.has(runnerId)` — clearing
    // the record here first makes that guard a no-op so a deliberate stop doesn't double-free memory.
    this.runners.delete(runnerId);
    this.usedPorts.delete(record.port);
    this.instanceRunners.delete(record.instanceId);
    this.modelRunners.get(record.modelName)?.delete(runnerId);
    if (this.modelRunners.get(record.modelName)?.size === 0) {
      this.modelRunners.delete(record.modelName);
    }

    for (const device of record.devices) {
      const perDeviceMemory = Math.floor(record.requiredMemory / record.devices.length);
      this.registration.freeMemory(device.deviceIndex, perDeviceMemory);
    }

    await record.handle.stop();

    // Signal any connected SSE clients that the stream is over before dropping the buffer —
    // otherwise a client's `end` frame would race a listener set already cleared by drop().
    this.logBuffer.markEnded(runnerId);
    this.logBuffer.drop(runnerId);

    console.log(`[worker] Stopped runner ${runnerId} (${record.modelName}/${record.instanceId})`);
  }

  async stopAll(): Promise<void> {
    // Stop concurrently: cold-start serialization is a start-time constraint, not a stop-time one,
    // and draining runners in series would let total teardown exceed the pod's grace period when a
    // worker hosts several runners. Each stopRunner touches distinct map keys, so this is safe.
    const runnerIds = Array.from(this.runners.keys());
    await Promise.all(runnerIds.map((runnerId) => this.stopRunner(runnerId)));
  }

  getRunner(runnerId: string): RunnerRecord | undefined {
    return this.runners.get(runnerId);
  }

  // Resolve the runnerId for a model. Unlike getRunner() (backed by the `runners` map, which is
  // only populated once a cold-start is *healthy*), this reads `modelRunners`, which is set the
  // instant startRunner() is entered — so a runner's logs are addressable during cold-start, which
  // is exactly the window the deploy modal wants to stream. With replicas (#120), several runners
  // may serve the same model name on this worker — returns the *most recently started* one (Set
  // iteration order is insertion order in JS), matching the by-model logs route's documented
  // ambiguity. Use getRunnerIdForInstance to address a specific replica unambiguously.
  getRunnerIdForModel(modelName: string): string | undefined {
    const ids = this.modelRunners.get(modelName);
    if (!ids || ids.size === 0) return undefined;
    let last: string | undefined;
    for (const id of ids) last = id;
    return last;
  }

  // Resolve the runnerId for a specific instance — unambiguous even with replicas of the same
  // model on this worker. Like getRunnerIdForModel, set the instant startRunner() is entered.
  getRunnerIdForInstance(instanceId: string): string | undefined {
    return this.instanceRunners.get(instanceId);
  }

  getAllRunners(): RunnerRecord[] {
    return Array.from(this.runners.values());
  }

  // Runners whose launcher recorded a process PID (the ApptainerLauncher; the StubLauncher never
  // sets handle.pid). Used to attribute NVML-reported GPU processes back to a runner instance — the
  // NVML PID is a descendant of handle.pid (apptainer exec -> shim -> engine), so callers walk the
  // parent chain (see proc-tree.ts) rather than comparing PIDs directly.
  getRunnerProcesses(): Array<{ pid: number; instanceId: string; modelName: string }> {
    const out: Array<{ pid: number; instanceId: string; modelName: string }> = [];
    for (const record of this.runners.values()) {
      if (record.handle.pid !== undefined) {
        out.push({
          pid: record.handle.pid,
          instanceId: record.instanceId,
          modelName: record.modelName,
        });
      }
    }
    return out;
  }

  // Simulates per-instance measured bytes for the worker's memory report when NVML isn't available
  // (stub mode / CPU-only host), by querying each running runner's own `/memory-report` endpoint —
  // part of the runner contract every launcher implements (see
  // packages/contracts/specs/engine-runner.yaml). Reusing that endpoint, rather than re-deriving
  // sleep state here, is what makes a sleeping runner correctly contribute nothing: the runner's
  // own /memory-report already reports 0 while SLEEPING (runner-stub/routes/memory.ts). A runner
  // whose query fails (unreachable, still starting, in ERROR state, non-2xx) contributes no
  // entries rather than a stale guess — this method never rejects.
  async getLedgerInstanceShares(): Promise<LedgerInstanceShare[]> {
    const records = Array.from(this.runners.values());
    const perRunner = await Promise.all(
      records.map(async (record): Promise<LedgerInstanceShare[]> => {
        try {
          // Timeout so a hung runner (socket accepted, response never sent) can't pend this
          // Promise.all forever — that would freeze the heartbeat's memory-report push and
          // eventually mark the whole worker's budget stale on the control plane.
          const res = await this.fetchFn(`http://127.0.0.1:${record.port}/memory-report`, {
            signal: AbortSignal.timeout(2000),
          });
          if (!res.ok) return [];
          const body = (await res.json()) as {
            devices?: Array<{ deviceIndex: number; memoryUsedBytes: number }>;
          };
          return (body.devices ?? [])
            .filter((d) => d.memoryUsedBytes > 0) // sleeping (or otherwise idle) runners hold nothing
            .map((d) => ({
              instanceId: record.instanceId,
              modelName: record.modelName,
              deviceIndex: d.deviceIndex,
              bytes: d.memoryUsedBytes,
            }));
        } catch {
          return [];
        }
      }),
    );
    return perRunner.flat();
  }

  // Allocate a (management, engine) port pair, stepping by 2. Real engines (vLLM) serve inference
  // on `management + 1`, so allocating one port per runner would let a second runner's management
  // port collide with the first runner's engine port. Pairing avoids that regardless of launcher;
  // single-server launchers (the stub) simply leave the engine port of the pair unused.
  //
  // Scans for the lowest free pair in [runnerPortStart, runnerPortStart + maxRunners * 2) rather
  // than a monotonic counter, so ports released by stopRunner()/crash cleanup get reused instead of
  // exhausting the range over a worker's lifetime.
  private async allocatePorts(): Promise<{ port: number; enginePort: number }> {
    const rangeEnd = this.config.runnerPortStart + this.config.maxRunners * 2;
    for (let base = this.config.runnerPortStart; base < rangeEnd; base += 2) {
      if (this.usedPorts.has(base)) continue;
      if (base === this.config.workerPort || base + 1 === this.config.workerPort) continue;
      this.usedPorts.add(base);
      if (this.probePort) {
        const free = (await this.probePort(base)) && (await this.probePort(base + 1));
        if (!free) {
          this.usedPorts.delete(base);
          continue;
        }
      }
      return { port: base, enginePort: base + 1 };
    }
    throw new Error(
      `Port range exhausted: all ${this.config.maxRunners} runner slots in ` +
        `[${this.config.runnerPortStart}, ${rangeEnd}) are in use`,
    );
  }
}

export class ConflictError extends Error {
  readonly statusCode = 409;
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

export class NotFoundError extends Error {
  readonly statusCode = 404;
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}
