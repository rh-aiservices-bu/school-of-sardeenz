import type { FastifyInstance } from 'fastify';
import type { RunnerStateMachine } from '../state.js';

export interface MemoryRouteConfig {
  requiredMemory: number;
  devices: { deviceIndex: number; deviceType: string }[];
  deviceMemoryTotalBytes: number;
}

export function registerMemoryRoutes(
  app: FastifyInstance,
  stateMachine: RunnerStateMachine,
  config: MemoryRouteConfig,
): void {
  app.get('/memory-report', async (_req, reply) => {
    const state = stateMachine.state;
    if (state === 'STARTING' || state === 'ERROR') {
      return reply.status(409).send({
        error: `Cannot report memory in ${state} state`,
        code: 'INVALID_STATE',
      });
    }

    const isSleeping = state === 'SLEEPING';
    const perDeviceMemory =
      config.devices.length > 0 ? Math.floor(config.requiredMemory / config.devices.length) : 0;

    return reply.status(200).send({
      devices: config.devices.map((d) => ({
        deviceIndex: d.deviceIndex,
        deviceType: d.deviceType,
        memoryUsedBytes: isSleeping ? 0 : perDeviceMemory,
        memoryTotalBytes: config.deviceMemoryTotalBytes,
      })),
    });
  });
}
