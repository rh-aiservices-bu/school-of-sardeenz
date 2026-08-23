import { useState } from 'react';
import {
  Card,
  CardBody,
  CardTitle,
  Flex,
  FlexItem,
  Spinner,
  Title,
  ToggleGroup,
  ToggleGroupItem,
} from '@patternfly/react-core';
import { useTranslation } from 'react-i18next';
import { type ControlPlaneComponents } from '@sardeenz/types';
import { useClusterMemory } from '../hooks/useCluster';
import { WorkerGpuSection, type DisplayMode } from './WorkerGpuSection';
import { OTHER_COLOR_TOKEN } from '../utils/memorySegments';

type ClusterMemory = ControlPlaneComponents['schemas']['ClusterMemory'];

const SLEEPING_LEGEND_HATCH =
  'repeating-linear-gradient(-45deg, transparent 0 2px, var(--pf-t--global--color--nonstatus--gray--300) 2px 3px)';

// ---------------------------------------------------------------------------
// Legend
// ---------------------------------------------------------------------------
function Legend() {
  const { t } = useTranslation('cluster');
  return (
    <Flex spaceItems={{ default: 'spaceItemsMd' }} alignItems={{ default: 'alignItemsCenter' }}>
      <FlexItem>
        <Flex spaceItems={{ default: 'spaceItemsSm' }} alignItems={{ default: 'alignItemsCenter' }}>
          <FlexItem>
            <span
              style={{
                display: 'inline-block',
                width: '12px',
                height: '12px',
                borderRadius: '2px',
                background: 'var(--pf-t--global--color--status--info--default)',
              }}
            />
          </FlexItem>
          <FlexItem>
            <span style={{ fontSize: 'var(--pf-t--global--font--size--sm)' }}>
              {t('overview.vramAllocation.legend.used')}
            </span>
          </FlexItem>
        </Flex>
      </FlexItem>
      <FlexItem>
        <Flex spaceItems={{ default: 'spaceItemsSm' }} alignItems={{ default: 'alignItemsCenter' }}>
          <FlexItem>
            <span
              style={{
                display: 'inline-block',
                width: '12px',
                height: '12px',
                borderRadius: '2px',
                background: 'var(--pf-t--global--color--status--warning--default)',
              }}
            />
          </FlexItem>
          <FlexItem>
            <span style={{ fontSize: 'var(--pf-t--global--font--size--sm)' }}>
              {t('overview.vramAllocation.legend.reserved')}
            </span>
          </FlexItem>
        </Flex>
      </FlexItem>
      <FlexItem>
        <Flex spaceItems={{ default: 'spaceItemsSm' }} alignItems={{ default: 'alignItemsCenter' }}>
          <FlexItem>
            <span
              style={{
                display: 'inline-block',
                width: '12px',
                height: '12px',
                borderRadius: '2px',
                background: 'var(--pf-t--global--background--color--secondary--default)',
                border: '1px solid var(--pf-t--global--border--color--default)',
              }}
            />
          </FlexItem>
          <FlexItem>
            <span style={{ fontSize: 'var(--pf-t--global--font--size--sm)' }}>
              {t('overview.vramAllocation.legend.available')}
            </span>
          </FlexItem>
        </Flex>
      </FlexItem>
      <FlexItem>
        <Flex spaceItems={{ default: 'spaceItemsSm' }} alignItems={{ default: 'alignItemsCenter' }}>
          <FlexItem>
            <span
              style={{
                display: 'inline-block',
                width: '12px',
                height: '12px',
                borderRadius: '2px',
                background: OTHER_COLOR_TOKEN,
              }}
            />
          </FlexItem>
          <FlexItem>
            <span style={{ fontSize: 'var(--pf-t--global--font--size--sm)' }}>
              {t('overview.vramAllocation.legend.other')}
            </span>
          </FlexItem>
        </Flex>
      </FlexItem>
      <FlexItem>
        <Flex spaceItems={{ default: 'spaceItemsSm' }} alignItems={{ default: 'alignItemsCenter' }}>
          <FlexItem>
            <span
              style={{
                display: 'inline-block',
                width: '12px',
                height: '12px',
                borderRadius: '2px',
                background: `var(--pf-t--chart--color--blue--300) ${SLEEPING_LEGEND_HATCH}`,
              }}
            />
          </FlexItem>
          <FlexItem>
            <span style={{ fontSize: 'var(--pf-t--global--font--size--sm)' }}>
              {t('overview.vramAllocation.legend.sleeping')}
            </span>
          </FlexItem>
        </Flex>
      </FlexItem>
    </Flex>
  );
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------
function EmptyMemoryState() {
  const { t } = useTranslation('cluster');
  return (
    <div
      style={{
        textAlign: 'center',
        padding: 'var(--pf-t--global--spacer--xl) 0',
        color: 'var(--pf-t--global--text--color--subtle)',
        fontSize: 'var(--pf-t--global--font--size--sm)',
      }}
    >
      {t('overview.vramAllocation.noData')}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------
export interface MemoryVisualizationProps {
  /** If not provided the component fetches data itself via useClusterMemory(). */
  data?: ClusterMemory;
}

export function MemoryVisualization({ data: externalData }: MemoryVisualizationProps) {
  const { t } = useTranslation('cluster');
  const { data: fetchedData, isLoading } = useClusterMemory();
  const [displayMode, setDisplayMode] = useState<DisplayMode>('bytes');

  const memory: ClusterMemory | undefined = externalData ?? fetchedData;

  return (
    <Card>
      <CardTitle>
        <Flex
          spaceItems={{ default: 'spaceItemsMd' }}
          alignItems={{ default: 'alignItemsCenter' }}
          justifyContent={{ default: 'justifyContentSpaceBetween' }}
          flexWrap={{ default: 'wrap' }}
        >
          <FlexItem>
            <Title headingLevel="h2" size="lg">
              {t('overview.vramAllocation.title')}
            </Title>
          </FlexItem>
          <FlexItem>
            <Flex
              spaceItems={{ default: 'spaceItemsMd' }}
              alignItems={{ default: 'alignItemsCenter' }}
            >
              <FlexItem>
                <ToggleGroup aria-label={t('overview.vramAllocation.displayModeLabel')}>
                  <ToggleGroupItem
                    text={t('overview.vramAllocation.displayGiB')}
                    isSelected={displayMode === 'bytes'}
                    onChange={(_event, selected) => {
                      if (selected) setDisplayMode('bytes');
                    }}
                    buttonId="display-mode-bytes"
                  />
                  <ToggleGroupItem
                    text={t('overview.vramAllocation.displayPercent')}
                    isSelected={displayMode === 'percent'}
                    onChange={(_event, selected) => {
                      if (selected) setDisplayMode('percent');
                    }}
                    buttonId="display-mode-percent"
                  />
                </ToggleGroup>
              </FlexItem>
              <FlexItem>
                <Legend />
              </FlexItem>
            </Flex>
          </FlexItem>
        </Flex>
      </CardTitle>
      <CardBody>
        {isLoading && !memory ? (
          <Flex justifyContent={{ default: 'justifyContentCenter' }}>
            <FlexItem>
              <Spinner size="md" aria-label={t('overview.vramAllocation.loading')} />
            </FlexItem>
          </Flex>
        ) : !memory || memory.workers.length === 0 ? (
          <EmptyMemoryState />
        ) : (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--pf-t--global--spacer--lg)',
            }}
          >
            {memory.workers.map((worker) => (
              <WorkerGpuSection
                key={worker.workerId}
                workerId={worker.workerId}
                devices={worker.devices}
                models={worker.models}
                displayMode={displayMode}
              />
            ))}
          </div>
        )}
      </CardBody>
    </Card>
  );
}
