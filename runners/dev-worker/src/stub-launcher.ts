import type { DevWorkerConfig } from './config.js';
import { createRunnerStub } from './runner-stub/server.js';
import type { LaunchHandle, LaunchSpec, LogSink, RunnerLauncher } from './launcher.js';

// Dev launcher: starts an in-process Fastify stub that fakes an engine runner (Phase 3.6).
// No child process, no SIF — purely local. Cheap enough to start concurrently.
export class StubLauncher implements RunnerLauncher {
  readonly serializeColdStarts = false;

  constructor(private readonly config: DevWorkerConfig) {}

  async start(
    spec: LaunchSpec,
    onLog?: LogSink,
    onStartupComplete?: () => void,
  ): Promise<LaunchHandle> {
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
    // onStartupComplete fires when the simulated startup finishes (state → READY), mirroring the
    // real launcher, so the manager ends/seals the launch-log stream at the same lifecycle point.
    await stub.start(onLog, onStartupComplete);

    // The stub is a single Fastify server: it serves both the runner-contract management API and
    // the OpenAI `/v1/*` inference routes on `spec.port`. Report the engine port as the same port
    // (the allocated `spec.enginePort` of the pair is left unused) so the proxy targets this server.
    return {
      host: this.config.advertiseHost,
      port: spec.port,
      enginePort: spec.port,
      stop: () => stub.stop(),
    };
  }
}
