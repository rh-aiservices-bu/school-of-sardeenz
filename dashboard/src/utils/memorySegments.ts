/**
 * Deterministic per-model color assignment, shared by anything that renders a model as a
 * colored chip or chart segment (currently ModelsPlacementPanel, #163).
 *
 * Pre-#163 this file also held the reserved/used/available stacked-bar segment math for the
 * legacy WorkerGpuSection component. That component (and the whole "reserved" concept) was
 * removed in the measured-only doctrine round — device memory now has exactly one number
 * (measured `memoryUsedBytes`), so there is nothing left to compute segments from. Only the
 * color-hashing utilities survive, extended with a concrete hex palette: nivo's ResponsiveBar
 * renders to SVG/canvas and does not resolve PatternFly `var(--pf-t--...)` custom properties,
 * so it needs literal hex colors rather than the CSS var tokens PF6 components consume directly.
 */

/** Stable hash (djb2/FNV-style) of a string into `[0, length)`. */
function hashIndex(value: string, length: number): number {
  let h = 0;
  for (let i = 0; i < value.length; i++) h = (h * 31 + value.charCodeAt(i)) | 0;
  return Math.abs(h) % length;
}

// --- deterministic model palette (theme-aware PF6 chart tokens, for CSS contexts) ---
export const MODEL_PALETTE: readonly string[] = [
  'var(--pf-t--chart--color--blue--300)',
  'var(--pf-t--chart--color--green--300)',
  'var(--pf-t--chart--color--purple--300)',
  'var(--pf-t--chart--color--teal--300)',
  'var(--pf-t--chart--color--orange--300)',
  'var(--pf-t--chart--color--yellow--300)',
  'var(--pf-t--chart--color--red-orange--300)',
];

/** Stable string hash of a model name into the CSS-var palette. */
export function colorTokenForModel(modelName: string): string {
  return MODEL_PALETTE[hashIndex(modelName, MODEL_PALETTE.length)];
}

// --- same palette, as concrete hex values (for SVG/canvas contexts like nivo) ---
export const MODEL_PALETTE_HEX: readonly string[] = [
  '#0066CC', // blue
  '#3E8635', // green
  '#8481DD', // purple
  '#009596', // teal
  '#EC7A08', // orange
  '#F0AB00', // yellow
  '#C9190B', // red-orange
];

/** Stable string hash of a model name into the hex palette — same hash as colorTokenForModel,
 * so a model always maps to the "same" color whether rendered via CSS var or literal hex. */
export function colorHexForModel(modelName: string): string {
  return MODEL_PALETTE_HEX[hashIndex(modelName, MODEL_PALETTE_HEX.length)];
}
