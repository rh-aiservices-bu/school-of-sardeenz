import type { DevWorkerConfig } from './config.js';
import type { WorkerRegistration } from './registration.js';
import { createRunnerStub, type RunnerStub } from './runner-stub/server.js';
import { randomUUID } from 'node:crypto';

export interface RunnerRecord {
  runnerId: string;
  modelName: string;
  port: number;
  host: string;
  requiredMemory: number;
  devices: { deviceIndex: number; deviceType: string }[];
  stub: RunnerStub;
}

export interface StartRunnerParams {
  modelName: string;
  runnerType: string;
  modelPath: string;
  requiredMemory: number;
  deviceType?: string;
  tensorParallel: number;
  engineConfig?: Record<string, unknown>;
  devices: { deviceIndex: number; deviceType: string }[];
}

export class RunnerManager {
  private readonly runners = new Map<string, RunnerRecord>();
  private readonly modelToRunner = new Map<string, string>();
  private nextPort: number;

  constructor(
    private readonly config: DevWorkerConfig,
    private readonly registration: WorkerRegistration,
  ) {
    this.nextPort = config.runnerPortStart;
  }

  async startRunner(
    params: StartRunnerParams,
  ): Promise<{ runnerId: string; host: string; port: number }> {
    if (this.modelToRunner.has(params.modelName)) {
      throw new ConflictError(`Runner for model ${params.modelName} already exists`);
    }

    const runnerId = `runner-${randomUUID().slice(0, 8)}`;
    const port = this.allocatePort();

    const stub = createRunnerStub({
      port,
      modelName: params.modelName,
      workerId: this.config.workerId,
      runnerType: params.runnerType || this.config.runnerType,
      deviceType: params.deviceType || this.config.deviceType,
      requiredMemory: params.requiredMemory,
      devices: params.devices,
      deviceMemoryTotalBytes: this.config.deviceMemoryBytes,
      startupDelayMs: this.config.startupDelayMs,
      sleepDelayMs: this.config.sleepDelayMs,
      wakeDelayMs: this.config.wakeDelayMs,
      inferenceDelayMs: this.config.inferenceDelayMs,
    });

    const record: RunnerRecord = {
      runnerId,
      modelName: params.modelName,
      port,
      host: 'localhost',
      requiredMemory: params.requiredMemory,
      devices: params.devices,
      stub,
    };

    this.runners.set(runnerId, record);
    this.modelToRunner.set(params.modelName, runnerId);

    await stub.start();

    for (const device of params.devices) {
      const perDeviceMemory = Math.floor(params.requiredMemory / params.devices.length);
      this.registration.allocateMemory(device.deviceIndex, perDeviceMemory);
    }

    console.log(`[dev-worker] Started runner ${runnerId} for ${params.modelName} on :${port}`);

    return { runnerId, host: 'localhost', port };
  }

  async stopRunner(runnerId: string): Promise<void> {
    const record = this.runners.get(runnerId);
    if (!record) {
      throw new NotFoundError(`Runner ${runnerId} not found`);
    }

    await record.stub.stop();

    for (const device of record.devices) {
      const perDeviceMemory = Math.floor(record.requiredMemory / record.devices.length);
      this.registration.freeMemory(device.deviceIndex, perDeviceMemory);
    }

    this.runners.delete(runnerId);
    this.modelToRunner.delete(record.modelName);

    console.log(`[dev-worker] Stopped runner ${runnerId} (${record.modelName})`);
  }

  async stopAll(): Promise<void> {
    const runnerIds = Array.from(this.runners.keys());
    for (const runnerId of runnerIds) {
      await this.stopRunner(runnerId);
    }
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
