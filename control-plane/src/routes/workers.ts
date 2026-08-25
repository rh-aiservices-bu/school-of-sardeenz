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
          ...('deviceName' in d && d.deviceName !== undefined ? { deviceName: d.deviceName } : {}),
          ...('utilizationPercent' in d && d.utilizationPercent !== undefined
            ? { utilizationPercent: d.utilizationPercent }
            : {}),
          ...('temperatureC' in d && d.temperatureC !== undefined
            ? { temperatureC: d.temperatureC }
            : {}),
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
    const displayNameByModel = new Map(
      allRecords.filter((r) => r.displayName != null).map((r) => [r.name, r.displayName!]),
    );

    const budget = deps.memoryBudget.getWorkerBudget(workerId);

    // Attributed measured bytes per instance, scoped to this worker's own report — supersedes
    // the old #123/#151 requiredMemory seam now that genuine per-instance NVML attribution
    // exists (#163).
    const measuredByInstance = new Map<string, number>();
    for (const m of budget?.instanceMeasurements ?? []) {
      measuredByInstance.set(
        m.instanceId,
        (measuredByInstance.get(m.instanceId) ?? 0) + m.measuredUsedBytes,
      );
    }

    const workerModels = allInstances
      .filter(
        (s) =>
          s.workerId === workerId &&
          s.state !== ModelLifecycleState.STOPPED &&
          s.state !== ModelLifecycleState.PENDING,
      )
      .map((s) => ({
        modelName: s.modelName,
        displayName: displayNameByModel.get(s.modelName) ?? undefined,
        instanceId: s.instanceId,
        state: s.state,
        // Measured (NVML attribution), absent when nothing is attributed yet (e.g. STARTING).
        memoryUsedBytes: measuredByInstance.get(s.instanceId) ?? undefined,
        deviceIndices: s.deviceIndices ?? undefined,
      }));

    const detail = {
      workerId: worker.workerId,
      status: worker.status,
      devices: (budget?.devices ?? worker.devices).map((d) => ({
        deviceIndex: d.deviceIndex,
        deviceType: d.deviceType,
        memoryTotalBytes: 'totalBytes' in d ? d.totalBytes : d.memoryTotalBytes,
        memoryUsedBytes: 'usedBytes' in d ? d.usedBytes : 0,
        memoryAvailableBytes: 'availableBytes' in d ? d.availableBytes : 0,
        ...('deviceName' in d && d.deviceName !== undefined ? { deviceName: d.deviceName } : {}),
        ...('utilizationPercent' in d && d.utilizationPercent !== undefined
          ? { utilizationPercent: d.utilizationPercent }
          : {}),
        ...('temperatureC' in d && d.temperatureC !== undefined
          ? { temperatureC: d.temperatureC }
          : {}),
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
