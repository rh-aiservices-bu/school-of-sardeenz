import { ExpandableSection, Flex, FlexItem, Label, Stack, StackItem } from '@patternfly/react-core';
import type { ModelInfo } from '../../api/client';
import { ModelSidebarItem } from './ModelSidebarItem';
import type { WorkspaceSession } from './workspace-types';

interface InferenceGpuGroupProps {
  gpuKey: string;
  gpuLabel: string;
  models: ModelInfo[];
  isExpanded: boolean;
  onToggle: (gpuKey: string) => void;
  onModelSelect: (model: ModelInfo) => void;
  isModelOpen: (modelId: string) => boolean;
  activeSessionId: string | null;
  findSessionByModelId: (modelId: string) => WorkspaceSession | undefined;
}

/** Collapsible GPU group in the sidebar: label + model count, expanding to the model rows. */
export function InferenceGpuGroup({
  gpuKey,
  gpuLabel,
  models,
  isExpanded,
  onToggle,
  onModelSelect,
  isModelOpen,
  activeSessionId,
  findSessionByModelId,
}: InferenceGpuGroupProps) {
  return (
    <ExpandableSection
      toggleContent={
        <Flex gap={{ default: 'gapMd' }} alignItems={{ default: 'alignItemsCenter' }}>
          <FlexItem>
            <strong className="sz-sidebar-group-label">{gpuLabel}</strong>
          </FlexItem>
          <FlexItem>
            <Label isCompact color="blue">
              {models.length}
            </Label>
          </FlexItem>
        </Flex>
      }
      isExpanded={isExpanded}
      onToggle={() => onToggle(gpuKey)}
      displaySize="default"
      className="sz-sidebar-group"
    >
      <Stack hasGutter className="sz-sidebar-group-body">
        {models.map((model) => {
          const session = findSessionByModelId(model.modelName);
          return (
            <StackItem key={model.modelName}>
              <ModelSidebarItem
                model={model}
                isOpen={isModelOpen(model.modelName)}
                isActive={session ? session.id === activeSessionId : false}
                onSelect={onModelSelect}
              />
            </StackItem>
          );
        })}
      </Stack>
    </ExpandableSection>
  );
}
