import type { FastifyInstance } from 'fastify';
import { ModelLifecycleState, WorkerStatus } from '@sardeenz/types';

import type { RouteDeps } from './deps.js';

export function registerClusterRoutes(app: FastifyInstance, deps: RouteDeps): void {
  app.get('/api/v1/cluster/status', async (_request, reply) => {
    const allInstances = await deps.lifecycle.getAllInstances();
    const allWorkers = deps.workerPool.getAllWorkers();
    const memorySummary = deps.memoryBudget.getClusterSummary();

    const modelCounts = {
      total: allInstances.length,
      active: 0,
      sleeping: 0,
      starting: 0,
      error: 0,
      other: 0,
    };

    for (const state of allInstances) {
      switch (state.state) {
        case ModelLifecycleState.ACTIVE:
          modelCounts.active++;
          break;
        case ModelLifecycleState.SLEEPING:
          modelCounts.sleeping++;
          break;
        case ModelLifecycleState.STARTING:
          modelCounts.starting++;
          break;
        case ModelLifecycleState.ERROR:
          modelCounts.error++;
          break;
        default:
          modelCounts.other++;
      }
    }

    return reply.code(200).send({
      isLeader: deps.leaderElection.isLeader,
      workerCount: allWorkers.length,
      workersOnline: allWorkers.filter((w) => w.status === WorkerStatus.ONLINE).length,
      modelCounts,
      memory: {
        totalBytes: memorySummary.totalBytes,
        usedBytes: memorySummary.usedBytes,
        availableBytes: memorySummary.availableBytes,
        reservedBytes: memorySummary.reservedBytes,
        ...(memorySummary.measuredUsedBytes !== undefined
          ? { measuredUsedBytes: memorySummary.measuredUsedBytes }
          : {}),
      },
    });
  });

  app.get('/api/v1/cluster/memory', async (_request, reply) => {
    const allWorkers = deps.workerPool.getAllWorkers();
    const allInstances = await deps.lifecycle.getAllInstances();
    const memorySummary = deps.memoryBudget.getClusterSummary();

    const allRecords = await deps.modelRepository.findAll();
    const requiredByModel = new Map(
      allRecords.filter((r) => r.requiredMemory != null).map((r) => [r.name, r.requiredMemory!]),
    );

    const workers = allWorkers.map((w) => {
      const budget = deps.memoryBudget.getWorkerBudget(w.workerId);
      const workerModels = allInstances
        .filter(
          (s) =>
            s.workerId === w.workerId &&
            s.state !== ModelLifecycleState.STOPPED &&
            s.state !== ModelLifecycleState.PENDING,
        )
        .map((s) => ({
          modelName: s.modelName,
          state: s.state,
          deviceIndices: s.deviceIndices ?? undefined,
          // Configured requirement, not a measured value — see #123 blueprint §3. This is the
          // seam where a genuine runner-reported per-model measurement would later replace it.
          memoryUsedBytes: requiredByModel.get(s.modelName) ?? undefined,
        }));

      return {
        workerId: w.workerId,
        devices: (budget?.devices ?? w.devices).map((d) => ({
          deviceIndex: d.deviceIndex,
          deviceType: d.deviceType,
          memoryTotalBytes: 'totalBytes' in d ? d.totalBytes : d.memoryTotalBytes,
          memoryUsedBytes: 'usedBytes' in d ? d.usedBytes : 0,
          memoryAvailableBytes: 'availableBytes' in d ? d.availableBytes : 0,
          memoryReservedBytes: 'reservedBytes' in d ? d.reservedBytes : 0,
          ...('measuredUsedBytes' in d && d.measuredUsedBytes !== undefined
            ? { memoryMeasuredUsedBytes: d.measuredUsedBytes }
            : {}),
        })),
        models: workerModels,
      };
    });

    return reply.code(200).send({
      workers,
      summary: {
        totalBytes: memorySummary.totalBytes,
        usedBytes: memorySummary.usedBytes,
        availableBytes: memorySummary.availableBytes,
        reservedBytes: memorySummary.reservedBytes,
        ...(memorySummary.measuredUsedBytes !== undefined
          ? { measuredUsedBytes: memorySummary.measuredUsedBytes }
          : {}),
      },
    });
  });
}
