/**
 * Pure logic for ModelsPlacementPanel (#163 — v1 GpuMemoryPanel port).
 *
 * Kept separate from the component so it's testable without rendering PatternFly charts (the
 * project's established pure-logic-test convention — see MemoryVisualization.test.tsx's
 * predecessor and ModelList.test.ts).
 */
import { ModelLifecycleState, type ControlPlaneComponents } from '@sardeenz/types';
import { colorHexForModel } from './memorySegments';

type DeviceInfo = ControlPlaneComponents['schemas']['DeviceInfo'];
type WorkerModelInfo = ControlPlaneComponents['schemas']['WorkerModelInfo'];

export const OTHER_COLOR_HEX = '#8B8D8F';
export const FREE_COLOR_HEX = '#D2D2D2';

/**
 * One segment of a stacked bar, chart-library agnostic (#255: the panel renders these with
 * PatternFly charts / victory, one bar series per segment).
 */
export interface StackedBarSegment {
  /** Segment identity: `${modelName}#${instanceId}`, `Other`, `Free`, or a KVCache key. */
  key: string;
  /** Measured bytes — the segment's stacked length. */
  bytes: number;
  color: string;
  /** Sleeping model: drawn at reduced opacity (same treatment as the compact view's CSS bar). */
  sleeping: boolean;
}

/**
 * KVCache mini-bar segment colors.
 *
 * Deliberately grayscale and disjoint from MODEL_PALETTE_HEX: the model palette already spans all
 * seven chromatic PF6 chart hues, so the only chart family guaranteed never to collide with a
 * model segment is the neutral gray (`--pf-t--chart--color--black--*`) scale. Grayscale also reads
 * as a *different metric* than the colorful per-model VRAM segments. Lightness encodes filledness:
 * Free lightest → Prealloc mid → Used darkest.
 */
export const KVCACHE_COLORS: Record<'Prealloc' | 'Used' | 'Free', string> = {
  Prealloc: '#A3A3A3',
  Used: '#707070',
  Free: '#E0E0E0',
};

export interface KvcacheBarData {
  /** Prealloc → Used → Free, in render order (v1 buildKvcacheData port, #165). */
  segments: StackedBarSegment[];
  totalBytes: number;
  usedBytes: number;
  preallocBytes: number;
  freeBytes: number;
}

/**
 * Build the stacked segments for one device's KVCache sub-bar (issue #165, v1 `buildKvcacheData`
 * port). Renders only when the device carries a kvcached pool report with capacity > 0 AND the
 * worker actually has models on it (a pool with nothing serving is not interesting — same
 * guard as v1). Returns null when the sub-bar should be omitted.
 */
export function buildKvcacheData(device: DeviceInfo, hasModels: boolean): KvcacheBarData | null {
  const kvcache = device.kvCache;
  if (!kvcache || kvcache.totalBytes <= 0 || !hasModels) return null;
  return {
    segments: [
      {
        key: 'Prealloc',
        bytes: kvcache.preallocBytes,
        color: KVCACHE_COLORS.Prealloc,
        sleeping: false,
      },
      { key: 'Used', bytes: kvcache.usedBytes, color: KVCACHE_COLORS.Used, sleeping: false },
      { key: 'Free', bytes: kvcache.freeBytes, color: KVCACHE_COLORS.Free, sleeping: false },
    ],
    totalBytes: kvcache.totalBytes,
    usedBytes: kvcache.usedBytes,
    preallocBytes: kvcache.preallocBytes,
    freeBytes: kvcache.freeBytes,
  };
}

export interface AttributedModelBytes {
  /** Unique key for this attribution: `${modelName}#${instanceId}` when instanceId is known
   * (distinguishes co-located replicas of the same model), else just modelName. */
  key: string;
  modelName: string;
  displayName?: string;
  instanceId?: string;
  state: WorkerModelInfo['state'];
  /** Measured bytes attributed to this device (tensor-parallel models split evenly). Figures
   * arrive already scope-deduped by the control plane (ADR-027 summation rule, #278): device-
   * or unknown-scope memory rows never reach `WorkerModelInfo.memoryUsedBytes` when anything
   * co-resident reports, so no panel-side dedupe exists — the dropped bytes surface in Other. */
  bytes: number;
  sleeping: boolean;
}

