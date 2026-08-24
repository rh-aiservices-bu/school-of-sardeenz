import { Grid, GridItem } from '@patternfly/react-core';
import type { ModelInfo } from '../../api/client';
import type { PlaygroundLayout } from './LayoutSelector';
import { WorkspaceArea } from './WorkspaceArea';

interface WorkspaceGridProps {
  layout: PlaygroundLayout;
  panes: (string | null)[];
  models: ModelInfo[];
  onClosePane: (index: number) => void;
}

/** CSS grid of WorkspaceArea panes — 1 column in `single` layout, 2 in `split`. */
export function WorkspaceGrid({ layout, panes, models, onClosePane }: WorkspaceGridProps) {
  const span = layout === 'split' ? 6 : 12;
  const modelByName = new Map(models.map((model) => [model.modelName, model]));

  return (
    <Grid hasGutter style={{ height: '100%' }}>
      {panes.map((modelName, index) => (
        <GridItem key={index} span={span} style={{ height: '100%' }}>
          <WorkspaceArea
            modelName={modelName}
            model={modelName ? modelByName.get(modelName) : undefined}
            onClose={() => onClosePane(index)}
          />
        </GridItem>
      ))}
    </Grid>
  );
}
