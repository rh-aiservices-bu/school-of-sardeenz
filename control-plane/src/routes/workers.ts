import type { FastifyInstance } from 'fastify';
import { ModelLifecycleState } from '@sardeenz/types';

import type { RouteDeps } from './deps.js';
import { ControlPlaneError } from '../errors.js';

export function registerWorkerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  app.get('/api/v1/workers', async (_request, reply) => {
    const allWorkers = deps.workerPool.getAllWorkers();
    const allStates = await deps.lifecycle.getAllStates();

    const modelCountByWorker = new Map<string, number>();
    for (const state of allStates) {
      if (state.workerId && state.state !== ModelLifecycleState.STOPPED) {
        modelCountByWorker.set(state.workerId, (modelCountByWorker.get(state.workerId) ?? 0) + 1);
      }
    }

    const workers = allWorkers.map((w) => {
      const budget = deps.memoryBudget.getWorkerBudget(w.workerId);
      return {
        workerId: w.workerId,
        status: w.status,
        devices: (budget?.devices ?? w.devices).map((d) => ({
          deviceIndex: d.deviceIndex,
          deviceType: d.deviceType,
          memoryTotalBytes: 'totalBytes' in d ? d.totalBytes : d.memoryTotalBytes,
          memoryUsedBytes: 'usedBytes' in d ? d.usedBytes : 0,
          memoryAvailableBytes: 'availableBytes' in d ? d.availableBytes : 0,
          memoryReservedBytes: 'reservedBytes' in d ? d.reservedBytes : 0,
        })),
        modelCount: modelCountByWorker.get(w.workerId) ?? 0,
        lastHeartbeatAt: w.lastHeartbeatAt ?? undefined,
      };
    });

    return reply.code(200).send({ workers });
  });

  app.get<{ Params: { workerId: string } }>('/api/v1/workers/:workerId', async (request, reply) => {
    const { workerId } = request.params;

    const worker = deps.workerPool.getWorker(workerId);
    if (!worker) {
      throw ControlPlaneError.workerNotFound(workerId);
    }

    const allStates = await deps.lifecycle.getAllStates();
    const workerModels = allStates
      .filter((s) => s.workerId === workerId && s.state !== ModelLifecycleState.STOPPED)
      .map((s) => ({
        modelName: s.modelName,
        state: s.state,
      }));

    const budget = deps.memoryBudget.getWorkerBudget(workerId);

    const detail = {
      workerId: worker.workerId,
      status: worker.status,
      devices: (budget?.devices ?? worker.devices).map((d) => ({
        deviceIndex: d.deviceIndex,
        deviceType: d.deviceType,
        memoryTotalBytes: 'totalBytes' in d ? d.totalBytes : d.memoryTotalBytes,
        memoryUsedBytes: 'usedBytes' in d ? d.usedBytes : 0,
        memoryAvailableBytes: 'availableBytes' in d ? d.availableBytes : 0,
        memoryReservedBytes: 'reservedBytes' in d ? d.reservedBytes : 0,
      })),
      models: workerModels,
      runnerCapabilities: worker.capabilities.map((c) => ({
        runnerType: c.runnerType,
        engineName: c.engineName,
        supportedModelTypes: c.supportedModelTypes,
        supportedDeviceTypes: c.supportedDeviceTypes,
        supportedSleepLevels: c.supportedSleepLevels,
      })),
      lastHeartbeatAt: worker.lastHeartbeatAt ?? undefined,
      joinedAt: worker.joinedAt,
    };

    return reply.code(200).send(detail);
  });
}
