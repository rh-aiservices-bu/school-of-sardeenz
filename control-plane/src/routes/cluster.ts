import type { FastifyInstance } from 'fastify';
import { ModelLifecycleState, WorkerStatus } from '@sardeenz/types';

import type { RouteDeps } from './deps.js';

export function registerClusterRoutes(app: FastifyInstance, deps: RouteDeps): void {
  app.get('/api/v1/cluster/status', async (_request, reply) => {
    const allStates = await deps.lifecycle.getAllStates();
    const allWorkers = deps.workerPool.getAllWorkers();
    const memorySummary = deps.memoryBudget.getClusterSummary();

    const modelCounts = {
      total: allStates.length,
      active: 0,
      sleeping: 0,
      starting: 0,
      error: 0,
      other: 0,
    };

    for (const state of allStates) {
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
      },
    });
  });

  app.get('/api/v1/cluster/memory', async (_request, reply) => {
    const allWorkers = deps.workerPool.getAllWorkers();
    const allStates = await deps.lifecycle.getAllStates();
    const memorySummary = deps.memoryBudget.getClusterSummary();

    const workers = allWorkers.map((w) => {
      const budget = deps.memoryBudget.getWorkerBudget(w.workerId);
      const workerModels = allStates
        .filter(
          (s) =>
            s.workerId === w.workerId &&
            s.state !== ModelLifecycleState.STOPPED &&
            s.state !== ModelLifecycleState.PENDING,
        )
        .map((s) => ({
          modelName: s.modelName,
          state: s.state,
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
      },
    });
  });
}
