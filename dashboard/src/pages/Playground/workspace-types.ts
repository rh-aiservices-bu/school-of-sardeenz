import type { ModelInfo } from '../../api/client';

/**
 * Layout mode for the workspace area (v1 parity).
 * - single: one chat visible at a time
 * - split-2: two chats side by side
 * - grid-4: four chats in a 2x2 grid
 */
export type LayoutMode = 'single' | 'split-2' | 'grid-4';

export const LAYOUT_MODES: readonly LayoutMode[] = ['single', 'split-2', 'grid-4'];

/** Number of panes a layout renders. */
export function paneCount(layout: LayoutMode): number {
  switch (layout) {
    case 'split-2':
      return 2;
    case 'grid-4':
      return 4;
    default:
      return 1;
  }
}

/**
 * Maps pane positions to session IDs for explicit assignment.
 * Position 0 = first pane, 1 = second pane, etc. A missing entry means "auto-assign"
 * (fallback to creation order).
 */
export type PaneAssignments = Record<number, string | null>;

export type SessionStatus = 'idle' | 'generating';

/** One open chat session in the workspace: a model plus its generation status. */
export interface WorkspaceSession {
  id: string;
  /** Configuration name — the proxy routing key (ADR-020). */
  modelId: string;
  model: ModelInfo;
  status: SessionStatus;
  addedAt: string;
}

export interface WorkspaceState {
  sessions: Map<string, WorkspaceSession>;
  activeSessionId: string | null;
  layout: LayoutMode;
  sidebarExpanded: boolean;
  searchTerm: string;
  expandedGpuGroups: Set<string>;
  paneAssignments: PaneAssignments;
}

export interface WorkspaceActions {
  addSession: (model: ModelInfo) => void;
  removeSession: (sessionId: string) => void;
  setActiveSession: (sessionId: string | null) => void;
  updateSessionStatus: (sessionId: string, status: SessionStatus) => void;
  setLayout: (layout: LayoutMode) => void;
  toggleSidebar: () => void;
  setSidebarExpanded: (expanded: boolean) => void;
  setSearchTerm: (term: string) => void;
  toggleGpuGroup: (gpuKey: string) => void;
  getVisibleSessions: () => WorkspaceSession[];
  isModelOpen: (modelId: string) => boolean;
  findSessionByModelId: (modelId: string) => WorkspaceSession | undefined;
  clearAllSessions: () => void;
  syncSessions: (deployableModels: ModelInfo[]) => void;
  assignSessionToPane: (paneIndex: number, sessionId: string | null) => void;
  clearPaneAssignments: () => void;
}

/** localStorage key for workspace preferences (layout, sidebar, pane assignments). */
export const WORKSPACE_STORAGE_KEY = 'sardeenz-inference-workspace';

/** sessionStorage key for open session model IDs — survives refresh, clears on tab close. */
export const SESSION_STORAGE_KEY = 'sardeenz-inference-sessions';

export const DEFAULT_WORKSPACE_STATE: Omit<WorkspaceState, 'sessions' | 'expandedGpuGroups'> = {
  activeSessionId: null,
  layout: 'single',
  sidebarExpanded: true,
  searchTerm: '',
  paneAssignments: {},
};
