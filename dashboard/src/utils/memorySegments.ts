/**
 * Deterministic per-model color assignment, shared by anything that renders a model as a
 * colored chip or chart segment (currently ModelsPlacementPanel, #163).
 *
 * Pre-#163 this file also held the reserved/used/available stacked-bar segment math for the
 * legacy WorkerGpuSection component. That component (and the whole "reserved" concept) was
 * removed in the measured-only doctrine round — device memory now has exactly one number
 * (measured `memoryUsedBytes`), so there is nothing left to compute segments from. Only the
 * color utilities survive, extended with a concrete hex palette: nivo's ResponsiveBar renders to
 * SVG/canvas and does not resolve PatternFly `var(--pf-t--...)` custom properties, so it needs
 * literal hex colors rather than the CSS var tokens PF6 components consume directly.
 *
 * Two ways to pick a color:
 * - `colorHexForModel` / `colorTokenForModel`: a pure hash of the name. Stable forever, but two
 *   names can hash to the same slot.
 * - `assignModelColors`: collision-free for a given set of names (the models currently shown).
 *   Each name still prefers its hash slot, so colors are stable across refreshes; a name only
 *   moves to the next free slot when it would otherwise share a color with another model on
 *   screen. Use this whenever the set of models is known up front.
 */

/** Stable hash (djb2/FNV-style) of a string into `[0, length)`. */
function hashIndex(value: string, length: number): number {
  let h = 0;
  for (let i = 0; i < value.length; i++) h = (h * 31 + value.charCodeAt(i)) | 0;
  return Math.abs(h) % length;
}

// --- deterministic model palette (theme-aware PF6 chart tokens, for CSS contexts) ---
// Two rings of the seven chromatic PF6 chart hues: the 200 shades first, then the darker 400
// shades. Consecutive slots always differ in hue, so a collision that moves a model one slot on
// still yields a clearly different color. Black/gray shades are reserved for Other/Free/KVCache.
export const MODEL_PALETTE: readonly string[] = [
  'var(--pf-t--chart--color--blue--200)',
  'var(--pf-t--chart--color--green--200)',
  'var(--pf-t--chart--color--purple--200)',
  'var(--pf-t--chart--color--teal--200)',
  'var(--pf-t--chart--color--orange--200)',
  'var(--pf-t--chart--color--yellow--200)',
  'var(--pf-t--chart--color--red-orange--200)',
  'var(--pf-t--chart--color--blue--400)',
  'var(--pf-t--chart--color--green--400)',
  'var(--pf-t--chart--color--purple--400)',
  'var(--pf-t--chart--color--teal--400)',
  'var(--pf-t--chart--color--orange--400)',
  'var(--pf-t--chart--color--yellow--400)',
  'var(--pf-t--chart--color--red-orange--400)',
];

/** Stable string hash of a model name into the CSS-var palette. */
export function colorTokenForModel(modelName: string): string {
  return MODEL_PALETTE[hashIndex(modelName, MODEL_PALETTE.length)];
}

// --- same palette, as concrete hex values (for SVG/canvas contexts like nivo) ---
export const MODEL_PALETTE_HEX: readonly string[] = [
  '#0066CC', // blue 200
  '#63993D', // green 200
  '#5E40BE', // purple 200
  '#37A3A3', // teal 200
  '#CA6C0F', // orange 200
  '#B98412', // yellow 200
  '#F0561D', // red-orange 200
  '#003366', // blue 400
  '#204D00', // green 400
  '#21134D', // purple 400
  '#004D4D', // teal 400
  '#732E00', // orange 400
  '#73480B', // yellow 400
  '#731F00', // red-orange 400
];

/** Stable string hash of a model name into the hex palette — same hash as colorTokenForModel,
 * so a model always maps to the "same" color whether rendered via CSS var or literal hex. */
export function colorHexForModel(modelName: string): string {
  return MODEL_PALETTE_HEX[hashIndex(modelName, MODEL_PALETTE_HEX.length)];
}

/**
 * Collision-free palette slots for a set of model names.
 *
 * Names are visited in sorted order (so the result is independent of input order). Each takes
 * its hash slot if free, else the next free slot (linear probing). Once every slot is in use —
 * more models than palette entries — a name takes the least-used slot from its hash position on,
 * so repeats spread evenly instead of piling onto one color.
 */
export function assignModelColors(modelNames: Iterable<string>): Map<string, number> {
  const size = MODEL_PALETTE_HEX.length;
  const names = Array.from(new Set(modelNames)).sort((a, b) => a.localeCompare(b));
  const uses = new Array<number>(size).fill(0);
  const assignment = new Map<string, number>();

  for (const name of names) {
    const start = hashIndex(name, size);
    let slot = start;
    let best = start;
    for (let step = 0; step < size; step++) {
      slot = (start + step) % size;
      if (uses[slot] === 0) {
        best = slot;
        break;
      }
      if (uses[slot] < uses[best]) best = slot;
    }
    uses[best] += 1;
    assignment.set(name, best);
  }

  return assignment;
}

export function hexForColorIndex(index: number): string {
  return MODEL_PALETTE_HEX[index % MODEL_PALETTE_HEX.length];
}

export function tokenForColorIndex(index: number): string {
  return MODEL_PALETTE[index % MODEL_PALETTE.length];
}
