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
      const afterRunnerType = this.filterByRunnerType(request, workers);
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
    if (!request.deviceType) return candidates;

    return candidates.filter(({ worker, capability }) => {
      const hasDevice = worker.devices.some((d) => d.deviceType === request.deviceType);
      const supportsDevice = capability.supportedDeviceTypes.includes(request.deviceType!);
      return hasDevice && supportsDevice;
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

      let eligibleDevices = budget.devices.filter((d) => d.availableBytes >= perDeviceRequired);

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
