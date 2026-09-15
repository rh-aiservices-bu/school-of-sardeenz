import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ModelInfo } from '../../api/client';
import {
  DEFAULT_WORKSPACE_STATE,
  type LayoutMode,
  type PaneAssignments,
  type SessionStatus,
  type WorkspaceActions,
  type WorkspaceSession,
  type WorkspaceState,
} from './workspace-types';
import {
  assignSessionToPane as assignSessionToPaneState,
  clearPersistedSessionData,
  createSession,
  getVisibleSessions as getVisibleSessionsState,
  loadPersistedPreferences,
  loadPersistedSessionData,
  removeSessionAssignment,
  savePersistedPreferences,
  savePersistedSessionData,
  syncSessions as syncSessionsState,
} from './workspaceState';

/**
 * Inference workspace state: open sessions, active session, layout, sidebar, search, GPU group
 * expansion, and explicit pane assignments. Preferences persist in localStorage; open sessions
 * persist in sessionStorage (v1 parity). All actions are referentially stable — they read the
 * latest state through refs synced during render.
 */
export function useWorkspaceState(): WorkspaceState & WorkspaceActions {
  const persistedPrefs = useMemo(() => loadPersistedPreferences(), []);

  const [sessions, setSessions] = useState<Map<string, WorkspaceSession>>(() => new Map());
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [layout, setLayoutState] = useState<LayoutMode>(
    persistedPrefs.layout ?? DEFAULT_WORKSPACE_STATE.layout,
  );
  const [sidebarExpanded, setSidebarExpandedState] = useState(
    persistedPrefs.sidebarExpanded ?? DEFAULT_WORKSPACE_STATE.sidebarExpanded,
  );
  const [searchTerm, setSearchTerm] = useState(DEFAULT_WORKSPACE_STATE.searchTerm);
  const [expandedGpuGroups, setExpandedGpuGroups] = useState<Set<string>>(() => new Set());
  const [paneAssignments, setPaneAssignments] = useState<PaneAssignments>(
    persistedPrefs.paneAssignments ?? DEFAULT_WORKSPACE_STATE.paneAssignments,
  );

  const sessionsRef = useRef(sessions);
  const activeSessionIdRef = useRef(activeSessionId);
  const layoutRef = useRef(layout);
  const paneAssignmentsRef = useRef(paneAssignments);
  sessionsRef.current = sessions;
  activeSessionIdRef.current = activeSessionId;
  layoutRef.current = layout;
  paneAssignmentsRef.current = paneAssignments;

  useEffect(() => {
    savePersistedPreferences({ layout, sidebarExpanded, paneAssignments });
  }, [layout, sidebarExpanded, paneAssignments]);

  // Set once syncSessions has had a chance to restore persisted sessions; until then an empty
  // session map is just "not loaded yet" and must not wipe sessionStorage on mount.
  const hydratedRef = useRef(false);

  useEffect(() => {
    if (sessions.size === 0) {
      if (hydratedRef.current) clearPersistedSessionData();
      return;
    }
    const openModelIds = Array.from(sessions.values()).map((s) => s.modelId);
    const active = activeSessionId ? sessions.get(activeSessionId) : undefined;
    savePersistedSessionData({ openModelIds, activeModelId: active?.modelId ?? null });
  }, [sessions, activeSessionId]);

  const addSession = useCallback((model: ModelInfo) => {
    const session = createSession(model);
    setSessions((prev) => new Map(prev).set(session.id, session));
    setActiveSessionId(session.id);
  }, []);

  const removeSession = useCallback((sessionId: string) => {
    const remaining = Array.from(sessionsRef.current.keys()).filter((id) => id !== sessionId);
    setSessions((prev) => {
      if (!prev.has(sessionId)) return prev;
      const next = new Map(prev);
      next.delete(sessionId);
      return next;
    });
    setPaneAssignments((prev) => removeSessionAssignment(prev, sessionId));
    if (activeSessionIdRef.current === sessionId) {
      setActiveSessionId(remaining[0] ?? null);
    }
  }, []);

  const setActiveSession = useCallback((sessionId: string | null) => {
    setActiveSessionId(sessionId);
  }, []);

  const updateSessionStatus = useCallback((sessionId: string, status: SessionStatus) => {
    setSessions((prev) => {
      const session = prev.get(sessionId);
      if (!session || session.status === status) return prev;
      return new Map(prev).set(sessionId, { ...session, status });
    });
  }, []);

  const setLayout = useCallback((next: LayoutMode) => setLayoutState(next), []);
  const toggleSidebar = useCallback(() => setSidebarExpandedState((prev) => !prev), []);
  const setSidebarExpanded = useCallback((v: boolean) => setSidebarExpandedState(v), []);

  const toggleGpuGroup = useCallback((gpuKey: string) => {
    setExpandedGpuGroups((prev) => {
      const next = new Set(prev);
      if (next.has(gpuKey)) next.delete(gpuKey);
      else next.add(gpuKey);
      return next;
    });
  }, []);

  const getVisibleSessions = useCallback(
    () =>
      getVisibleSessionsState(
        sessionsRef.current,
        activeSessionIdRef.current,
        layoutRef.current,
        paneAssignmentsRef.current,
      ),
    [],
  );

  const isModelOpen = useCallback(
    (modelId: string) =>
      Array.from(sessionsRef.current.values()).some((s) => s.modelId === modelId),
    [],
  );

  const findSessionByModelId = useCallback(
    (modelId: string) =>
      Array.from(sessionsRef.current.values()).find((s) => s.modelId === modelId),
    [],
  );

  const clearAllSessions = useCallback(() => {
    setSessions(new Map());
    setActiveSessionId(null);
    clearPersistedSessionData();
  }, []);

  const assignSessionToPane = useCallback((paneIndex: number, sessionId: string | null) => {
    setPaneAssignments((prev) => assignSessionToPaneState(prev, paneIndex, sessionId));
  }, []);

  const clearPaneAssignments = useCallback(() => setPaneAssignments({}), []);

  const syncSessions = useCallback((deployableModels: ModelInfo[]) => {
    // Called from an effect after render, so the ref holds the committed sessions map.
    const prev = sessionsRef.current;
    const persisted = prev.size === 0 ? loadPersistedSessionData() : null;
    const result = syncSessionsState(prev, deployableModels, persisted);
    hydratedRef.current = true;
    if (!result.changed) return;
    setSessions(result.sessions);
    if (result.restoredActiveSessionId !== undefined) {
      setActiveSessionId(result.restoredActiveSessionId);
    }
  }, []);

  return useMemo(
    () => ({
      sessions,
      activeSessionId,
      layout,
      sidebarExpanded,
      searchTerm,
      expandedGpuGroups,
      paneAssignments,
      addSession,
      removeSession,
      setActiveSession,
      updateSessionStatus,
      setLayout,
      toggleSidebar,
      setSidebarExpanded,
      setSearchTerm,
      toggleGpuGroup,
      getVisibleSessions,
      isModelOpen,
      findSessionByModelId,
      clearAllSessions,
      syncSessions,
      assignSessionToPane,
      clearPaneAssignments,
    }),
    // Actions are stable (empty deps, refs internally); only state values drive re-memoisation.
    [
      sessions,
      activeSessionId,
      layout,
      sidebarExpanded,
      searchTerm,
      expandedGpuGroups,
      paneAssignments,
    ],
  );
}
