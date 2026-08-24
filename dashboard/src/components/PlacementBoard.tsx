import {
  Badge,
  Button,
  Card,
  CardBody,
  CardTitle,
  EmptyState,
  EmptyStateActions,
  EmptyStateBody,
  EmptyStateFooter,
  Flex,
  FlexItem,
  Spinner,
  Title,
} from '@patternfly/react-core';
import { CubesIcon } from '@patternfly/react-icons';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { type ControlPlaneComponents } from '@sardeenz/types';
import { useClusterMemory } from '../hooks/useCluster';
import { WorkerGpuSection } from './WorkerGpuSection';
import { StateLabel } from './StateLabel';
import { groupWorkerPlacement, isClusterEmpty, type MemoryWorker } from '../utils/placement';

type WorkerModelInfo = ControlPlaneComponents['schemas']['WorkerModelInfo'];

// ---------------------------------------------------------------------------
// A single "model chip": name (linking to its detail page) + lifecycle state.
// Mirrors the chip idiom in WorkerGpuSection's worker-level model summary.
// ---------------------------------------------------------------------------
function ModelChip({ model }: { model: WorkerModelInfo }) {
  const { t } = useTranslation('cluster');
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 'var(--pf-t--global--spacer--xs)',
        fontSize: 'var(--pf-t--global--font--size--sm)',
        background: 'var(--pf-t--global--background--color--secondary--default)',
        border: '1px solid var(--pf-t--global--border--color--default)',
        borderRadius: '4px',
        padding: '2px var(--pf-t--global--spacer--xs)',
      }}
    >
      <Link
        to={`/models/${encodeURIComponent(model.modelName)}`}
        aria-label={t('overview.placement.viewModel', { model: model.modelName })}
        style={{
          color: 'var(--pf-t--global--text--color--link--default)',
          textDecoration: 'none',
        }}
      >
        {model.modelName}
      </Link>
      <StateLabel state={model.state} isCompact />
    </span>
  );
}

// ---------------------------------------------------------------------------
// Placement summary rows for a single worker — GPU groups, tensor-parallel,
// unplaced and placement-untracked fallbacks.
// ---------------------------------------------------------------------------
function PlacementSummary({ worker }: { worker: MemoryWorker }) {
  const { t } = useTranslation('cluster');
  const placement = groupWorkerPlacement(worker);

  const rowStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 'var(--pf-t--global--spacer--sm)',
    flexWrap: 'wrap',
  };
  const labelStyle: React.CSSProperties = {
    flexShrink: 0,
    minWidth: '9ch',
    fontSize: 'var(--pf-t--global--font--size--sm)',
    color: 'var(--pf-t--global--text--color--subtle)',
  };
  const chipsStyle: React.CSSProperties = {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 'var(--pf-t--global--spacer--xs)',
  };

  if (placement.placementUntracked) {
    return (
      <div style={rowStyle}>
        <span style={labelStyle}>{t('overview.placement.placementUnknown')}</span>
        <div style={chipsStyle}>
          {(worker.models ?? []).map((m, i) => (
            <ModelChip key={`${m.modelName}#${i}`} model={m} />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--pf-t--global--spacer--xs)' }}>
      {placement.byDevice
        .filter((d) => d.models.length > 0)
        .map((d) => (
          <div key={d.deviceIndex} style={rowStyle}>
            <span style={labelStyle}>{t('overview.placement.gpu', { index: d.deviceIndex })}</span>
            <div style={chipsStyle}>
              {d.models.map((m, i) => (
                <ModelChip key={`${m.modelName}#${i}`} model={m} />
              ))}
            </div>
          </div>
        ))}

      {placement.tensorParallel.map((m, i) => (
        <div key={`${m.modelName}#tp#${i}`} style={rowStyle}>
          <span style={labelStyle}>
            {t('overview.placement.tensorParallel', {
              indices: (m.deviceIndices ?? []).join(', '),
            })}
          </span>
          <div style={chipsStyle}>
            <ModelChip model={m} />
            <Badge>{t('overview.placement.tpBadge', { count: m.deviceIndices?.length ?? 0 })}</Badge>
          </div>
        </div>
      ))}

      {placement.unplaced.length > 0 && (
        <div style={rowStyle}>
          <span style={labelStyle} title={t('overview.placement.unplacedHint')}>
            {t('overview.placement.unplaced')}
          </span>
          <div style={chipsStyle}>
            {placement.unplaced.map((m, i) => (
              <ModelChip key={`${m.modelName}#${i}`} model={m} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty cluster state
// ---------------------------------------------------------------------------
function EmptyPlacementState() {
  const { t } = useTranslation('cluster');
  const navigate = useNavigate();

  return (
    <EmptyState headingLevel="h3" icon={CubesIcon} titleText={t('overview.placement.empty.title')}>
      <EmptyStateBody>{t('overview.placement.empty.body')}</EmptyStateBody>
      <EmptyStateFooter>
        <EmptyStateActions>
          <Button variant="primary" onClick={() => void navigate('/models/deploy')}>
            {t('overview.placement.empty.deployButton')}
          </Button>
        </EmptyStateActions>
      </EmptyStateFooter>
    </EmptyState>
  );
}

// ---------------------------------------------------------------------------
// Public component — home-view placement board: worker -> GPUs -> placed models.
// Composes WorkerGpuSection (#123) for the per-GPU memory bars and layers a
// placement summary (grouping, TP, unplaced) on top. No move-model control.
// ---------------------------------------------------------------------------
export function PlacementBoard() {
  const { t } = useTranslation('cluster');
  const { data: memory, isLoading } = useClusterMemory();

  return (
    <Card>
      <CardTitle>
        <Title headingLevel="h2" size="lg">
          {t('overview.placement.title')}
        </Title>
      </CardTitle>
      <CardBody>
        {isLoading && !memory ? (
          <Flex justifyContent={{ default: 'justifyContentCenter' }}>
            <FlexItem>
              <Spinner size="md" aria-label={t('overview.placement.loading')} />
            </FlexItem>
          </Flex>
        ) : isClusterEmpty(memory) ? (
          <EmptyPlacementState />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--pf-t--global--spacer--lg)' }}>
            {memory?.workers.map((worker) => (
              <div key={worker.workerId}>
                <div style={{ marginBottom: 'var(--pf-t--global--spacer--sm)' }}>
                  <Link
                    to={`/workers/${encodeURIComponent(worker.workerId)}`}
                    style={{
                      fontWeight: 'var(--pf-t--global--font--weight--bold)',
                      fontSize: 'var(--pf-t--global--font--size--sm)',
                      color: 'var(--pf-t--global--text--color--link--default)',
                      textDecoration: 'none',
                    }}
                  >
                    {worker.workerId}
                  </Link>
                </div>

                <WorkerGpuSection
                  workerId={worker.workerId}
                  devices={worker.devices}
                  models={worker.models}
                  displayMode="bytes"
                  showHeader={false}
                />

                <div style={{ marginTop: 'var(--pf-t--global--spacer--sm)' }}>
                  <PlacementSummary worker={worker} />
                </div>
              </div>
            ))}
          </div>
        )}
      </CardBody>
    </Card>
  );
}