/**
 * Attribute a worker's models to one of its devices.
 *
 * Models carrying `deviceIndices` are attributed to the devices they name — a tensor-parallel
 * model (deviceIndices.length > 1) splits its `memoryUsedBytes` evenly across them, since the
 * contract reports one aggregate figure per instance, not a per-device breakdown. When NO model
 * on the worker carries `deviceIndices` at all (data from before device-attribution tracking),
 * every model is attributed to the device only when the worker has exactly one — with more than
 * one device there's no way to say which GPU holds what, so nothing is attributed and the whole
 * used amount falls through to the "Other" bucket in buildDeviceBarData.
 *
 * The per-instance figures are already scope-deduped upstream: the control plane's summation
 * (ADR-027 Decision 4, issue #278) drops device-/unknown-scope memory rows from
 * `WorkerModelInfo.memoryUsedBytes` whenever anything co-resident reports on the same device,
 * so a co-located whole-device observation can never be summed into these per-model bars.
 */
export function attributeModelsToDevice(
  device: DeviceInfo,
  workerDeviceCount: number,
  models: WorkerModelInfo[] | undefined,
): AttributedModelBytes[] {
  if (!models?.length) return [];

  const hasAnyAttribution = models.some((m) => (m.deviceIndices?.length ?? 0) > 0);
  const forDevice = hasAnyAttribution
    ? models.filter((m) => m.deviceIndices?.includes(device.deviceIndex))
    : workerDeviceCount === 1
      ? models
      : [];

  return forDevice.map((m) => {
    const deviceCount = Math.max(1, m.deviceIndices?.length ?? 1);
    const bytes = (m.memoryUsedBytes ?? 0) / deviceCount;
    return {
      key: m.instanceId ? `${m.modelName}#${m.instanceId}` : m.modelName,
      modelName: m.modelName,
      displayName: m.displayName,
      instanceId: m.instanceId,
      state: m.state,
      bytes,
      sleeping: m.state === ModelLifecycleState.SLEEPING,
    };
  });
}

export interface DeviceBarData {
  /** Stacked segments in render order: models (stable) → Other → Free. */
  segments: StackedBarSegment[];
  /** Ordered attribution entries actually rendered (bytes > 0), for building the legend. */
  entries: AttributedModelBytes[];
  otherBytes: number;
  freeBytes: number;
}

/**
 * Build the stacked segments for one device's VRAM bar (v1 port).
 *
 * Segment order: attributed models (stable: by modelName, then instanceId) → Other (used bytes
 * not accounted for by any attributed model) → Free (total − used). All doctrine-measured: every
 * byte figure here traces back to `device.memoryUsedBytes`, the NVML measurement — there is no
 * separate "reserved" or "allocated estimate" concept anymore.
 */
export function buildDeviceBarData(
  device: DeviceInfo,
  attributed: AttributedModelBytes[],
  /** Color per model name. Defaults to the pure hash; pass a panel-wide collision-free
   * assignment (`assignModelColors`) so co-displayed models never share a color. */
  colorFor: (modelName: string) => string = colorHexForModel,
): DeviceBarData {
  const ordered = [...attributed]
    .filter((m) => m.bytes > 0)
    .sort(
      (a, b) =>
        a.modelName.localeCompare(b.modelName) ||
        (a.instanceId ?? '').localeCompare(b.instanceId ?? ''),
    );

  const segments: StackedBarSegment[] = ordered.map((model) => ({
    key: model.key,
    bytes: model.bytes,
    color: colorFor(model.modelName),
    sleeping: model.sleeping,
  }));

  const attributedTotal = ordered.reduce((sum, m) => sum + m.bytes, 0);
  const otherBytes = Math.max(0, device.memoryUsedBytes - attributedTotal);
  if (otherBytes > 0) {
    segments.push({ key: 'Other', bytes: otherBytes, color: OTHER_COLOR_HEX, sleeping: false });
  }

  const freeBytes = Math.max(0, device.memoryTotalBytes - device.memoryUsedBytes);
  segments.push({ key: 'Free', bytes: freeBytes, color: FREE_COLOR_HEX, sleeping: false });

  return { segments, entries: ordered, otherBytes, freeBytes };
}

