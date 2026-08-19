import type { FastifyInstance } from 'fastify';
import { ConflictError, NotFoundError, type RunnerManager } from '../runner-manager.js';

export function registerRunnerRoutes(app: FastifyInstance, runnerManager: RunnerManager): void {
  app.post<{
    Body: {
      modelName: string;
      runnerType: string;
      modelPath: string;
      requiredMemory: number;
      deviceType?: string;
      tensorParallel: number;
      runtimeModule?: string;
      engineConfig?: Record<string, unknown>;
      devices: { deviceIndex: number; deviceType: string }[];
    };
  }>('/runners', async (req, reply) => {
    const body = req.body;
    if (!body?.modelName || !body?.runnerType || !body?.modelPath || !body?.devices) {
      return reply.status(400).send({
        error: 'Missing required fields: modelName, runnerType, modelPath, devices',
        code: 'BAD_REQUEST',
      });
    }

    try {
      const result = await runnerManager.startRunner({
        modelName: body.modelName,
        runnerType: body.runnerType,
        modelPath: body.modelPath,
        requiredMemory: body.requiredMemory ?? 0,
        deviceType: body.deviceType,
        tensorParallel: body.tensorParallel ?? 1,
        runtimeModule: body.runtimeModule,
        engineConfig: body.engineConfig,
        devices: body.devices,
      });
      return reply.status(201).send(result);
    } catch (err) {
      if (err instanceof ConflictError) {
        return reply.status(409).send({ error: err.message, code: 'CONFLICT' });
      }
      throw err;
    }
  });

  app.delete<{ Params: { runnerId: string } }>('/runners/:runnerId', async (req, reply) => {
    try {
      await runnerManager.stopRunner(req.params.runnerId);
      return reply.status(204).send();
    } catch (err) {
      if (err instanceof NotFoundError) {
        return reply.status(404).send({ error: err.message, code: 'NOT_FOUND' });
      }
      throw err;
    }
  });
}
