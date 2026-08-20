import type { DevWorkerConfig } from './config.js';
import { createRunnerStub } from './runner-stub/server.js';
import type { LaunchHandle, LaunchSpec, LogSink, RunnerLauncher } from './launcher.js';

// Dev launcher: starts an in-process Fastify stub that fakes an engine runner (Phase 3.6).
// No child process, no SIF — purely local. Cheap enough to start concurrently.
export class StubLauncher implements RunnerLauncher {
  readonly serializeColdStarts = false;

  constructor(private readonly config: DevWorkerConfig) {}

  async start(spec: LaunchSpec, onLog?: LogSink): Promise<LaunchHandle> {
    const stub = createRunnerStub({
      port: spec.port,
      modelName: spec.modelName,
      workerId: this.config.workerId,
      runnerType: spec.runnerType || this.config.runnerType,
      deviceType: spec.deviceType || this.config.deviceType,
      requiredMemory: spec.requiredMemory,
      devices: spec.devices,
      deviceMemoryTotalBytes: this.config.deviceMemoryBytes,
      startupDelayMs: this.config.startupDelayMs,
      sleepDelayMs: this.config.sleepDelayMs,
      wakeDelayMs: this.config.wakeDelayMs,
      inferenceDelayMs: this.config.inferenceDelayMs,
    });

    // The stub runs in-process, so no capture plumbing needed — the log sink is called directly.
    await stub.start(onLog);

    return {
      host: 'localhost',
      port: spec.port,
      stop: () => stub.stop(),
    };
  }
}
