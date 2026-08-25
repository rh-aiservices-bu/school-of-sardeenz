// Pure composition of one NVML sample (per-device totals + the raw GPU process list) with the
// RunnerManager's PID ownership list into the MeasuredMemorySample WorkerRegistration folds into
// its report. Kept separate from index.ts — which merely wires an NvmlReader and a RunnerManager
// into this function — so the attribution logic (summing several processes into one
// (instanceId, deviceIndex) total, letting an unowned process fall back to the device-only
// figure) is unit-testable without a real NVML session or RunnerManager.
import { resolveOwner as resolveOwnerFromProcTree } from './proc-tree.js';
import type { NvmlDeviceMemory, NvmlProcessMemory } from './nvml.js';
import type { MeasuredDeviceSample, MeasuredMemorySample } from './registration.js';

/** A runner this worker started, as reported by RunnerManager.getRunnerProcesses(). */
export interface RunnerProcessOwner {
  pid: number;
  instanceId: string;
  modelName: string;
}

// Resolves an NVML-reported process pid to the owner pid (from `ownerPids`) whose process tree it
// descends from, or null if it belongs to none of them. Injectable so buildMeasuredSample can be
// tested without walking real /proc entries.
export type ResolveOwnerFn = (pid: number, ownerPids: Set<number>) => number | null;

const defaultResolveOwner: ResolveOwnerFn = (pid, ownerPids) =>
  resolveOwnerFromProcTree(pid, ownerPids);

// Builds the measured sample: device figures are passed through as-is (one entry per NVML
// device), while `instances` sums each attributable process's bytes into its owning runner's
// (instanceId, deviceIndex) bucket. A process that resolves to no owner (not started by this
// worker, or a stray host process) is skipped — it still counts toward the device figure above
// since that comes straight from NVML, but it contributes no instance entry.
export function buildMeasuredSample(
  deviceSamples: NvmlDeviceMemory[],
  processSamples: NvmlProcessMemory[],
  owners: RunnerProcessOwner[],
  resolveOwner: ResolveOwnerFn = defaultResolveOwner,
): MeasuredMemorySample {
  const devices: MeasuredDeviceSample[] = deviceSamples.map((d) => {
    const out: MeasuredDeviceSample = { deviceIndex: d.deviceIndex, memoryUsedBytes: d.usedBytes };
    if (d.name !== undefined) out.deviceName = d.name;
    if (d.utilizationPercent !== undefined) out.utilizationPercent = d.utilizationPercent;
    if (d.temperatureC !== undefined) out.temperatureC = d.temperatureC;
    return out;
  });

  const ownerPids = new Set(owners.map((o) => o.pid));
  const ownerByPid = new Map(owners.map((o) => [o.pid, o]));

  const instanceTotals = new Map<
    string,
    { instanceId: string; modelName: string; deviceIndex: number; memoryUsedBytes: number }
  >();
  for (const proc of processSamples) {
    const ownerPid = resolveOwner(proc.pid, ownerPids);
    if (ownerPid === null) continue; // not one of ours — contributes to the device figure only
    const owner = ownerByPid.get(ownerPid)!;
    const key = `${owner.instanceId}:${proc.deviceIndex}`;
    const existing = instanceTotals.get(key);
    if (existing) {
      existing.memoryUsedBytes += proc.usedBytes;
    } else {
      instanceTotals.set(key, {
        instanceId: owner.instanceId,
        modelName: owner.modelName,
        deviceIndex: proc.deviceIndex,
        memoryUsedBytes: proc.usedBytes,
      });
    }
  }

  return { devices, instances: Array.from(instanceTotals.values()) };
}
