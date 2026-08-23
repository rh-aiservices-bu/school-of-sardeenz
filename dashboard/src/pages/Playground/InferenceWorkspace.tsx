import { useState } from 'react';
import { Flex, FlexItem } from '@patternfly/react-core';
import { ModelLifecycleState } from '@sardeenz/types';
import { useModels } from '../../hooks/useModels';
import { ModelSidebar } from './ModelSidebar';
import { LayoutSelector, type PlaygroundLayout } from './LayoutSelector';
import { WorkspaceGrid } from './WorkspaceGrid';
import { initialPanes, selectModel, closePane, resizePanes } from './paneState';

/** Owns pane layout state and open sessions; hosts the model sidebar + the workspace grid. */
export function InferenceWorkspace() {
  const { data: models = [] } = useModels();
  const deployableModels = models.filter(
    (m) => m.state === ModelLifecycleState.ACTIVE || m.state === ModelLifecycleState.SLEEPING,
  );

  const [layout, setLayout] = useState<PlaygroundLayout>('single');
  const [panes, setPanes] = useState(() => initialPanes(layout));

  const handleLayoutChange = (nextLayout: PlaygroundLayout) => {
    setLayout(nextLayout);
    setPanes((prev) => resizePanes(prev, nextLayout));
  };

  const handleSelectModel = (modelName: string) => {
    setPanes((prev) => selectModel(prev, modelName));
  };

  const handleClosePane = (index: number) => {
    setPanes((prev) => closePane(prev, index));
  };

  const openModelNames = new Set(panes.filter((name): name is string => name !== null));

  return (
    <Flex style={{ height: '100%' }}>
      <FlexItem style={{ width: '280px', flexShrink: 0 }}>
        <ModelSidebar
          models={deployableModels}
          openModelNames={openModelNames}
          onSelectModel={handleSelectModel}
        />
      </FlexItem>
      <FlexItem grow={{ default: 'grow' }} style={{ minWidth: 0 }}>
        <Flex direction={{ default: 'column' }} style={{ height: '100%' }}>
          <FlexItem>
            <LayoutSelector layout={layout} onChange={handleLayoutChange} />
          </FlexItem>
          <FlexItem grow={{ default: 'grow' }}>
            <WorkspaceGrid
              layout={layout}
              panes={panes}
              models={deployableModels}
              onClosePane={handleClosePane}
            />
          </FlexItem>
        </Flex>
      </FlexItem>
    </Flex>
  );
}
