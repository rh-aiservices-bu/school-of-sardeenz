import { WorkerStatus, DeviceType, ModelLifecycleState } from '@sardeenz/types';
import type { WorkerRecord, WorkerCapability } from './worker-pool.js';
import type { WorkerBudget, DeviceBudget } from './memory-budget.js';
import type { InstanceState } from './model-lifecycle.js';
import { placementDuration } from '../health/metrics.js';

export interface PlacementRequest {
  modelName: string;
  runnerType: string;
  requiredMemory: number;
  deviceType?: string;
  tensorParallel: number;
  /** Opt-in to kvcached elastic co-location (#276). Only honored when a CoLocationContext is
   *  supplied — without one the placement is exactly today's byte-fit. */
  allowCoLocation?: boolean;
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
  /** True when the placement used the elastic co-location branch — marks the reservation
   *  annotation recorded at reserve time (memory-budget.ts). Absent/undefined = plain. */
  coLocated?: boolean;
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

/** Co-location group member states — shared by coLocationGroup's membership filter and
 * guardedHeadroom's unknown-placement guard so the two rules cannot drift (ERROR is handled
 * separately in both: member only when it retains a reservation hold). */
const CO_LOCATION_MEMBER_STATES: ReadonlySet<ModelLifecycleState> = new Set([
  ModelLifecycleState.STARTING,
  ModelLifecycleState.ACTIVE,
  ModelLifecycleState.DRAINING,
  ModelLifecycleState.SLEEPING,
]);

/**
 * The co-location group of one device on one worker: the instances that share that device and
 * therefore participate in the elastic guard / pressure response. Single derivation for the
 * whole codebase — #277 (pool-pressure response) imports this; it must never be re-derived.
 *
 * Membership (pinned by the Phase 5 plan and #276's tests):
 *   - state STARTING | ACTIVE | DRAINING | SLEEPING → member (sleeping instances keep their
 *     holds and are the prime pressure victims);
 *   - state ERROR → member only when the instance retains a reservation hold on this device
 *     (runnerStartAmbiguous zombies) — supplied via heldInstanceIds from
 *     MemoryBudgetService.getReservationHolders;
 *   - PENDING (never placed), STOPPING (teardown dispatched), STOPPED (terminal) → never
 *     members.
 */
export function coLocationGroup(
  workerId: string,
  deviceIndex: number,
  instances: InstanceState[],
  heldInstanceIds?: ReadonlySet<string>,
): InstanceState[] {
  return instances.filter((s) => {
    if (s.workerId !== workerId) return false;
    if (!(s.deviceIndices ?? []).includes(deviceIndex)) return false;
    if (CO_LOCATION_MEMBER_STATES.has(s.state)) return true;
    if (s.state === ModelLifecycleState.ERROR) {
      return heldInstanceIds?.has(s.instanceId) ?? false;
    }
    return false;
  });
}

/** Everything the elastic branch needs to resolve co-resident capabilities and holds,
 *  assembled once by the caller (routes/models.ts buildCoLocationContext) and threaded into
 *  place/placeFixed. Absent context ⇒ placement behaves exactly as before #276. */
export interface CoLocationContext {
  /** Full snapshot from one getAllInstances() call — every state, STOPPED included;
   *  coLocationGroup filters membership by state. */
  instances: InstanceState[];
  /** modelName → runnerType, from ModelRepository.findAll(). */
  runnerTypeByModel: ReadonlyMap<string, string>;
  /** `${workerId}:${deviceIndex}` → instanceIds retaining holds there, from
   *  getReservationHolders over getAllBudgets() devices. */
  holdsByDevice: ReadonlyMap<string, ReadonlySet<string>>;
}

export class PlacementPipeline {
  constructor(
    private readonly strategy: PlacementStrategy = new MostAvailableCapacityStrategy(),
    // Oversubscription cap (decision 2026-11-13, #276): integer percent of the device's
    // reported KV-pool totalBytes; 0 disables elastic headroom entirely (plain byte-fit only).
    private readonly options: { maxPoolHeadroomPercent: number } = { maxPoolHeadroomPercent: 50 },
  ) {}

