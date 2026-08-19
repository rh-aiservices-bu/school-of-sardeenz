import type { DevWorkerConfig } from './config.js';
import type { WorkerRegistration } from './registration.js';
import type { LaunchHandle, RunnerLauncher } from './launcher.js';
import { StubLauncher } from './stub-launcher.js';
import { randomUUID } from 'node:crypto';

export interface RunnerRecord {
  runnerId: string;
  modelName: string;
  port: number;
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
  private nextPort: number;
  // Serializes cold-starts when the launcher requires it (real engine cold-starts spike host RAM
  // and OOM a peer if run concurrently — spike Gate 9c). A promise chain acts as an async mutex.
  private coldStartChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly config: DevWorkerConfig,
    private readonly registration: WorkerRegistration,
    launcher?: RunnerLauncher,
  ) {
    this.nextPort = config.runnerPortStart;
    this.launcher = launcher ?? new StubLauncher(config);
  }

  async startRunner(
    params: StartRunnerParams,
  ): Promise<{ runnerId: string; host: string; port: number }> {
    if (this.modelToRunner.has(params.modelName)) {
      throw new ConflictError(`Runner for model ${params.modelName} already exists`);
    }

    const runnerId = `runner-${randomUUID().slice(0, 8)}`;
    const port = this.allocatePort();

    // Reserve the model slot up-front so concurrent starts of the same model race to ConflictError
    // rather than both proceeding.
    this.modelToRunner.set(params.modelName, runnerId);

    try {
      const handle = await this.launch({
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
      });

      const record: RunnerRecord = {
        runnerId,
        modelName: params.modelName,
        port,
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
        `[worker] Started runner ${runnerId} for ${params.modelName} on ${handle.host}:${port}`,
      );

      return { runnerId, host: handle.host, port };
    } catch (err) {
      // Roll back the reserved model slot so a failed start doesn't permanently block the model.
      this.modelToRunner.delete(params.modelName);
      throw err;
    }
  }

  // Run the launcher, serializing cold-starts when the launcher requires it.
  private launch(spec: Parameters<RunnerLauncher['start']>[0]): Promise<LaunchHandle> {
    if (!this.launcher.serializeColdStarts) {
      return this.launcher.start(spec);
    }
    const result = this.coldStartChain.then(() => this.launcher.start(spec));
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

    await record.handle.stop();

    for (const device of record.devices) {
      const perDeviceMemory = Math.floor(record.requiredMemory / record.devices.length);
      this.registration.freeMemory(device.deviceIndex, perDeviceMemory);
    }

    this.runners.delete(runnerId);
    this.modelToRunner.delete(record.modelName);

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

  getAllRunners(): RunnerRecord[] {
    return Array.from(this.runners.values());
  }

  private allocatePort(): number {
    const port = this.nextPort;
    this.nextPort++;
    return port;
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
