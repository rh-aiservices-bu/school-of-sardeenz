import type { DevWorkerConfig } from './config.js';
import type { WorkerRegistration } from './registration.js';
import type { LaunchHandle, LogSink, RunnerLauncher } from './launcher.js';
import { StubLauncher } from './stub-launcher.js';
import { RunnerLogBuffer } from './runner-log-buffer.js';
import { randomUUID } from 'node:crypto';

export interface RunnerRecord {
  runnerId: string;
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
  runnerType: string;
  modelPath: string;
  requiredMemory: number;
  deviceType?: string;
  tensorParallel: number;
  runtimeModule?: string;
  engineConfig?: Record<string, unknown>;
  devices: { deviceIndex: number; deviceType: string }[];
}

export class RunnerManager {
  private readonly runners = new Map<string, RunnerRecord>();
  private readonly modelToRunner = new Map<string, string>();
  private readonly launcher: RunnerLauncher;
  private readonly logBuffer: RunnerLogBuffer;
  private nextPort: number;
  // Serializes cold-starts when the launcher requires it (real engine cold-starts spike host RAM
  // and OOM a peer if run concurrently — spike Gate 9c). A promise chain acts as an async mutex.
  private coldStartChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly config: DevWorkerConfig,
    private readonly registration: WorkerRegistration,
    launcher?: RunnerLauncher,
    logBuffer?: RunnerLogBuffer,
  ) {
    this.nextPort = config.runnerPortStart;
    this.launcher = launcher ?? new StubLauncher(config);
    this.logBuffer = logBuffer ?? new RunnerLogBuffer();
  }

  getLogBuffer(): RunnerLogBuffer {
    return this.logBuffer;
  }

  async startRunner(
    params: StartRunnerParams,
  ): Promise<{ runnerId: string; host: string; port: number; enginePort: number }> {
    if (this.modelToRunner.has(params.modelName)) {
      throw new ConflictError(`Runner for model ${params.modelName} already exists`);
    }

    const runnerId = `runner-${randomUUID().slice(0, 8)}`;
    const { port, enginePort } = this.allocatePorts();

    // Reserve the model slot up-front so concurrent starts of the same model race to ConflictError
    // rather than both proceeding.
    this.modelToRunner.set(params.modelName, runnerId);

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
      this.modelToRunner.delete(record.modelName);
      this.logBuffer.markEnded(runnerId);
      this.logBuffer.retain(runnerId);
      console.log(
        `[worker] Runner ${runnerId} (${params.modelName}) exited unexpectedly — cleaned up`,
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
        `[worker] Started runner ${runnerId} for ${params.modelName} on ${handle.host}:${handle.port}` +
          (handle.enginePort !== handle.port ? ` (inference on :${handle.enginePort})` : ''),
      );

      return { runnerId, host: handle.host, port: handle.port, enginePort: handle.enginePort };
    } catch (err) {
      // Roll back the reserved model slot so a failed start doesn't permanently block the model.
      this.modelToRunner.delete(params.modelName);
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
    this.modelToRunner.delete(record.modelName);

    for (const device of record.devices) {
      const perDeviceMemory = Math.floor(record.requiredMemory / record.devices.length);
      this.registration.freeMemory(device.deviceIndex, perDeviceMemory);
    }

    await record.handle.stop();

    // Signal any connected SSE clients that the stream is over before dropping the buffer —
    // otherwise a client's `end` frame would race a listener set already cleared by drop().
    this.logBuffer.markEnded(runnerId);
    this.logBuffer.drop(runnerId);

    console.log(`[worker] Stopped runner ${runnerId} (${record.modelName})`);
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
  // only populated once a cold-start is *healthy*), this reads `modelToRunner`, which is set the
  // instant startRunner() is entered — so a runner's logs are addressable during cold-start, which
  // is exactly the window the deploy modal wants to stream.
  getRunnerIdForModel(modelName: string): string | undefined {
    return this.modelToRunner.get(modelName);
  }

  getAllRunners(): RunnerRecord[] {
    return Array.from(this.runners.values());
  }

  // Allocate a (management, engine) port pair, stepping by 2. Real engines (vLLM) serve inference
  // on `management + 1`, so allocating one port per runner would let a second runner's management
  // port collide with the first runner's engine port. Pairing avoids that regardless of launcher;
  // single-server launchers (the stub) simply leave the engine port of the pair unused.
  private allocatePorts(): { port: number; enginePort: number } {
    const port = this.nextPort;
    const enginePort = this.nextPort + 1;
    this.nextPort += 2;
    return { port, enginePort };
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
