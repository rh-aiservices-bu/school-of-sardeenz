import { type ControlPlaneComponents } from '@sardeenz/types';

type ClusterMemory = ControlPlaneComponents['schemas']['ClusterMemory'];
export type MemoryWorker = ClusterMemory['workers'][number];
type WorkerModelInfo = ControlPlaneComponents['schemas']['WorkerModelInfo'];

export interface WorkerPlacement {
  /** deviceIndex -> single-device models placed on it (in device order). */
  byDevice: { deviceIndex: number; models: WorkerModelInfo[] }[];
  /** models spanning >1 device (tensor-parallel), each listed once. */
  tensorParallel: WorkerModelInfo[];
  /** models with no/empty deviceIndices while the worker has some attribution. */
  unplaced: WorkerModelInfo[];
  /** true when NO model on the worker has deviceIndices (pre-attribution worker). */
  placementUntracked: boolean;
}

export function groupWorkerPlacement(worker: MemoryWorker): WorkerPlacement {
  const models = worker.models ?? [];
  const hasAnyAttribution = models.some((m) => (m.deviceIndices?.length ?? 0) > 0);

  const tensorParallel = models.filter((m) => (m.deviceIndices?.length ?? 0) > 1);
  const single = models.filter((m) => (m.deviceIndices?.length ?? 0) === 1);
  const unplaced = models.filter((m) => (m.deviceIndices?.length ?? 0) === 0);

  const byDevice = worker.devices.map((d) => ({
    deviceIndex: d.deviceIndex,
    models: single.filter((m) => m.deviceIndices?.[0] === d.deviceIndex),
  }));

  return {
    byDevice,
    tensorParallel,
    unplaced: hasAnyAttribution ? unplaced : [],
    placementUntracked: !hasAnyAttribution && models.length > 0,
  };
}

/** Home board empty-state predicate. */
export function isClusterEmpty(memory?: ClusterMemory): boolean {
  return !memory || memory.workers.length === 0;
}
