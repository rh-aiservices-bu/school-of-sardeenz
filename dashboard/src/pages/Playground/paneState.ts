import type { PlaygroundLayout } from './LayoutSelector';

/**
 * Pure pane/session state transitions, extracted out of `InferenceWorkspace` so the
 * open/focus/close/resize logic can be unit-tested without a render harness (project
 * convention — see `__tests__/hooks/useModelLogs.test.ts`).
 *
 * Each pane holds at most one session, identified by model name; `null` means empty.
 */
export type Panes = (string | null)[];

export function initialPanes(layout: PlaygroundLayout): Panes {
  return layout === 'split' ? [null, null] : [null];
}

/**
 * Opens a session for `modelName`, or focuses it if already open in a pane (a no-op on the
 * array shape — there is nothing to reassign). Otherwise fills the first empty pane; if no pane
 * is empty, replaces the last pane's session.
 */
export function selectModel(panes: Panes, modelName: string): Panes {
  if (panes.includes(modelName)) return panes;

  const emptyIndex = panes.indexOf(null);
  const targetIndex = emptyIndex === -1 ? panes.length - 1 : emptyIndex;

  const next = [...panes];
  next[targetIndex] = modelName;
  return next;
}

export function closePane(panes: Panes, index: number): Panes {
  const next = [...panes];
  next[index] = null;
  return next;
}

/** Resizes the pane array to match the pane count for `layout`, preserving existing sessions. */
export function resizePanes(panes: Panes, layout: PlaygroundLayout): Panes {
  const size = layout === 'split' ? 2 : 1;
  if (panes.length === size) return panes;
  if (panes.length > size) return panes.slice(0, size);
  return [...panes, ...(Array(size - panes.length).fill(null) as null[])];
}