  place(
    request: PlacementRequest,
    workers: WorkerRecord[],
    budgets: Map<string, WorkerBudget>,
    context?: CoLocationContext,
  ): PlacementResult | null {
    const end = placementDuration.startTimer();
    try {
      const healthyWorkers = this.filterByHealth(workers);
      if (healthyWorkers.length === 0) return null;

      const afterRunnerType = this.filterByRunnerType(request, healthyWorkers);
      if (afterRunnerType.length === 0) return null;

      const afterHardware = this.filterByHardware(request, afterRunnerType);
      if (afterHardware.length === 0) return null;

      const candidates = this.filterByCapacity(request, afterHardware, budgets, context);
      if (candidates.length === 0) return null;

      const selected = this.strategy.select(candidates);
      const selectedWorker = afterHardware.find(
        (c) => c.worker.workerId === selected.workerId,
      )?.worker;

      const selectedDevices = selected.devices
        .filter(
          (d) =>
            this.effectiveAvailability(request, selected.capability, d, selectedWorker, context) !==
            null,
        )
        .slice(0, request.tensorParallel)
        .map((d) => ({ deviceIndex: d.deviceIndex, deviceType: d.deviceType }));

      if (selectedDevices.length < request.tensorParallel) return null;

      return {
        workerId: selected.workerId,
        runnerType: request.runnerType,
        devices: selectedDevices,
        ...(this.isElasticRequest(request, selected.capability, context)
          ? { coLocated: true }
          : {}),
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
    context?: CoLocationContext,
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
    const devices = deviceIndices.map((deviceIndex) =>
      budget.devices.find((device) => device.deviceIndex === deviceIndex),
    );
    if (
      devices.some(
        (device) =>
          !device ||
          this.effectiveAvailability(request, capability, device, worker, context) === null ||
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
      ...(this.isElasticRequest(request, capability, context) ? { coLocated: true } : {}),
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
    context?: CoLocationContext,
  ): PlacementCandidate[] {
    const results: PlacementCandidate[] = [];

    for (const { worker, capability } of candidates) {
      const budget = budgets.get(worker.workerId);
      if (!budget || budget.stale) continue;

      let eligibleDevices = budget.devices.filter(
        (d) =>
          this.effectiveAvailability(request, capability, d, worker, context) !== null &&
          capability.supportedDeviceTypes.includes(d.deviceType as DeviceType),
      );

      if (request.deviceType) {
        eligibleDevices = eligibleDevices.filter((d) => d.deviceType === request.deviceType);
      }

      if (eligibleDevices.length >= request.tensorParallel) {
        const totalAvailable = eligibleDevices.reduce(
          (sum, d) =>
            sum + (this.effectiveAvailability(request, capability, d, worker, context) ?? 0),
          0,
        );
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

  /**
   * Whether the request engages the elastic co-location branch on this worker: explicit opt-in
   * AND a threaded context AND the request's own runner type declares elastic sharing here (it
   * is its own first co-resident). Without any of the three the placement is exactly today's.
   */
  private isElasticRequest(
    request: PlacementRequest,
    capability: WorkerCapability,
    context?: CoLocationContext,
  ): boolean {
    return (
      request.allowCoLocation === true &&
      context !== undefined &&
      capability.kvCacheElasticSharing === true
    );
  }

  /**
   * Bounded kvcached-pool headroom for one device under the guard, in bytes. 0 unless: a pool
   * is reported for the device (absent means absent, never zero), the cap is > 0, every member
   * of the device's co-location group resolves to a runner type declaring kvCacheElasticSharing
   * on THIS worker, and no unknown-placement instance shares the worker — a member-state or
   * hold-retaining ERROR instance with null/empty deviceIndices is invisible to the
   * device-scoped membership predicate, so its bytes sit in usedBytes with an unresolvable
   * per-device capability and it blocks headroom on every device of its worker (fail-closed,
   * constraint 1 of the spec). An unresolvable co-resident capability (ModelRecord deleted,
   * worker no longer reporting the runner type) is the other fail-closed arm. Headroom is the
   * decision-comment formula with
   * freeBytes + preallocBytes clamped to totalBytes:
   * min(min(freeBytes + preallocBytes, totalBytes), capPercent/100 × totalBytes).
   */
  private guardedHeadroom(
    worker: WorkerRecord,
    device: DeviceBudget,
    context: CoLocationContext,
  ): number {
    if (!device.kvCache) return 0;
    const capPercent = this.options.maxPoolHeadroomPercent;
    if (capPercent <= 0) return 0;

    // Fail closed on unknown placement. coLocationGroup's membership predicate is
    // device-scoped (spec-pinned: `(s.deviceIndices ?? []).includes(deviceIndex)`), so an
    // instance with null/empty deviceIndices is a member of no device: its bytes sit in
    // usedBytes but its per-device capability cannot be resolved. The unknown-placement class
    // follows the same membership rule as coLocationGroup — the shared member states plus
    // ERROR instances retaining a hold on this device (runnerStartAmbiguous zombies, joined
    // via heldInstanceIds). Letting such an instance through is a fail-open edge in the OOM
    // guard, so it blocks headroom on every device of its worker.
    const heldIds =
      context.holdsByDevice.get(`${worker.workerId}:${device.deviceIndex}`) ?? new Set<string>();
    if (
      context.instances.some((s) => {
        if (s.workerId !== worker.workerId) return false;
        if (s.deviceIndices && s.deviceIndices.length > 0) return false;
        if (CO_LOCATION_MEMBER_STATES.has(s.state)) return true;
        return s.state === ModelLifecycleState.ERROR && heldIds.has(s.instanceId);
      })
    ) {
      return 0;
    }

    for (const member of coLocationGroup(
      worker.workerId,
      device.deviceIndex,
      context.instances,
      heldIds,
    )) {
      const runnerType = context.runnerTypeByModel.get(member.modelName);
      if (runnerType === undefined) return 0; // deleted ModelRecord → fail closed
      const capability = worker.capabilities.find((c) => c.runnerType === runnerType);
      if (!capability || capability.kvCacheElasticSharing !== true) return 0;
    }

    // Belt-and-braces clamp on freeBytes + preallocBytes: with the boot-validated cap domain
    // (0–100, `colocationMaxPoolHeadroomPercentEnv`) the cap term is already ≤ totalBytes and
    // always the smaller bound, so this inner clamp never binds on a config-built pipeline —
    // it pins the invariant for direct constructions with a wider cap (distinguishing test:
    // a malformed report claiming free > total must not inflate headroom past the real pool).
    return Math.min(
      Math.min(device.kvCache.freeBytes + device.kvCache.preallocBytes, device.kvCache.totalBytes),
      (capPercent / 100) * device.kvCache.totalBytes,
    );
  }

  /**
   * Effective availability of one device for one request under the co-location policy: the
   * plain figure is `availableBytes`; the elastic branch (request opts in AND the request's
   * runner type declares elastic on this worker) adds the guarded kvcached-pool headroom
   * regardless of whether the plain fit already holds — that addition is the feature, and a
   * device that fits plainly stays eligible exactly as before (constraint 2). Returns null
   * when the device is ineligible on capacity. The `worker` record is required for the guard
   * (co-resident capabilities are resolved against THAT worker's declarations); without one
   * the elastic branch cannot engage and the predicate is the plain byte-fit.
   */
  private effectiveAvailability(
    request: PlacementRequest,
    capability: WorkerCapability,
    device: DeviceBudget,
    worker: WorkerRecord | undefined,
    context?: CoLocationContext,
  ): number | null {
    const perDeviceRequired = request.requiredMemory / request.tensorParallel;
    let headroom = 0;
    if (
      worker !== undefined &&
      context !== undefined &&
      this.isElasticRequest(request, capability, context)
    ) {
      headroom = this.guardedHeadroom(worker, device, context);
    }
    const effective = device.availableBytes + headroom;
    return effective >= perDeviceRequired ? effective : null;
  }
}
