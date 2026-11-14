import type { FastifyInstance } from 'fastify';
import { ModelLifecycleState, WorkerStatus } from '@sardeenz/types';

import { sumInstanceMeasurementsByInstance } from '../services/memory-budget.js';
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
      // Measured is the only number (#163 doctrine round) — no reserved/measured split. Internal
      // placement holds already net out of availableBytes; they are never exposed as a field.
      memory: {
        totalBytes: memorySummary.totalBytes,
        usedBytes: memorySummary.usedBytes,
        availableBytes: memorySummary.availableBytes,
      },
    });
  });

  app.get('/api/v1/cluster/memory', async (_request, reply) => {
    const allWorkers = deps.workerPool.getAllWorkers();
    const allInstances = await deps.lifecycle.getAllInstances();
    const memorySummary = deps.memoryBudget.getClusterSummary();

    const allRecords = await deps.modelRepository.findAll();
    const displayNameByModel = new Map(
      allRecords.filter((r) => r.displayName != null).map((r) => [r.name, r.displayName!]),
    );

    const workers = allWorkers.map((w) => {
      const budget = deps.memoryBudget.getWorkerBudget(w.workerId);

      // Attributed measured bytes per instance, scoped to this worker's own report (a worker
      // only ever attributes usage for instances it hosts) — supersedes the old #123/#151
      // requiredMemory seam now that genuine per-instance NVML attribution exists (#163).
      // Sums under the attribution scope rule (ADR-027 Decision 4, #278): device- or
      // unknown-scope rows are dropped from per-instance figures unless they are their
      // device's sole >0-byte row, so co-located whole-device observations can never be
      // double-counted into per-model bars.
      const measuredByInstance = sumInstanceMeasurementsByInstance(
        budget?.instanceMeasurements ?? [],
      );

      const workerModels = allInstances
        .filter(
          (s) =>
            s.workerId === w.workerId &&
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

      return {
        workerId: w.workerId,
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
          ...('kvCache' in d && d.kvCache !== undefined ? { kvCache: d.kvCache } : {}),
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
      },
    });
  });
}
