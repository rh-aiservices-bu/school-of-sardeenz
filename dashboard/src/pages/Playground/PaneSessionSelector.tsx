import { useMemo, useState } from 'react';
import { Divider, MenuToggle, Select, SelectList, SelectOption } from '@patternfly/react-core';
import { useTranslation } from 'react-i18next';
import { modelLabel } from './modelLabel';
import { sortSessions } from './workspaceState';
import type { PaneAssignments, WorkspaceSession } from './workspace-types';

interface PaneSessionSelectorProps {
  paneIndex: number;
  currentSession: WorkspaceSession;
  allSessions: WorkspaceSession[];
  paneAssignments: PaneAssignments;
  onAssign: (paneIndex: number, sessionId: string | null) => void;
}

/**
 * Dropdown above a pane (multi-pane layouts, when there are more sessions than panes) to pick
 * which session that pane shows. Picking a session shown elsewhere swaps the two panes.
 */
export function PaneSessionSelector({
  paneIndex,
  currentSession,
  allSessions,
  paneAssignments,
  onAssign,
}: PaneSessionSelectorProps) {
  const { t } = useTranslation('playground');
  const [isOpen, setIsOpen] = useState(false);

  const isExplicitlyAssigned = paneAssignments[paneIndex] === currentSession.id;

  const sessionsInOtherPanes = useMemo(() => {
    const result = new Set<string>();
    for (const [idx, sessionId] of Object.entries(paneAssignments)) {
      if (Number(idx) !== paneIndex && sessionId) result.add(sessionId);
    }
    return result;
  }, [paneAssignments, paneIndex]);

  const sortedSessions = useMemo(() => sortSessions(allSessions), [allSessions]);

  const handleSelect = (sessionId: string | null) => {
    onAssign(paneIndex, sessionId);
    setIsOpen(false);
  };

  return (
    <Select
      aria-label={t('paneSelector.ariaLabel', { pane: paneIndex + 1 })}
      isOpen={isOpen}
      onOpenChange={setIsOpen}
      toggle={(toggleRef) => (
        <MenuToggle
          ref={toggleRef}
          onClick={() => setIsOpen((open) => !open)}
          isExpanded={isOpen}
          isFullWidth
          style={{ fontSize: 'var(--pf-t--global--font--size--body--sm)', maxWidth: '200px' }}
        >
          {modelLabel(currentSession.model)}
        </MenuToggle>
      )}
    >
      <SelectList>
        <SelectOption
          value="auto"
          isSelected={!isExplicitlyAssigned}
          onClick={() => handleSelect(null)}
          description={t('paneSelector.autoDescription')}
        >
          {t('paneSelector.auto')}
        </SelectOption>
        <Divider />
        {sortedSessions.map((session) => (
          <SelectOption
            key={session.id}
            value={session.id}
            isSelected={session.id === currentSession.id && isExplicitlyAssigned}
            onClick={() => handleSelect(session.id)}
            description={
              sessionsInOtherPanes.has(session.id) ? t('paneSelector.swapDescription') : undefined
            }
          >
            {modelLabel(session.model)}
          </SelectOption>
        ))}
      </SelectList>
    </Select>
  );
}
