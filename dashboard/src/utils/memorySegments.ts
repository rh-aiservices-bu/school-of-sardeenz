/**
 * Pure segment/color logic for the per-GPU stacked VRAM bar (#123).
 *
 * No React, no i18n — this is the testable core. Consumers (WorkerGpuSection.tsx) translate
 * `kind`/`modelName`/`sleeping`/`isEstimate` into tooltip/legend/aria text.
 */
import { ModelLifecycleState, type ControlPlaneComponents } from '@sardeenz/types';

type WorkerModelInfo = ControlPlaneComponents['schemas']['WorkerModelInfo'];
type DeviceInfo = ControlPlaneComponents['schemas']['DeviceInfo'];

export type SegmentKind = 'model' | 'other' | 'reserved' | 'available' | 'used';

export interface MemorySegment {
  /** React key: modelName+ordinal for models; kind for the rest. */
  key: string;
  kind: SegmentKind;
  /** Set for kind === 'model'. */
  modelName?: string;
  /** Absolute bytes represented (for tooltip). */
  bytes: number;
  /** 0..100; the returned array always sums to exactly 100. */
  widthPercent: number;
  /** A `var(--pf-t--…)` string. */
  colorToken: string;
  /** True only for model segments whose state === SLEEPING. */
  sleeping: boolean;
  /** True when this model's per-device bytes are an even-split estimate (tensor parallel). */
  isEstimate: boolean;
}

/** A model attributed to one device, with its per-device byte share already computed. */
export interface AttributedModel {
  modelName: string;
  state: WorkerModelInfo['state'];
  bytes: number;
  isEstimate: boolean;
}

// --- reserved (non-palette) colors, must never collide with a model ---
export const OTHER_COLOR_TOKEN = 'var(--pf-t--chart--color--black--300)';
export const AVAILABLE_COLOR_TOKEN = 'var(--pf-t--global--background--color--secondary--default)';
export const USED_COLOR_TOKEN = 'var(--pf-t--global--color--status--info--default)'; // legacy mode
export const RESERVED_COLOR_TOKEN = 'var(--pf-t--global--color--status--warning--default)'; // legacy mode

// --- deterministic model palette (theme-aware PF6 chart tokens) ---
export const MODEL_PALETTE: readonly string[] = [
  'var(--pf-t--chart--color--blue--300)',
  'var(--pf-t--chart--color--green--300)',
  'var(--pf-t--chart--color--purple--300)',
  'var(--pf-t--chart--color--teal--300)',
  'var(--pf-t--chart--color--orange--300)',
  'var(--pf-t--chart--color--yellow--300)',
  'var(--pf-t--chart--color--red-orange--300)',
];

/** Stable string hash (djb2/FNV-style) of a model name into the palette. */
export function colorTokenForModel(modelName: string): string {
  let h = 0;
  for (let i = 0; i < modelName.length; i++) h = (h * 31 + modelName.charCodeAt(i)) | 0;
  return MODEL_PALETTE[Math.abs(h) % MODEL_PALETTE.length];
}

/** Floor so an 80GiB card's 200MiB model is still visible as a rendered segment. */
export const MIN_SEGMENT_PERCENT = 1.5;

/**
 * Legacy / no-model path. Reproduces today's used|reserved|available math as three segments.
 * Guarantees continuity when a device has no attributed models.
 */
export function computeDeviceSegments(device: DeviceInfo): MemorySegment[] {
  const total = device.memoryTotalBytes > 0 ? device.memoryTotalBytes : 1;
  const usedPercent = Math.min(100, (device.memoryUsedBytes / total) * 100);
  const reservedPercent = Math.min(
    100 - usedPercent,
    ((device.memoryReservedBytes ?? 0) / total) * 100,
  );
  const availablePercent = Math.max(0, 100 - usedPercent - reservedPercent);

  const segments: MemorySegment[] = [];
  if (usedPercent > 0) {
    segments.push({
      key: 'used',
      kind: 'used',
      bytes: device.memoryUsedBytes,
      widthPercent: usedPercent,
      colorToken: USED_COLOR_TOKEN,
      sleeping: false,
      isEstimate: false,
    });
  }
  if (reservedPercent > 0) {
    segments.push({
      key: 'reserved',
      kind: 'reserved',
      bytes: device.memoryReservedBytes ?? 0,
      widthPercent: reservedPercent,
      colorToken: RESERVED_COLOR_TOKEN,
      sleeping: false,
      isEstimate: false,
    });
  }
  segments.push({
    key: 'available',
    kind: 'available',
    bytes: device.memoryAvailableBytes,
    widthPercent: availablePercent,
    colorToken: AVAILABLE_COLOR_TOKEN,
    sleeping: false,
    isEstimate: false,
  });
  return segments;
}

/**
 * Per-model path. `models` must already be attributed to this device with per-device bytes
 * (see WorkerGpuSection's adapter for attribution + tensor-parallel even-split).
 *
 * The returned segments always sum to exactly 100 — drift is absorbed by the final `available`
 * segment, and every running total is clamped so the track never overflows even on bad data
 * (e.g. #116 double-counted per-model bytes exceeding the device's reported used bytes).
 */
export function computeModelSegments(
  device: DeviceInfo,
  models: AttributedModel[],
): MemorySegment[] {
  const total = device.memoryTotalBytes > 0 ? device.memoryTotalBytes : 1;

  // Stable order: by modelName, then original (ordinal) position for same-name replicas.
  const ordered = models
    .map((m, ordinal) => ({ ...m, ordinal }))
    .filter((m) => (m.bytes ?? 0) > 0)
    .sort((a, b) => a.modelName.localeCompare(b.modelName) || a.ordinal - b.ordinal);

  const sumModels = ordered.reduce((sum, m) => sum + m.bytes, 0);
  const otherBytes = Math.max(0, device.memoryUsedBytes - sumModels);

  const raw: Array<{
    key: string;
    kind: SegmentKind;
    modelName?: string;
    bytes: number;
    colorToken: string;
    sleeping: boolean;
    isEstimate: boolean;
  }> = ordered.map((m) => ({
    key: `${m.modelName}#${m.ordinal}`,
    kind: 'model',
    modelName: m.modelName,
    bytes: m.bytes,
    colorToken: colorTokenForModel(m.modelName),
    sleeping: m.state === ModelLifecycleState.SLEEPING,
    isEstimate: m.isEstimate,
  }));

  if (otherBytes > 0) {
    raw.push({
      key: 'other',
      kind: 'other',
      bytes: otherBytes,
      colorToken: OTHER_COLOR_TOKEN,
      sleeping: false,
      isEstimate: false,
    });
  }

  const segments: MemorySegment[] = [];
  let running = 0;
  for (const seg of raw) {
    const remaining = 100 - running;
    if (remaining <= 0) continue;
    let width = Math.min((seg.bytes / total) * 100, remaining);
    if (width > 0 && width < MIN_SEGMENT_PERCENT) {
      width = Math.min(MIN_SEGMENT_PERCENT, remaining);
    }
    running += width;
    segments.push({ ...seg, widthPercent: width });
  }

  // Final `available` segment absorbs all rounding drift, never overflows.
  segments.push({
    key: 'available',
    kind: 'available',
    bytes: Math.max(0, device.memoryTotalBytes - device.memoryUsedBytes),
    widthPercent: Math.max(0, 100 - running),
    colorToken: AVAILABLE_COLOR_TOKEN,
    sleeping: false,
    isEstimate: false,
  });

  return segments;
}
