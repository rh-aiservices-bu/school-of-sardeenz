import Fastify from 'fastify';
import { RunnerStateMachine } from './state.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerMemoryRoutes } from './routes/memory.js';
import { registerSleepRoutes } from './routes/sleep.js';
import { registerProgressRoutes } from './routes/progress.js';
import { registerCapabilitiesRoutes } from './routes/capabilities.js';
import { registerInferenceRoutes } from './routes/inference.js';
import { registerV2InferenceRoutes } from './routes/v2-inference.js';
import type { LogSink } from '../launcher.js';

// Dev-only: the authoritative protocol↔runnerType mapping lives in the catalog (control plane);
// the local stub only distinguishes the shipped engines. mlserver speaks KServe V2 (oip); all
// others OpenAI.
export function isOipRunnerType(runnerType: string): boolean {
  return runnerType === 'mlserver';
}

export interface RunnerStubConfig {
  port: number;
  modelName: string;
  workerId: string;
  runnerType: string;
  deviceType: string;
  requiredMemory: number;
  devices: { deviceIndex: number; deviceType: string }[];
  deviceMemoryTotalBytes: number;
  startupDelayMs: number;
  sleepDelayMs: number;
  wakeDelayMs: number;
  inferenceDelayMs: number;
}

export interface RunnerStub {
  server: ReturnType<typeof Fastify>;
  stateMachine: RunnerStateMachine;
  start: (onLog?: LogSink, onStartupComplete?: () => void) => Promise<void>;
  stop: () => Promise<void>;
}

export function createRunnerStub(config: RunnerStubConfig): RunnerStub {
  const stateMachine = new RunnerStateMachine();
  const server = Fastify({ logger: false });

  registerHealthRoutes(server, stateMachine);
  registerMemoryRoutes(server, stateMachine, {
    requiredMemory: config.requiredMemory,
    devices: config.devices,
    deviceMemoryTotalBytes: config.deviceMemoryTotalBytes,
  });
  registerSleepRoutes(server, stateMachine, {
    sleepDelayMs: config.sleepDelayMs,
    wakeDelayMs: config.wakeDelayMs,
    requiredMemory: config.requiredMemory,
  });
  registerProgressRoutes(server, stateMachine);
  registerCapabilitiesRoutes(server, {
    runnerType: config.runnerType,
    deviceType: config.deviceType,
  });
  if (isOipRunnerType(config.runnerType)) {
    registerV2InferenceRoutes(server, stateMachine, {
      modelName: config.modelName,
      workerId: config.workerId,
      inferenceDelayMs: config.inferenceDelayMs,
    });
  } else {
    registerInferenceRoutes(server, stateMachine, {
      modelName: config.modelName,
      workerId: config.workerId,
      inferenceDelayMs: config.inferenceDelayMs,
    });
  }

  return {
    server,
    stateMachine,
    async start(onLog?: LogSink, onStartupComplete?: () => void) {
      await server.listen({ port: config.port, host: '0.0.0.0' });
      // simulateStartup resolves when the stub reaches READY (all startup log lines emitted), which
      // is the stub's "startup complete" — mirror the real launcher and notify then. Swallow a
      // rejection (e.g. the stub is destroyed mid-startup) so it never becomes an unhandled promise.
      void stateMachine.simulateStartup(config.startupDelayMs, onLog).then(
        () => onStartupComplete?.(),
        () => {},
      );
    },
    async stop() {
      stateMachine.destroy();
      await server.close();
    },
  };
}
