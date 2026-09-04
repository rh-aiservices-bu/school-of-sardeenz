import { ModelLifecycleState, WorkerStatus, type ControlPlaneComponents } from '@sardeenz/types';

type InstanceDetail = ControlPlaneComponents['schemas']['InstanceDetail'];
type ModelDetail = ControlPlaneComponents['schemas']['ModelDetail'];
type WorkerInfo = ControlPlaneComponents['schemas']['WorkerInfo'];

export interface MovePlacementSource {
  workerId: string;
  deviceIndices: number[];
}

export type MoveProgress =
  | 'deploying'
  | 'cutting-over'
  | 'draining-source'
  | 'complete'
  | 'failed-before-cutover'
  | 'failed-after-cutover'
  | 'unavailable';

// A 202 may arrive before Redis/SSE propagates the replacement.  Do not leave the dialog in an
// unbounded spinner if the pre-cutover replacement was immediately removed.
export const MOVE_REPLACEMENT_OBSERVATION_TIMEOUT_MS = 30_000;

/** Apply the same runner, hardware, tensor-parallel and per-device VRAM checks as placement. */
export function compatibleMoveDevices(worker: WorkerInfo, model: ModelDetail) {
  if (worker.status !== WorkerStatus.ONLINE) return [];
  const tensorParallel = model.tensorParallel ?? 1;
  const capability = worker.runnerCapabilities?.find(
    (candidate) =>
      candidate.runnerType === model.runnerType &&
      candidate.maxTensorParallelism >= tensorParallel &&
      (!model.deviceType || candidate.supportedDeviceTypes.includes(model.deviceType as never)),
  );
  if (!capability) return [];
  const perDeviceRequired = model.requiredMemory / tensorParallel;
  return worker.devices.filter(
    (device) =>
      (!model.deviceType || device.deviceType === model.deviceType) &&
      capability.supportedDeviceTypes.includes(device.deviceType as never) &&
      device.memoryAvailableBytes >= perDeviceRequired,
  );
}

export function isEligibleMoveTargetWorker(
  worker: WorkerInfo,
  model: ModelDetail,
  source: MovePlacementSource,
): boolean {
  const devices = compatibleMoveDevices(worker, model);
  const hasDistinctPlacement =
    worker.workerId !== source.workerId ||
    devices.some((device) => !source.deviceIndices.includes(device.deviceIndex));
  return devices.length >= (model.tensorParallel ?? 1) && hasDistinctPlacement;
}

/** Interpret instance records; the durable server-side transaction is intentionally not exposed. */
export function classifyMoveProgress(
  instances: InstanceDetail[] | undefined,
  sourceInstanceId: string,
  replacementInstanceId: string,
  replacementWasObserved = false,
  acceptedAt?: number,
  now = Date.now(),
): MoveProgress {
  if (!instances) return 'unavailable';
  const source = instances.find((instance) => instance.instanceId === sourceInstanceId);
  const replacement = instances.find((instance) => instance.instanceId === replacementInstanceId);
  // A 202 can precede cache/SSE propagation. Missing once is pending, not a failed move; only a
  // disappearance after observation is terminal evidence before cutover.
  if (!replacement) {
    const observationTimedOut =
      acceptedAt !== undefined && now - acceptedAt >= MOVE_REPLACEMENT_OBSERVATION_TIMEOUT_MS;
    return source && (replacementWasObserved || observationTimedOut)
      ? 'failed-before-cutover'
      : 'deploying';
  }
  if (
    replacement.state === ModelLifecycleState.ERROR ||
    replacement.state === ModelLifecycleState.STOPPED
  )
    return 'failed-before-cutover';
  if (!source) return replacement.state === ModelLifecycleState.ACTIVE ? 'complete' : 'unavailable';
  if (
    replacement.state === ModelLifecycleState.ACTIVE &&
    (source.state === ModelLifecycleState.ERROR || source.state === ModelLifecycleState.STOPPED)
  )
    return 'failed-after-cutover';
  if (
    replacement.state === ModelLifecycleState.ACTIVE &&
    source.state === ModelLifecycleState.DRAINING
  )
    return 'draining-source';
  if (
    replacement.state === ModelLifecycleState.ACTIVE &&
    source.state === ModelLifecycleState.ACTIVE
  )
    return 'cutting-over';
  return 'deploying';
}
