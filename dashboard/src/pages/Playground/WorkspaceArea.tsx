import { useEffect, useMemo, useState } from 'react';
import { WorkspaceGrid } from './WorkspaceGrid';
import { WorkspaceToolbar } from './WorkspaceToolbar';
import type {
  LayoutMode,
  PaneAssignments,
  SessionStatus,
  WorkspaceSession,
} from './workspace-types';

interface WorkspaceAreaProps {
  sessions: Map<string, WorkspaceSession>;
  activeSessionId: string | null;
  layout: LayoutMode;
  onLayoutChange: (layout: LayoutMode) => void;
  onSessionClose: (sessionId: string) => void;
  onSessionSelect: (sessionId: string | null) => void;
  onSessionStatusChange: (sessionId: string, status: SessionStatus) => void;
  getVisibleSessions: () => WorkspaceSession[];
  sidebarExpanded: boolean;
  onToggleSidebar: () => void;
  paneAssignments: PaneAssignments;
  onAssignSessionToPane: (paneIndex: number, sessionId: string | null) => void;
}

/** Viewport widths below which multi-pane layouts are disabled. */
const BREAKPOINTS = { sm: 768, md: 1200 };

/** Toolbar + chat grid; also downgrades the layout when the viewport gets too narrow. */
export function WorkspaceArea({
  sessions,
  activeSessionId,
  layout,
  onLayoutChange,
  onSessionClose,
  onSessionSelect,
  onSessionStatusChange,
  getVisibleSessions,
  sidebarExpanded,
  onToggleSidebar,
  paneAssignments,
  onAssignSessionToPane,
}: WorkspaceAreaProps) {
  const [windowWidth, setWindowWidth] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth : BREAKPOINTS.md,
  );

  useEffect(() => {
    const handleResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const disabledLayouts = useMemo((): LayoutMode[] => {
    if (windowWidth < BREAKPOINTS.sm) return ['split-2', 'grid-4'];
    if (windowWidth < BREAKPOINTS.md) return ['grid-4'];
    return [];
  }, [windowWidth]);

  useEffect(() => {
    if (disabledLayouts.includes(layout)) {
      onLayoutChange(disabledLayouts.includes('split-2') ? 'single' : 'split-2');
    }
  }, [disabledLayouts, layout, onLayoutChange]);

  // Refs behind getVisibleSessions are synced during render, so this reads the latest state.
  const visibleSessions = getVisibleSessions();
  const allSessions = useMemo(() => Array.from(sessions.values()), [sessions]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <WorkspaceToolbar
        sessions={sessions}
        activeSessionId={activeSessionId}
        layout={layout}
        onLayoutChange={onLayoutChange}
        onSessionSelect={onSessionSelect}
        onSessionClose={onSessionClose}
        sidebarExpanded={sidebarExpanded}
        onToggleSidebar={onToggleSidebar}
        disabledLayouts={disabledLayouts}
      />
      <div style={{ flex: 1, overflow: 'auto', padding: 'var(--pf-t--global--spacer--sm)' }}>
        <WorkspaceGrid
          visibleSessions={visibleSessions}
          layout={layout}
          onSessionStatusChange={onSessionStatusChange}
          sidebarExpanded={sidebarExpanded}
          onToggleSidebar={onToggleSidebar}
          allSessions={allSessions}
          paneAssignments={paneAssignments}
          onAssignSessionToPane={onAssignSessionToPane}
        />
      </div>
    </div>
  );
}
