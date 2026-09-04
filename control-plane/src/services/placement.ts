import { WorkerStatus, DeviceType } from '@sardeenz/types';
import type { WorkerRecord, WorkerCapability } from './worker-pool.js';
import type { WorkerBudget, DeviceBudget } from './memory-budget.js';
import { placementDuration } from '../health/metrics.js';

export interface PlacementRequest {
  modelName: string;
  runnerType: string;
  requiredMemory: number;
  deviceType?: string;
  tensorParallel: number;
}

export interface PlacementCandidate {
  workerId: string;
  capability: WorkerCapability;
  devices: DeviceBudget[];
  availableMemory: number;
}

export interface PlacementResult {
  workerId: string;
  runnerType: string;
  devices: { deviceIndex: number; deviceType: string }[];
}

export interface PlacementStrategy {
  select(candidates: PlacementCandidate[]): PlacementCandidate;
}

export class MostAvailableCapacityStrategy implements PlacementStrategy {
  select(candidates: PlacementCandidate[]): PlacementCandidate {
    let best = candidates[0];
    for (let i = 1; i < candidates.length; i++) {
      if (candidates[i].availableMemory > best.availableMemory) {
        best = candidates[i]!;
      }
    }
    return best;
  }
}

export class PlacementPipeline {
  constructor(private readonly strategy: PlacementStrategy = new MostAvailableCapacityStrategy()) {}

  place(
    request: PlacementRequest,
    workers: WorkerRecord[],
    budgets: Map<string, WorkerBudget>,
  ): PlacementResult | null {
    const end = placementDuration.startTimer();
    try {
      const healthyWorkers = this.filterByHealth(workers);
      if (healthyWorkers.length === 0) return null;

      const afterRunnerType = this.filterByRunnerType(request, healthyWorkers);
      if (afterRunnerType.length === 0) return null;

      const afterHardware = this.filterByHardware(request, afterRunnerType);
      if (afterHardware.length === 0) return null;

      const candidates = this.filterByCapacity(request, afterHardware, budgets);
      if (candidates.length === 0) return null;

      const selected = this.strategy.select(candidates);

      const selectedDevices = selected.devices
        .filter((d) => d.availableBytes >= request.requiredMemory / request.tensorParallel)
        .slice(0, request.tensorParallel)
        .map((d) => ({ deviceIndex: d.deviceIndex, deviceType: d.deviceType }));

      return {
        workerId: selected.workerId,
        runnerType: request.runnerType,
        devices: selectedDevices,
      };
    } finally {
      end();
    }
  }

  /**
   * Validate a caller-selected placement using the same health, runner, hardware and budget
   * predicates as automatic placement. Fixed placement deliberately never evicts: a move must
   * reserve capacity alongside its still-serving source before it can be accepted.
   */
  placeFixed(
    request: PlacementRequest,
    workerId: string,
    deviceIndices: number[],
    workers: WorkerRecord[],
    budgets: Map<string, WorkerBudget>,
  ): PlacementResult | null {
    if (deviceIndices.length !== request.tensorParallel) return null;
    const worker = workers.find((candidate) => candidate.workerId === workerId);
    if (!worker || this.filterByHealth([worker]).length === 0) return null;
    const runnerCandidates = this.filterByRunnerType(request, [worker]);
    if (runnerCandidates.length === 0) return null;
    const capability = runnerCandidates[0].capability;
    if (request.tensorParallel > capability.maxTensorParallelism) return null;
    if (this.filterByHardware(request, runnerCandidates).length === 0) {
      return null;
    }

    const budget = budgets.get(workerId);
    if (!budget || budget.stale) return null;
    const perDeviceRequired = request.requiredMemory / request.tensorParallel;
    const devices = deviceIndices.map((deviceIndex) =>
      budget.devices.find((device) => device.deviceIndex === deviceIndex),
    );
    if (
      devices.some(
        (device) =>
          !device ||
          device.availableBytes < perDeviceRequired ||
          (request.deviceType !== undefined && device.deviceType !== request.deviceType) ||
          !capability.supportedDeviceTypes.includes(device.deviceType as DeviceType),
      )
    ) {
      return null;
    }

    return {
      workerId,
      runnerType: request.runnerType,
      devices: devices.map((device) => ({
        deviceIndex: device!.deviceIndex,
        deviceType: device!.deviceType,
      })),
    };
  }

  eligibleWorkerIds(request: PlacementRequest, workers: WorkerRecord[]): Set<string> {
    const healthyWorkers = this.filterByHealth(workers);
    if (healthyWorkers.length === 0) return new Set();

    const afterRunnerType = this.filterByRunnerType(request, healthyWorkers);
    if (afterRunnerType.length === 0) return new Set();

    const afterHardware = this.filterByHardware(request, afterRunnerType);
    return new Set(afterHardware.map(({ worker }) => worker.workerId));
  }

  private filterByHealth(workers: WorkerRecord[]): WorkerRecord[] {
    return workers.filter((w) => w.status === WorkerStatus.ONLINE);
  }

  private filterByRunnerType(
    request: PlacementRequest,
    workers: WorkerRecord[],
  ): { worker: WorkerRecord; capability: WorkerCapability }[] {
    const results: { worker: WorkerRecord; capability: WorkerCapability }[] = [];
    for (const worker of workers) {
      for (const cap of worker.capabilities) {
        if (cap.runnerType === request.runnerType) {
          results.push({ worker, capability: cap });
          break;
        }
      }
    }
    return results;
  }

  private filterByHardware(
    request: PlacementRequest,
    candidates: { worker: WorkerRecord; capability: WorkerCapability }[],
  ): { worker: WorkerRecord; capability: WorkerCapability }[] {
    return candidates.filter(({ worker, capability }) => {
      if (request.tensorParallel > capability.maxTensorParallelism) return false;
      // Even an unconstrained model may only land on actual device types the runner supports.
      return worker.devices.some(
        (d) =>
          (!request.deviceType || String(d.deviceType) === request.deviceType) &&
          capability.supportedDeviceTypes.includes(d.deviceType),
      );
    });
  }

  private filterByCapacity(
    request: PlacementRequest,
    candidates: { worker: WorkerRecord; capability: WorkerCapability }[],
    budgets: Map<string, WorkerBudget>,
  ): PlacementCandidate[] {
    const perDeviceRequired = request.requiredMemory / request.tensorParallel;
    const results: PlacementCandidate[] = [];

    for (const { worker, capability } of candidates) {
      const budget = budgets.get(worker.workerId);
      if (!budget || budget.stale) continue;

      let eligibleDevices = budget.devices.filter(
        (d) =>
          d.availableBytes >= perDeviceRequired &&
          capability.supportedDeviceTypes.includes(d.deviceType as DeviceType),
      );

      if (request.deviceType) {
        eligibleDevices = eligibleDevices.filter((d) => d.deviceType === request.deviceType);
      }

      if (eligibleDevices.length >= request.tensorParallel) {
        const totalAvailable = eligibleDevices.reduce((sum, d) => sum + d.availableBytes, 0);
        results.push({
          workerId: worker.workerId,
          capability,
          devices: eligibleDevices,
          availableMemory: totalAvailable,
        });
      }
    }

    return results;
  }
}
