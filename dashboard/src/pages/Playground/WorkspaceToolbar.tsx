import { Button, Divider, Flex, FlexItem, Tooltip } from '@patternfly/react-core';
import { BarsIcon } from '@patternfly/react-icons';
import { useTranslation } from 'react-i18next';
import { LayoutSelector } from './LayoutSelector';
import { SessionTabs } from './SessionTabs';
import type { LayoutMode, WorkspaceSession } from './workspace-types';

interface WorkspaceToolbarProps {
  sessions: Map<string, WorkspaceSession>;
  activeSessionId: string | null;
  layout: LayoutMode;
  onLayoutChange: (layout: LayoutMode) => void;
  onSessionSelect: (sessionId: string) => void;
  onSessionClose: (sessionId: string) => void;
  sidebarExpanded: boolean;
  onToggleSidebar: () => void;
  disabledLayouts?: LayoutMode[];
}

/** Workspace toolbar: sidebar toggle, session tabs, layout selector. */
export function WorkspaceToolbar({
  sessions,
  activeSessionId,
  layout,
  onLayoutChange,
  onSessionSelect,
  onSessionClose,
  sidebarExpanded,
  onToggleSidebar,
  disabledLayouts = [],
}: WorkspaceToolbarProps) {
  const { t } = useTranslation('playground');
  const sidebarLabel = sidebarExpanded ? t('toolbar.hideSidebar') : t('toolbar.showSidebar');

  return (
    <Flex
      alignItems={{ default: 'alignItemsCenter' }}
      gap={{ default: 'gapMd' }}
      flexWrap={{ default: 'nowrap' }}
      className="sz-playground-toolbar"
    >
      <FlexItem>
        <Tooltip content={sidebarLabel}>
          <Button
            variant="plain"
            aria-label={sidebarLabel}
            onClick={onToggleSidebar}
            aria-pressed={sidebarExpanded}
            icon={<BarsIcon />}
          />
        </Tooltip>
      </FlexItem>

      <Divider orientation={{ default: 'vertical' }} />

      <FlexItem style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
        <SessionTabs
          sessions={sessions}
          activeSessionId={activeSessionId}
          onSessionSelect={onSessionSelect}
          onSessionClose={onSessionClose}
        />
      </FlexItem>

      <Divider orientation={{ default: 'vertical' }} />

      <FlexItem>
        <LayoutSelector
          layout={layout}
          onLayoutChange={onLayoutChange}
          disabledLayouts={disabledLayouts}
        />
      </FlexItem>
    </Flex>
  );
}
