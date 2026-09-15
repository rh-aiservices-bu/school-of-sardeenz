import type { FastifyInstance } from 'fastify';

export interface CapabilitiesConfig {
  runnerType: string;
  deviceType: string;
}

export function registerCapabilitiesRoutes(app: FastifyInstance, config: CapabilitiesConfig): void {
  app.get('/capabilities', async (_req, reply) => {
    return reply.status(200).send({
      runnerType: config.runnerType,
      engineName: `Dev Stub (${config.runnerType})`,
      engineVersion: '0.0.1-dev',
      supportedModelTypes: ['LLM'],
      supportedDeviceTypes: [config.deviceType],
      supportedSleepLevels: ['L1_HOST_RAM'],
      maxTensorParallelism: 1,
      kvCacheElasticSharing: false,
      features: {
        streamingInference: true,
      },
    });
  });
}
