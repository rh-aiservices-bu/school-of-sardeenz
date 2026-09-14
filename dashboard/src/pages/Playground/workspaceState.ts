import type { ModelInfo } from '../../api/client';
import {
  paneCount,
  SESSION_STORAGE_KEY,
  WORKSPACE_STORAGE_KEY,
  LAYOUT_MODES,
  type LayoutMode,
  type PaneAssignments,
  type WorkspaceSession,
} from './workspace-types';

/**
 * Pure state transitions for the inference workspace, extracted out of `useWorkspaceState` so
 * the session/pane logic can be unit-tested without a render harness (project convention — see
 * `__tests__/hooks/useModelLogs.test.ts`). Ported from v1's `useWorkspaceState.ts`.
 */

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export interface PersistedPreferences {
  layout: LayoutMode;
  sidebarExpanded: boolean;
  paneAssignments: PaneAssignments;
}

export interface PersistedSessionData {
  openModelIds: string[];
  activeModelId: string | null;
}

function isLayoutMode(value: unknown): value is LayoutMode {
  return typeof value === 'string' && (LAYOUT_MODES as readonly string[]).includes(value);
}

export function loadPersistedPreferences(
  storage: Pick<Storage, 'getItem'> | undefined = safeStorage('local'),
): Partial<PersistedPreferences> {
  try {
    const stored = storage?.getItem(WORKSPACE_STORAGE_KEY);
    if (!stored) return {};
    const parsed = JSON.parse(stored) as Partial<PersistedPreferences>;
    const prefs: Partial<PersistedPreferences> = {};
    if (isLayoutMode(parsed.layout)) prefs.layout = parsed.layout;
    if (typeof parsed.sidebarExpanded === 'boolean') prefs.sidebarExpanded = parsed.sidebarExpanded;
    if (parsed.paneAssignments && typeof parsed.paneAssignments === 'object') {
      prefs.paneAssignments = parsed.paneAssignments;
    }
    return prefs;
  } catch {
    return {};
  }
}

export function savePersistedPreferences(
  prefs: PersistedPreferences,
  storage: Pick<Storage, 'setItem'> | undefined = safeStorage('local'),
): void {
  try {
    storage?.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Ignore storage errors (private mode, quota)
  }
}

export function loadPersistedSessionData(
  storage: Pick<Storage, 'getItem'> | undefined = safeStorage('session'),
): PersistedSessionData | null {
  try {
    const stored = storage?.getItem(SESSION_STORAGE_KEY);
    if (!stored) return null;
    const parsed = JSON.parse(stored) as Partial<PersistedSessionData>;
    if (!Array.isArray(parsed.openModelIds)) return null;
    return {
      openModelIds: parsed.openModelIds.filter((id): id is string => typeof id === 'string'),
      activeModelId: typeof parsed.activeModelId === 'string' ? parsed.activeModelId : null,
    };
  } catch {
    return null;
  }
}

export function savePersistedSessionData(
  data: PersistedSessionData,
  storage: Pick<Storage, 'setItem'> | undefined = safeStorage('session'),
): void {
  try {
    storage?.setItem(SESSION_STORAGE_KEY, JSON.stringify(data));
  } catch {
    // Ignore storage errors
  }
}

export function clearPersistedSessionData(
  storage: Pick<Storage, 'removeItem'> | undefined = safeStorage('session'),
): void {
  try {
    storage?.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // Ignore storage errors
  }
}

