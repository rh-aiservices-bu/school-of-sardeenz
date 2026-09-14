import { useMemo, useRef } from 'react';
import {
  Button,
  Content,
  EmptyState,
  EmptyStateBody,
  ExpandableSection,
  Flex,
  FlexItem,
  Label,
  SearchInput,
  Stack,
  StackItem,
  Tooltip,
} from '@patternfly/react-core';
import { CubesIcon, TimesCircleIcon } from '@patternfly/react-icons';
import { useTranslation } from 'react-i18next';
import type { ClusterMemory, ModelInfo } from '../../api/client';
import { InferenceGpuGroup } from './InferenceGpuGroup';
import {
  compositeKey,
  filterModels,
  groupKeys,
  groupModels,
  MULTI_GPU_KEY,
  UNKNOWN_GPU_KEY,
  UNKNOWN_WORKER_KEY,
  workerKey,
} from './sidebarGroups';
import type { WorkspaceSession } from './workspace-types';

interface ModelSidebarProps {
  models: ModelInfo[];
  memory: ClusterMemory | undefined;
  searchTerm: string;
  onSearchChange: (term: string) => void;
  expandedGpuGroups: Set<string>;
  onToggleGpuGroup: (gpuKey: string) => void;
  onModelSelect: (model: ModelInfo) => void;
  isModelOpen: (modelId: string) => boolean;
  activeSessionId: string | null;
  findSessionByModelId: (modelId: string) => WorkspaceSession | undefined;
  sessionCount: number;
  onCloseAllSessions?: () => void;
}

/**
 * Model picker for the workspace. Single-worker clusters show GPU groups; multi-worker clusters
 * show worker → GPU groups (v1's pod → GPU).
 */
