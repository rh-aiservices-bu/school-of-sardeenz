import Fastify from 'fastify';
import { RunnerStateMachine } from './state.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerMemoryRoutes } from './routes/memory.js';
import { registerSleepRoutes } from './routes/sleep.js';
import { registerProgressRoutes } from './routes/progress.js';
import { registerCapabilitiesRoutes } from './routes/capabilities.js';
import { registerInferenceRoutes } from './routes/inference.js';

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
  start: () => Promise<void>;
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
  registerInferenceRoutes(server, stateMachine, {
    modelName: config.modelName,
    workerId: config.workerId,
    inferenceDelayMs: config.inferenceDelayMs,
  });

  return {
    server,
    stateMachine,
    async start() {
      await server.listen({ port: config.port, host: '0.0.0.0' });
      void stateMachine.simulateStartup(config.startupDelayMs);
    },
    async stop() {
      stateMachine.destroy();
      await server.close();
    },
  };
}