/**
 * One inline segment of the worker-level bar (compact view): a co-located model grouping, or
 * Other/Free rendered separately by the caller.
 */
export interface WorkerBarSegment {
  /** Key: `${modelName}` — compact view aggregates replicas of the same model into one segment. */
  key: string;
  /** Served name shown to users (`WorkerModelInfo.displayName`), falling back to the model name. */
  displayName: string;
  color: string;
  bytes: number;
  sleeping: boolean;
}

/** Worker-level rollup for the compact view's inline CSS bar. */
export interface WorkerBarData {
  /** Per-model segments, largest first. */
  segments: WorkerBarSegment[];
  /** Used bytes not attributable to any model on the worker's devices. */
  otherBytes: number;
  /** Sum of per-device free bytes (each clamped at zero). */
  freeBytes: number;
}

/**
 * Build the compact view's worker-level bar data: models aggregated across the worker's devices
 * (replicas of the same model collapse into one segment), then Other (used bytes no model
 * accounts for), then Free (sum of per-device free bytes). Same measured-only doctrine as
 * buildDeviceBarData — every figure traces back to device.memoryUsedBytes.
 */
export function buildWorkerBarData(
  devices: DeviceInfo[],
  models: WorkerModelInfo[] | undefined,
  colorFor: (modelName: string) => string = colorHexForModel,
): WorkerBarData {
  const totalBytes = new Map<string, { bytes: number; sleeping: boolean }>();
  for (const model of models ?? []) {
    if ((model.memoryUsedBytes ?? 0) <= 0) continue;
    const entry = totalBytes.get(model.modelName) ?? { bytes: 0, sleeping: false };
    entry.bytes += model.memoryUsedBytes ?? 0;
    entry.sleeping = entry.sleeping || model.state === ModelLifecycleState.SLEEPING;
    totalBytes.set(model.modelName, entry);
  }

  const segments = [...totalBytes.entries()]
    .map(([modelName, entry]) => ({
      key: modelName,
      displayName: models?.find((m) => m.modelName === modelName)?.displayName ?? modelName,
      color: colorFor(modelName),
      bytes: entry.bytes,
      sleeping: entry.sleeping,
    }))
    .sort((a, b) => b.bytes - a.bytes || a.key.localeCompare(b.key));

  const usedBytes = devices.reduce((sum, d) => sum + d.memoryUsedBytes, 0);
  const attributedTotal = segments.reduce((sum, s) => sum + s.bytes, 0);
  const otherBytes = Math.max(0, usedBytes - attributedTotal);
  const freeBytes = devices.reduce(
    (sum, d) => sum + Math.max(0, d.memoryTotalBytes - d.memoryUsedBytes),
    0,
  );

  return { segments, otherBytes, freeBytes };
}

/** Worker-level rollup: total GPUs, total attributed models, and overall VRAM percent used. */
export function summarizeWorkerVram(devices: DeviceInfo[]): {
  usedPercent: number;
  totalBytes: number;
  usedBytes: number;
} {
  const totalBytes = devices.reduce((sum, d) => sum + d.memoryTotalBytes, 0);
  const usedBytes = devices.reduce((sum, d) => sum + d.memoryUsedBytes, 0);
  const usedPercent = totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 100) : 0;
  return { usedPercent, totalBytes, usedBytes };
}
