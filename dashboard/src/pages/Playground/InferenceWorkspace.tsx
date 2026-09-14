import { useCallback, useEffect, useMemo } from 'react';
import {
  Drawer,
  DrawerContent,
  DrawerContentBody,
  DrawerPanelContent,
  Flex,
  FlexItem,
  Spinner,
} from '@patternfly/react-core';
import { useTranslation } from 'react-i18next';
import type { ModelInfo } from '../../api/client';
import { useInferenceWorkspace } from '../../contexts/InferenceWorkspaceContext';
import { useClusterMemory } from '../../hooks/useCluster';
import { useModels } from '../../hooks/useModels';
import { ModelSidebar } from './ModelSidebar';
import { deployableModels } from './sidebarGroups';
import { WorkspaceArea } from './WorkspaceArea';

/**
 * Main workspace container: a resizable, collapsible model sidebar (Drawer, inline, start) next
 * to the toolbar + chat grid. Session state lives in `InferenceWorkspaceProvider` so it survives
 * navigating away and back.
 */
export function InferenceWorkspace() {
  const { t } = useTranslation('playground');
  const { data: allModels, isLoading } = useModels();
  const { data: memory } = useClusterMemory();
  const workspace = useInferenceWorkspace();
  const { syncSessions, findSessionByModelId, setActiveSession, addSession } = workspace;

  const models = useMemo(() => deployableModels(allModels ?? []), [allModels]);

  // Reconcile open sessions with what is chattable (also restores from sessionStorage on load).
  useEffect(() => {
    if (allModels) syncSessions(models);
  }, [allModels, models, syncSessions]);

  const handleModelSelect = useCallback(
    (model: ModelInfo) => {
      const existing = findSessionByModelId(model.modelName);
      if (existing) setActiveSession(existing.id);
      else addSession(model);
    },
    [findSessionByModelId, setActiveSession, addSession],
  );

  if (isLoading && !allModels) {
    return (
      <Flex
        justifyContent={{ default: 'justifyContentCenter' }}
        alignItems={{ default: 'alignItemsCenter' }}
        style={{ height: '100%', minHeight: '400px' }}
      >
        <FlexItem>
          <Spinner size="xl" aria-label={t('workspace.loading')} />
        </FlexItem>
      </Flex>
    );
  }

  const sidebarPanel = (
    <DrawerPanelContent
      isResizable
      defaultSize="380px"
      minSize="200px"
      maxSize="400px"
      className="sz-sidebar-panel"
    >
      <ModelSidebar
        models={models}
        memory={memory}
        searchTerm={workspace.searchTerm}
        onSearchChange={workspace.setSearchTerm}
        expandedGpuGroups={workspace.expandedGpuGroups}
        onToggleGpuGroup={workspace.toggleGpuGroup}
        onModelSelect={handleModelSelect}
        isModelOpen={workspace.isModelOpen}
        activeSessionId={workspace.activeSessionId}
        findSessionByModelId={workspace.findSessionByModelId}
        sessionCount={workspace.sessions.size}
        onCloseAllSessions={workspace.clearAllSessions}
      />
    </DrawerPanelContent>
  );

  return (
    <Drawer isExpanded={workspace.sidebarExpanded} isInline position="start">
      <DrawerContent panelContent={sidebarPanel}>
        <DrawerContentBody style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
          <WorkspaceArea
            sessions={workspace.sessions}
            activeSessionId={workspace.activeSessionId}
            layout={workspace.layout}
            onLayoutChange={workspace.setLayout}
            onSessionClose={workspace.removeSession}
            onSessionSelect={workspace.setActiveSession}
            onSessionStatusChange={workspace.updateSessionStatus}
            getVisibleSessions={workspace.getVisibleSessions}
            sidebarExpanded={workspace.sidebarExpanded}
            onToggleSidebar={workspace.toggleSidebar}
            paneAssignments={workspace.paneAssignments}
            onAssignSessionToPane={workspace.assignSessionToPane}
          />
        </DrawerContentBody>
      </DrawerContent>
    </Drawer>
  );
}