function safeStorage(kind: 'local' | 'session'): Storage | undefined {
  try {
    if (typeof window === 'undefined') return undefined;
    return kind === 'local' ? window.localStorage : window.sessionStorage;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export function createSession(model: ModelInfo, id: string = newSessionId()): WorkspaceSession {
  return {
    id,
    modelId: model.modelName,
    model,
    status: 'idle',
    addedAt: new Date().toISOString(),
  };
}

export function newSessionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Sessions ordered by creation time (oldest first). */
export function sortSessions(sessions: Iterable<WorkspaceSession>): WorkspaceSession[] {
  return Array.from(sessions).sort(
    (a, b) => new Date(a.addedAt).getTime() - new Date(b.addedAt).getTime(),
  );
}

/**
 * Which sessions the grid should render for `layout`.
 * - single: the active session, else the oldest one
 * - split-2 / grid-4: explicit pane assignments where valid, otherwise creation order
 */
export function getVisibleSessions(
  sessions: Map<string, WorkspaceSession>,
  activeSessionId: string | null,
  layout: LayoutMode,
  assignments: PaneAssignments,
): WorkspaceSession[] {
  const allSessions = sortSessions(sessions.values());
  if (allSessions.length === 0) return [];

  if (layout === 'single') {
    const active = activeSessionId ? sessions.get(activeSessionId) : undefined;
    return active ? [active] : allSessions.slice(0, 1);
  }

  const maxPanes = paneCount(layout);
  const result: WorkspaceSession[] = [];
  const used = new Set<string>();

  for (let paneIndex = 0; paneIndex < maxPanes; paneIndex++) {
    const assignedId = assignments[paneIndex];
    const assigned = assignedId ? sessions.get(assignedId) : undefined;

    if (assigned && !used.has(assigned.id)) {
      result.push(assigned);
      used.add(assigned.id);
      continue;
    }

    const fallback = allSessions.find((s) => !used.has(s.id));
    if (fallback) {
      result.push(fallback);
      used.add(fallback.id);
    }
  }

  return result;
}

/** Drops `sessionId` from the assignments map. Returns the same object when nothing changed. */
export function removeSessionAssignment(
  assignments: PaneAssignments,
  sessionId: string,
): PaneAssignments {
  if (!Object.values(assignments).includes(sessionId)) return assignments;
  const next: PaneAssignments = {};
  for (const [paneIndex, assignedId] of Object.entries(assignments)) {
    if (assignedId !== sessionId) next[Number(paneIndex)] = assignedId;
  }
  return next;
}

/**
 * Assigns `sessionId` to `paneIndex`. `null` clears the pane (back to auto). If the session is
 * already shown in another pane, the two panes swap assignments.
 */
export function assignSessionToPane(
  assignments: PaneAssignments,
  paneIndex: number,
  sessionId: string | null,
): PaneAssignments {
  const next = { ...assignments };

  if (sessionId === null) {
    delete next[paneIndex];
    return next;
  }

  const existingPane = Object.entries(assignments).find(([, id]) => id === sessionId)?.[0];
  if (existingPane !== undefined) {
    const current = assignments[paneIndex];
    if (current) {
      next[Number(existingPane)] = current;
    } else {
      delete next[Number(existingPane)];
    }
  }

  next[paneIndex] = sessionId;
  return next;
}

export interface SyncResult {
  sessions: Map<string, WorkspaceSession>;
  /** Set only when sessions were restored from persisted data. */
  restoredActiveSessionId?: string | null;
  changed: boolean;
}

/**
 * Reconciles open sessions with the models currently chattable:
 * - drops sessions whose model is gone
 * - refreshes `session.model` when the model's state or presentation changed
 * - when there are no sessions, restores the ones persisted in sessionStorage
 */
export function syncSessions(
  prev: Map<string, WorkspaceSession>,
  deployableModels: ModelInfo[],
  persisted: PersistedSessionData | null,
  makeId: () => string = newSessionId,
): SyncResult {
  const modelById = new Map(deployableModels.map((m) => [m.modelName, m]));
  const updated = new Map(prev);
  let changed = false;

  for (const [sessionId, session] of prev) {
    const model = modelById.get(session.modelId);
    if (!model) {
      updated.delete(sessionId);
      changed = true;
      continue;
    }
    const modelChanged =
      model.state !== session.model.state ||
      model.displayName !== session.model.displayName ||
      model.instanceCount !== session.model.instanceCount ||
      model.runnerType !== session.model.runnerType;
    if (modelChanged) {
      updated.set(sessionId, { ...session, model });
      changed = true;
    }
  }

  if (prev.size > 0 || !persisted || persisted.openModelIds.length === 0) {
    return { sessions: changed ? updated : prev, changed };
  }

  let firstSessionId: string | null = null;
  let activeRestoredSessionId: string | null = null;

  for (const modelId of persisted.openModelIds) {
    const model = modelById.get(modelId);
    if (!model) continue;
    const session = createSession(model, makeId());
    updated.set(session.id, session);
    changed = true;
    firstSessionId ??= session.id;
    if (modelId === persisted.activeModelId) activeRestoredSessionId = session.id;
  }

  if (!changed) return { sessions: prev, changed: false };

  return {
    sessions: updated,
    changed: true,
    restoredActiveSessionId: activeRestoredSessionId ?? firstSessionId,
  };
}