export function ModelSidebar({
  models,
  memory,
  searchTerm,
  onSearchChange,
  expandedGpuGroups,
  onToggleGpuGroup,
  onModelSelect,
  isModelOpen,
  activeSessionId,
  findSessionByModelId,
  sessionCount,
  onCloseAllSessions,
}: ModelSidebarProps) {
  const { t } = useTranslation('playground');

  const filteredModels = useMemo(() => filterModels(models, searchTerm), [models, searchTerm]);
  const grouping = useMemo(() => groupModels(filteredModels, memory), [filteredModels, memory]);
  const allKeys = useMemo(() => groupKeys(grouping), [grouping]);

  const gpuLabel = (key: string): string => {
    if (key === MULTI_GPU_KEY) return t('sidebar.multiGpu');
    if (key === UNKNOWN_GPU_KEY) return t('sidebar.unknownGpu');
    return t('sidebar.gpu', { index: key.replace('gpu-', '') });
  };
  const workerLabel = (id: string): string =>
    id === UNKNOWN_WORKER_KEY ? t('sidebar.unknownWorker') : id;

  // Stable Set identity across renders when the "all expanded" default applies.
  const allExpandedRef = useRef<Set<string>>(new Set());
  const effectiveExpandedGroups = useMemo(() => {
    const topLevelCount = grouping.isClusterMode ? grouping.byWorker.size : grouping.byGpu.size;
    const shouldAutoExpand = searchTerm.trim() !== '' || topLevelCount === 1;

    if (!shouldAutoExpand && expandedGpuGroups.size > 0) return expandedGpuGroups;

    const cached = allExpandedRef.current;
    const keysMatch = allKeys.length === cached.size && allKeys.every((k) => cached.has(k));
    if (!keysMatch) allExpandedRef.current = new Set(allKeys);
    return allExpandedRef.current;
  }, [grouping, searchTerm, expandedGpuGroups, allKeys]);

  const gpuGroupProps = {
    onToggle: onToggleGpuGroup,
    onModelSelect,
    isModelOpen,
    activeSessionId,
    findSessionByModelId,
  };

  return (
    <div className="sz-sidebar" aria-label={t('sidebar.ariaLabel')} role="region">
      <Flex
        justifyContent={{ default: 'justifyContentSpaceBetween' }}
        alignItems={{ default: 'alignItemsCenter' }}
        className="sz-sidebar-header"
      >
        <FlexItem>
          <Content component="h3" style={{ margin: 0 }}>
            {t('sidebar.title')}
          </Content>
        </FlexItem>
        <FlexItem>
          <span className="sz-sidebar-count">
            {t('sidebar.available', { count: filteredModels.length })}
          </span>
        </FlexItem>
      </Flex>

      <div className="sz-sidebar-search">
        <Flex alignItems={{ default: 'alignItemsCenter' }} gap={{ default: 'gapSm' }}>
          <FlexItem grow={{ default: 'grow' }}>
            <SearchInput
              aria-label={t('sidebar.searchAriaLabel')}
              placeholder={t('sidebar.searchPlaceholder')}
              value={searchTerm}
              onChange={(_event, value) => onSearchChange(value)}
              onClear={() => onSearchChange('')}
            />
          </FlexItem>
          {sessionCount > 0 && onCloseAllSessions && (
            <FlexItem>
              <Tooltip content={t('sidebar.closeAll')}>
                <Button
                  variant="plain"
                  aria-label={t('sidebar.closeAll')}
                  onClick={onCloseAllSessions}
                  icon={<TimesCircleIcon />}
                />
              </Tooltip>
            </FlexItem>
          )}
        </Flex>
      </div>

      <div className="sz-sidebar-list">
        {models.length === 0 ? (
          <EmptyState
            titleText={t('sidebar.emptyTitle')}
            icon={CubesIcon}
            variant="sm"
            headingLevel="h4"
          >
            <EmptyStateBody>{t('sidebar.emptyBody')}</EmptyStateBody>
          </EmptyState>
        ) : filteredModels.length === 0 ? (
          <EmptyState titleText={t('sidebar.noMatchesTitle')} variant="sm" headingLevel="h4">
            <EmptyStateBody>{t('sidebar.noMatchesBody')}</EmptyStateBody>
          </EmptyState>
        ) : grouping.isClusterMode ? (
          <Stack>
            {Array.from(grouping.byWorker.entries()).map(([workerId, gpuGroups]) => {
              const key = workerKey(workerId);
              const count = Array.from(gpuGroups.values()).reduce((sum, ms) => sum + ms.length, 0);
              return (
                <StackItem key={workerId}>
                  <ExpandableSection
                    toggleContent={
                      <Flex gap={{ default: 'gapMd' }} alignItems={{ default: 'alignItemsCenter' }}>
                        <FlexItem>
                          <strong className="sz-sidebar-group-label">
                            {workerLabel(workerId)}
                          </strong>
                        </FlexItem>
                        <FlexItem>
                          <Label isCompact color="purple">
                            {count}
                          </Label>
                        </FlexItem>
                      </Flex>
                    }
                    isExpanded={effectiveExpandedGroups.has(key)}
                    onToggle={() => onToggleGpuGroup(key)}
                    displaySize="default"
                    className="sz-sidebar-group"
                  >
                    <div className="sz-sidebar-group-body">
                      {Array.from(gpuGroups.entries()).map(([gpuKey, gpuModels]) => {
                        const composite = compositeKey(workerId, gpuKey);
                        return (
                          <InferenceGpuGroup
                            key={composite}
                            gpuKey={composite}
                            gpuLabel={gpuLabel(gpuKey)}
                            models={gpuModels}
                            isExpanded={effectiveExpandedGroups.has(composite)}
                            {...gpuGroupProps}
                          />
                        );
                      })}
                    </div>
                  </ExpandableSection>
                </StackItem>
              );
            })}
          </Stack>
        ) : (
          <Stack>
            {Array.from(grouping.byGpu.entries()).map(([gpuKey, gpuModels]) => (
              <StackItem key={gpuKey}>
                <InferenceGpuGroup
                  gpuKey={gpuKey}
                  gpuLabel={gpuLabel(gpuKey)}
                  models={gpuModels}
                  isExpanded={effectiveExpandedGroups.has(gpuKey)}
                  {...gpuGroupProps}
                />
              </StackItem>
            ))}
          </Stack>
        )}
      </div>
    </div>
  );
}
