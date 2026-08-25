import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { ConflictError, NotFoundError, type RunnerManager } from '../runner-manager.js';

export function registerRunnerRoutes(app: FastifyInstance, runnerManager: RunnerManager): void {
  app.post<{
    Body: {
      modelName: string;
      instanceId?: string;
      runnerType: string;
      modelPath: string;
      requiredMemory: number;
      deviceType?: string;
      tensorParallel: number;
      runtimeModule?: string;
      engineConfig?: Record<string, unknown>;
      engineArgs?: string[];
      servedModelName?: string;
      entrypoint?: string[];
      devices: { deviceIndex: number; deviceType: string }[];
    };
  }>('/runners', async (req, reply) => {
    const body = req.body;
    // Log receipt up front (Fastify runs with logger:false) so operators can confirm the start
    // command actually reached this worker — the earliest guaranteed point, before any validation.
    console.log(
      `[worker] POST /runners received: model=${body?.modelName ?? '?'} ` +
        `instance=${body?.instanceId ?? '-'} runner=${body?.runnerType ?? '?'} ` +
        `module=${body?.runtimeModule ?? '-'} devices=${body?.devices?.length ?? 0}`,
    );

    if (!body?.modelName || !body?.runnerType || !body?.modelPath || !body?.devices) {
      console.warn('[worker] POST /runners rejected: missing required fields');
      return reply.status(400).send({
        error: 'Missing required fields: modelName, runnerType, modelPath, devices',
        code: 'BAD_REQUEST',
      });
    }

    // instanceId is optional/back-compat in the contract — the control plane always sends one,
    // but a fallback keeps older callers (and manual testing) working.
    const instanceId = body.instanceId ?? `inst-${randomUUID().replace(/-/g, '').slice(0, 12)}`;

    try {
      const result = await runnerManager.startRunner({
        modelName: body.modelName,
        instanceId,
        runnerType: body.runnerType,
        modelPath: body.modelPath,
        requiredMemory: body.requiredMemory ?? 0,
        deviceType: body.deviceType,
        tensorParallel: body.tensorParallel ?? 1,
        runtimeModule: body.runtimeModule,
        engineConfig: body.engineConfig,
        engineArgs: body.engineArgs,
        servedModelName: body.servedModelName,
        entrypoint: body.entrypoint,
        devices: body.devices,
      });
      return reply.status(201).send(result);
    } catch (err) {
      if (err instanceof ConflictError) {
        console.warn(`[worker] POST /runners conflict for instance ${instanceId}: ${err.message}`);
        return reply.status(409).send({ error: err.message, code: 'CONFLICT' });
      }
      // Surface launcher failures (SIF missing, apptainer verify/exec error, health timeout, …) —
      // otherwise they vanish into a 500 with no worker-side trace.
      console.error(`[worker] Failed to start runner for ${body.modelName}/${instanceId}:`, err);
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
