/**
 * Pure logic for ModelsPlacementPanel (#163 — v1 GpuMemoryPanel port).
 *
 * Kept separate from the component so it's testable without rendering PatternFly/nivo (the
 * project's established pure-logic-test convention — see MemoryVisualization.test.tsx's
 * predecessor and ModelList.test.ts).
 */
import { ModelLifecycleState, type ControlPlaneComponents } from '@sardeenz/types';
import { colorHexForModel } from './memorySegments';

type DeviceInfo = ControlPlaneComponents['schemas']['DeviceInfo'];
type WorkerModelInfo = ControlPlaneComponents['schemas']['WorkerModelInfo'];

export const OTHER_COLOR_HEX = '#8B8D8F';
export const FREE_COLOR_HEX = '#D2D2D2';
export const SLEEPING_PATTERN_ID = 'sleeping-pattern';

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
  /** Single-row nivo dataset for the KVCache sub-bar (v1 buildKvcacheData port, #165). */
  data: [{ id: 'KVCache'; Prealloc: number; Used: number; Free: number }];
  keys: ['Prealloc', 'Used', 'Free'];
  totalBytes: number;
  usedBytes: number;
  preallocBytes: number;
  freeBytes: number;
}

/**
 * Build the nivo dataset for one device's KVCache sub-bar (issue #165, v1 `buildKvcacheData`
 * port). Renders only when the device carries a kvcached pool report with capacity > 0 AND the
 * worker actually has models on it (a pool with nothing serving is not interesting — same
 * guard as v1). Returns null when the sub-bar should be omitted.
 */
export function buildKvcacheData(
  device: DeviceInfo,
  hasModels: boolean,
): KvcacheBarData | null {
  const kvcache = device.kvCache;
  if (!kvcache || kvcache.totalBytes <= 0 || !hasModels) return null;
  return {
    data: [
      {
        id: 'KVCache',
        Prealloc: kvcache.preallocBytes,
        Used: kvcache.usedBytes,
        Free: kvcache.freeBytes,
      },
    ],
    keys: ['Prealloc', 'Used', 'Free'],
    totalBytes: kvcache.totalBytes,
    usedBytes: kvcache.usedBytes,
    preallocBytes: kvcache.preallocBytes,
    freeBytes: kvcache.freeBytes,
  };
}

/** nivo `defs`/`fill` pattern for sleeping model segments (diagonal hatching, v1 parity). */
export const SLEEPING_PATTERN_DEFS = [
  {
    id: SLEEPING_PATTERN_ID,
    type: 'patternLines' as const,
    background: 'inherit',
    color: 'rgba(0, 0, 0, 0.3)',
    rotation: -45,
    lineWidth: 3,
    spacing: 8,
  },
];

export interface AttributedModelBytes {
  /** Unique key for this attribution: `${modelName}#${instanceId}` when instanceId is known
   * (distinguishes co-located replicas of the same model), else just modelName. */
  key: string;
  modelName: string;
  displayName?: string;
  instanceId?: string;
  state: WorkerModelInfo['state'];
  /** Measured bytes attributed to this device (tensor-parallel models split evenly). */
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
  /** Single-row nivo dataset — one object with one key per stacked segment. */
  data: [Record<string, number | string>];
  keys: string[];
  colors: Record<string, string>;
  fill: Array<{ match: { id: string }; id: string }>;
  /** Ordered attribution entries actually rendered (bytes > 0), for building the legend. */
  entries: AttributedModelBytes[];
  otherBytes: number;
  freeBytes: number;
}

/**
 * Build the nivo ResponsiveBar props for one device's stacked VRAM bar (v1 port).
 *
 * Segment order: attributed models (stable: by modelName, then instanceId) → Other (used bytes
 * not accounted for by any attributed model) → Free (total − used). All doctrine-measured: every
 * byte figure here traces back to `device.memoryUsedBytes`, the NVML measurement — there is no
 * separate "reserved" or "allocated estimate" concept anymore.
 */
export function buildDeviceBarData(
  device: DeviceInfo,
  attributed: AttributedModelBytes[],
): DeviceBarData {
  const dataObj: Record<string, number | string> = { id: 'GPU' };
  const keys: string[] = [];
  const colors: Record<string, string> = {};
  const fill: Array<{ match: { id: string }; id: string }> = [];

  const ordered = [...attributed]
    .filter((m) => m.bytes > 0)
    .sort(
      (a, b) =>
        a.modelName.localeCompare(b.modelName) ||
        (a.instanceId ?? '').localeCompare(b.instanceId ?? ''),
    );

  for (const model of ordered) {
    dataObj[model.key] = model.bytes;
    keys.push(model.key);
    colors[model.key] = colorHexForModel(model.modelName);
    if (model.sleeping) fill.push({ match: { id: model.key }, id: SLEEPING_PATTERN_ID });
  }

  const attributedTotal = ordered.reduce((sum, m) => sum + m.bytes, 0);
  const otherBytes = Math.max(0, device.memoryUsedBytes - attributedTotal);
  if (otherBytes > 0) {
    dataObj['Other'] = otherBytes;
    keys.push('Other');
    colors['Other'] = OTHER_COLOR_HEX;
  }

  const freeBytes = Math.max(0, device.memoryTotalBytes - device.memoryUsedBytes);
  dataObj['Free'] = freeBytes;
  keys.push('Free');
  colors['Free'] = FREE_COLOR_HEX;

  return { data: [dataObj], keys, colors, fill, entries: ordered, otherBytes, freeBytes };
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
