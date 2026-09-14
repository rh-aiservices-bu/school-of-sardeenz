import { Flex, FlexItem, Label, Tab, Tabs, TabTitleText } from '@patternfly/react-core';
import { SpinnerIcon } from '@patternfly/react-icons';
import { useTranslation } from 'react-i18next';
import { modelLabel } from './modelLabel';
import { sortSessions } from './workspaceState';
import type { WorkspaceSession } from './workspace-types';

interface SessionTabsProps {
  sessions: Map<string, WorkspaceSession>;
  activeSessionId: string | null;
  onSessionSelect: (sessionId: string) => void;
  onSessionClose: (sessionId: string) => void;
}

/** Horizontal tabs for switching between open sessions; each tab has a close button. */
export function SessionTabs({
  sessions,
  activeSessionId,
  onSessionSelect,
  onSessionClose,
}: SessionTabsProps) {
  const { t } = useTranslation('playground');
  const sessionList = sortSessions(sessions.values());

  if (sessionList.length === 0) return null;

  return (
    <Tabs
      activeKey={activeSessionId ?? ''}
      onSelect={(_event, eventKey) => onSessionSelect(String(eventKey))}
      onClose={(_event, eventKey) => onSessionClose(String(eventKey))}
      aria-label={t('tabs.ariaLabel')}
      isBox={false}
      style={{ flex: 1, minWidth: 0 }}
    >
      {sessionList.map((session) => {
        const name = modelLabel(session.model);
        return (
          <Tab
            key={session.id}
            eventKey={session.id}
            title={
              session.status === 'generating' ? (
                <Flex
                  alignItems={{ default: 'alignItemsCenter' }}
                  gap={{ default: 'gapSm' }}
                  flexWrap={{ default: 'nowrap' }}
                >
                  <FlexItem>
                    <TabTitleText>{name}</TabTitleText>
                  </FlexItem>
                  <FlexItem>
                    <Label isCompact color="blue" icon={<SpinnerIcon className="pf-v6-u-spin" />}>
                      {t('tabs.generating')}
                    </Label>
                  </FlexItem>
                </Flex>
              ) : (
                <TabTitleText>{name}</TabTitleText>
              )
            }
            aria-label={t('tabs.tabAriaLabel', { modelName: name })}
            closeButtonAriaLabel={t('tabs.closeAriaLabel', { modelName: name })}
          />
        );
      })}
    </Tabs>
  );
}
