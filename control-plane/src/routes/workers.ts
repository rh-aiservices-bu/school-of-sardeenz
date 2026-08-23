import type { FastifyInstance } from 'fastify';
import { ModelLifecycleState } from '@sardeenz/types';

import type { RouteDeps } from './deps.js';
import { ControlPlaneError } from '../errors.js';

export function registerWorkerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  app.get('/api/v1/workers', async (_request, reply) => {
    const allWorkers = deps.workerPool.getAllWorkers();
    const allInstances = await deps.lifecycle.getAllInstances();

    // Per-worker instance count (not per-model — a 2-replica model on one worker counts 2). The
    // wire field is still `modelCount` (control-plane.yaml WorkerDetail) — unchanged, it reads as
    // "runners on this worker", which is what it now measures.
    const instanceCountByWorker = new Map<string, number>();
    for (const instance of allInstances) {
      if (instance.workerId && instance.state !== ModelLifecycleState.STOPPED) {
        instanceCountByWorker.set(
          instance.workerId,
          (instanceCountByWorker.get(instance.workerId) ?? 0) + 1,
        );
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
        modelCount: instanceCountByWorker.get(w.workerId) ?? 0,
        runnerCapabilities:
          w.capabilities && w.capabilities.length > 0
            ? w.capabilities.map((c) => ({
                runnerType: c.runnerType,
                engineName: c.engineName,
                supportedModelTypes: c.supportedModelTypes,
                supportedDeviceTypes: c.supportedDeviceTypes,
                supportedSleepLevels: c.supportedSleepLevels,
              }))
            : undefined,
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

    const allInstances = await deps.lifecycle.getAllInstances();
    const allRecords = await deps.modelRepository.findAll();
    const requiredByModel = new Map(
      allRecords.filter((r) => r.requiredMemory != null).map((r) => [r.name, r.requiredMemory!]),
    );
    const workerModels = allInstances
      .filter((s) => s.workerId === workerId && s.state !== ModelLifecycleState.STOPPED)
      .map((s) => ({
        modelName: s.modelName,
        state: s.state,
        deviceIndices: s.deviceIndices ?? undefined,
        // Configured requirement, not a measured value — see #123 blueprint §3. This is the
        // seam where a genuine runner-reported per-model measurement would later replace it.
        memoryUsedBytes: requiredByModel.get(s.modelName) ?? undefined,
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
