import type { CSSProperties } from 'react';
import { Button, EmptyState, EmptyStateActions, EmptyStateBody } from '@patternfly/react-core';
import { CubesIcon } from '@patternfly/react-icons';
import { useTranslation } from 'react-i18next';
import { ModelChatCard } from './ModelChatCard';
import { PaneSessionSelector } from './PaneSessionSelector';
import {
  paneCount,
  type LayoutMode,
  type PaneAssignments,
  type SessionStatus,
  type WorkspaceSession,
} from './workspace-types';

interface WorkspaceGridProps {
  visibleSessions: WorkspaceSession[];
  layout: LayoutMode;
  onSessionStatusChange: (sessionId: string, status: SessionStatus) => void;
  sidebarExpanded: boolean;
  onToggleSidebar: () => void;
  allSessions: WorkspaceSession[];
  paneAssignments: PaneAssignments;
  onAssignSessionToPane: (paneIndex: number, sessionId: string | null) => void;
}

function gridStyles(layout: LayoutMode): CSSProperties {
  const base: CSSProperties = {
    display: 'grid',
    gap: 'var(--pf-t--global--spacer--sm)',
    height: '100%',
  };
  switch (layout) {
    case 'split-2':
      return { ...base, gridTemplateColumns: '1fr 1fr', gridTemplateRows: '1fr' };
    case 'grid-4':
      return { ...base, gridTemplateColumns: '1fr 1fr', gridTemplateRows: '1fr 1fr' };
    default:
      return { ...base, gridTemplateColumns: '1fr', gridTemplateRows: '1fr' };
  }
}

/** Grid of chat cards — 1, 2, or 4 panes depending on the layout mode. */
export function WorkspaceGrid({
  visibleSessions,
  layout,
  onSessionStatusChange,
  sidebarExpanded,
  onToggleSidebar,
  allSessions,
  paneAssignments,
  onAssignSessionToPane,
}: WorkspaceGridProps) {
  const { t } = useTranslation('playground');
  const isMultiPane = layout !== 'single';
  // Only offer the pane selector when there are more sessions than panes to show them in.
  const showPaneSelector = isMultiPane && allSessions.length > paneCount(layout);

  if (visibleSessions.length === 0) {
    return (
      <div
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}
      >
        <EmptyState titleText={t('grid.emptyTitle')} icon={CubesIcon} headingLevel="h2">
          <EmptyStateBody>{t('grid.emptyBody')}</EmptyStateBody>
          <EmptyStateActions>
            <Button
              variant="link"
              onClick={() => {
                if (!sidebarExpanded) onToggleSidebar();
              }}
            >
              {t('grid.emptyAction')}
            </Button>
          </EmptyStateActions>
        </EmptyState>
      </div>
    );
  }

  return (
    <div style={gridStyles(layout)}>
      {visibleSessions.map((session, paneIndex) => (
        <div key={session.id} style={{ minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          {showPaneSelector && (
            <div style={{ marginBottom: 'var(--pf-t--global--spacer--xs)', flexShrink: 0 }}>
              <PaneSessionSelector
                paneIndex={paneIndex}
                currentSession={session}
                allSessions={allSessions}
                paneAssignments={paneAssignments}
                onAssign={onAssignSessionToPane}
              />
            </div>
          )}
          <ModelChatCard
            model={session.model}
            onStatusChange={(status) => onSessionStatusChange(session.id, status)}
          />
        </div>
      ))}
    </div>
  );
}
