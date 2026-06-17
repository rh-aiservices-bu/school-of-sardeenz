import {
  Alert,
  Card,
  CardBody,
  CardTitle,
  Content,
  Flex,
  FlexItem,
  Gallery,
  Label,
  PageSection,
  Progress,
  Spinner,
  Title,
} from '@patternfly/react-core';
import { ChartDonut } from '@patternfly/react-charts/victory';
import {
  CubesIcon,
  ExclamationTriangleIcon,
  MemoryIcon,
  ServerIcon,
} from '@patternfly/react-icons';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { ModelLifecycleState, type ControlPlaneComponents } from '@sardeenz/types';
import { useClusterStatus } from '../../hooks/useCluster';
import { useEventStream } from '../../hooks/useEventStream';
import { StateLabel } from '../../components/StateLabel';
import { MemoryVisualization } from '../../components/MemoryVisualization';
import { formatBytes, formatRelativeTime } from '../../utils/format';

type ClusterStatus = ControlPlaneComponents['schemas']['ClusterStatus'];
type ClusterEvent = ControlPlaneComponents['schemas']['ClusterEvent'];

// ---------------------------------------------------------------------------
// Summary card: Workers
// ---------------------------------------------------------------------------
function WorkersCard({ status }: { status: ClusterStatus }) {
  const { t } = useTranslation('cluster');
  const online = status.workersOnline ?? 0;
  const total = status.workerCount;
  const color: 'green' | 'red' | 'grey' = total === 0 ? 'grey' : online === total ? 'green' : 'red';

  return (
    <Card isCompact>
      <CardTitle>
        <Flex spaceItems={{ default: 'spaceItemsSm' }} alignItems={{ default: 'alignItemsCenter' }}>
          <FlexItem>
            <ServerIcon style={{ color: 'var(--pf-t--global--text--color--subtle)' }} />
          </FlexItem>
          <FlexItem>{t('overview.cards.workers.title')}</FlexItem>
        </Flex>
      </CardTitle>
      <CardBody>
        <span
          style={{
            fontSize: 'var(--pf-t--global--font--size--2xl)',
            fontWeight: 'var(--pf-t--global--font--weight--bold)',
          }}
        >
          {online}
        </span>
        <span style={{ color: 'var(--pf-t--global--text--color--subtle)' }}> / {total}</span>
        <div style={{ marginTop: 'var(--pf-t--global--spacer--xs)' }}>
          <Label color={color} isCompact>
            {total === 0
              ? t('overview.cards.workers.noWorkers')
              : online === total
                ? t('overview.cards.workers.allOnline')
                : t('overview.cards.workers.offline', { count: total - online })}
          </Label>
        </div>
      </CardBody>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Summary card: Models
// ---------------------------------------------------------------------------
function ModelsCard({ status }: { status: ClusterStatus }) {
  const { t } = useTranslation('cluster');
  const { active = 0, sleeping = 0, total } = status.modelCounts;

  return (
    <Card isCompact>
      <CardTitle>
        <Flex spaceItems={{ default: 'spaceItemsSm' }} alignItems={{ default: 'alignItemsCenter' }}>
          <FlexItem>
            <CubesIcon style={{ color: 'var(--pf-t--global--text--color--subtle)' }} />
          </FlexItem>
          <FlexItem>{t('overview.cards.models.title')}</FlexItem>
        </Flex>
      </CardTitle>
      <CardBody>
        <span
          style={{
            fontSize: 'var(--pf-t--global--font--size--2xl)',
            fontWeight: 'var(--pf-t--global--font--weight--bold)',
          }}
        >
          {total}
        </span>
        <span style={{ color: 'var(--pf-t--global--text--color--subtle)' }}>
          {t('overview.cards.models.total')}
        </span>
        <div
          style={{
            marginTop: 'var(--pf-t--global--spacer--xs)',
            display: 'flex',
            gap: 'var(--pf-t--global--spacer--xs)',
            flexWrap: 'wrap',
          }}
        >
          <Label color="green" isCompact>
            {t('overview.cards.models.active', { count: active })}
          </Label>
          <Label color="blue" isCompact>
            {t('overview.cards.models.sleeping', { count: sleeping })}
          </Label>
        </div>
      </CardBody>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Summary card: GPU Memory
// ---------------------------------------------------------------------------
function GpuMemoryCard({ status }: { status: ClusterStatus }) {
  const { t } = useTranslation('cluster');
  const { totalBytes, usedBytes, availableBytes } = status.memory;
  const percent = totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 100) : 0;

  return (
    <Card isCompact>
      <CardTitle>
        <Flex spaceItems={{ default: 'spaceItemsSm' }} alignItems={{ default: 'alignItemsCenter' }}>
          <FlexItem>
            <MemoryIcon style={{ color: 'var(--pf-t--global--text--color--subtle)' }} />
          </FlexItem>
          <FlexItem>{t('overview.cards.gpuMemory.title')}</FlexItem>
        </Flex>
      </CardTitle>
      <CardBody>
        <span
          style={{
            fontSize: 'var(--pf-t--global--font--size--2xl)',
            fontWeight: 'var(--pf-t--global--font--weight--bold)',
          }}
        >
          {percent}%
        </span>
        <span style={{ color: 'var(--pf-t--global--text--color--subtle)' }}>
          {t('overview.cards.gpuMemory.used')}
        </span>
        <Progress
          value={percent}
          aria-label={t('overview.cards.gpuMemory.title')}
          style={{ marginTop: 'var(--pf-t--global--spacer--xs)' }}
        />
        <div
          style={{
            marginTop: 'var(--pf-t--global--spacer--xs)',
            fontSize: 'var(--pf-t--global--font--size--sm)',
            color: 'var(--pf-t--global--text--color--subtle)',
          }}
        >
          {t('overview.cards.gpuMemory.available', {
            value: formatBytes(availableBytes),
            total: formatBytes(totalBytes),
          })}
        </div>
      </CardBody>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Summary card: Alerts
// ---------------------------------------------------------------------------
function AlertsCard({ status }: { status: ClusterStatus }) {
  const { t } = useTranslation('cluster');
  const errorModels = status.modelCounts.error ?? 0;
  const offlineWorkers = status.workerCount - (status.workersOnline ?? status.workerCount);
  const total = errorModels + offlineWorkers;
  const color: 'red' | 'green' = total > 0 ? 'red' : 'green';

  return (
    <Card isCompact>
      <CardTitle>
        <Flex spaceItems={{ default: 'spaceItemsSm' }} alignItems={{ default: 'alignItemsCenter' }}>
          <FlexItem>
            <ExclamationTriangleIcon
              style={{ color: 'var(--pf-t--global--text--color--subtle)' }}
            />
          </FlexItem>
          <FlexItem>{t('overview.cards.alerts.title')}</FlexItem>
        </Flex>
      </CardTitle>
      <CardBody>
        <span
          style={{
            fontSize: 'var(--pf-t--global--font--size--2xl)',
            fontWeight: 'var(--pf-t--global--font--weight--bold)',
          }}
        >
          {total}
        </span>
        <span style={{ color: 'var(--pf-t--global--text--color--subtle)' }}>
          {total === 1 ? t('overview.cards.alerts.issue') : t('overview.cards.alerts.issues')}
        </span>
        <div
          style={{
            marginTop: 'var(--pf-t--global--spacer--xs)',
            display: 'flex',
            gap: 'var(--pf-t--global--spacer--xs)',
            flexWrap: 'wrap',
          }}
        >
          {errorModels > 0 && (
            <Label color="red" isCompact>
              {t('overview.cards.alerts.modelErrors', { count: errorModels })}
            </Label>
          )}
          {offlineWorkers > 0 && (
            <Label color="red" isCompact>
              {t('overview.cards.alerts.workersOffline', { count: offlineWorkers })}
            </Label>
          )}
          {total === 0 && (
            <Label color={color} isCompact>
              {t('overview.cards.alerts.allClear')}
            </Label>
          )}
        </div>
      </CardBody>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Row 1: Summary cards gallery
// ---------------------------------------------------------------------------
function SummaryCards({ status }: { status: ClusterStatus }) {
  return (
    <Gallery hasGutter minWidths={{ default: '200px' }}>
      <WorkersCard status={status} />
      <ModelsCard status={status} />
      <GpuMemoryCard status={status} />
      <AlertsCard status={status} />
    </Gallery>
  );
}

// ---------------------------------------------------------------------------
// Row 2: Memory donut chart
// ---------------------------------------------------------------------------
function MemoryDonutChart({ status }: { status: ClusterStatus }) {
  const { t } = useTranslation('cluster');
  const { totalBytes, usedBytes, availableBytes } = status.memory;
  const percent = totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 100) : 0;

  const data = [
    { x: t('overview.vramUsage.used'), y: usedBytes },
    { x: t('overview.vramUsage.available'), y: availableBytes },
  ];

  return (
    <Card>
      <CardTitle>
        <Title headingLevel="h2" size="lg">
          {t('overview.vramUsage.title')}
        </Title>
      </CardTitle>
      <CardBody>
        <div
          style={{ display: 'flex', alignItems: 'center', gap: 'var(--pf-t--global--spacer--xl)' }}
        >
          <div style={{ height: '200px', width: '200px', flexShrink: 0 }}>
            <ChartDonut
              ariaDesc={t('overview.vramUsage.ariaDesc')}
              ariaTitle={t('overview.vramUsage.title')}
              constrainToVisibleArea
              data={data}
              height={200}
              width={200}
              title={`${percent}%`}
              subTitle={t('overview.cards.gpuMemory.used').trim()}
              colorScale={['var(--pf-t-chart-color-blue-300)', 'var(--pf-t-chart-color-blue-100)']}
              legendData={[
                { name: `${t('overview.vramUsage.used')}: ${formatBytes(usedBytes)}` },
                { name: `${t('overview.vramUsage.available')}: ${formatBytes(availableBytes)}` },
              ]}
              legendOrientation="vertical"
              legendPosition="right"
            />
          </div>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--pf-t--global--spacer--sm)',
            }}
          >
            <div>
              <div
                style={{
                  fontSize: 'var(--pf-t--global--font--size--sm)',
                  color: 'var(--pf-t--global--text--color--subtle)',
                }}
              >
                {t('overview.vramUsage.used')}
              </div>
              <div
                style={{
                  fontSize: 'var(--pf-t--global--font--size--xl)',
                  fontWeight: 'var(--pf-t--global--font--weight--bold)',
                }}
              >
                {formatBytes(usedBytes)}
              </div>
            </div>
            <div>
              <div
                style={{
                  fontSize: 'var(--pf-t--global--font--size--sm)',
                  color: 'var(--pf-t--global--text--color--subtle)',
                }}
              >
                {t('overview.vramUsage.available')}
              </div>
              <div
                style={{
                  fontSize: 'var(--pf-t--global--font--size--xl)',
                  fontWeight: 'var(--pf-t--global--font--weight--bold)',
                }}
              >
                {formatBytes(availableBytes)}
              </div>
            </div>
            <div>
              <div
                style={{
                  fontSize: 'var(--pf-t--global--font--size--sm)',
                  color: 'var(--pf-t--global--text--color--subtle)',
                }}
              >
                {t('overview.vramUsage.total')}
              </div>
              <div style={{ fontWeight: 'var(--pf-t--global--font--weight--bold)' }}>
                {formatBytes(totalBytes)}
              </div>
            </div>
          </div>
        </div>
      </CardBody>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Row 3: Model state breakdown
// ---------------------------------------------------------------------------
const MODEL_STATE_DISPLAY_ORDER: ModelLifecycleState[] = [
  ModelLifecycleState.ACTIVE,
  ModelLifecycleState.SLEEPING,
  ModelLifecycleState.STARTING,
  ModelLifecycleState.PENDING,
  ModelLifecycleState.DRAINING,
  ModelLifecycleState.STOPPING,
  ModelLifecycleState.STOPPED,
  ModelLifecycleState.ERROR,
];

function stateCountFromStatus(status: ClusterStatus, state: ModelLifecycleState): number {
  const mc = status.modelCounts;
  switch (state) {
    case ModelLifecycleState.ACTIVE:
      return mc.active ?? 0;
    case ModelLifecycleState.SLEEPING:
      return mc.sleeping ?? 0;
    case ModelLifecycleState.STARTING:
      return mc.starting ?? 0;
    case ModelLifecycleState.ERROR:
      return mc.error ?? 0;
    // PENDING, DRAINING, STOPPING, STOPPED all roll into "other"
    default:
      return 0;
  }
}

const OTHER_STATES = [
  ModelLifecycleState.PENDING,
  ModelLifecycleState.DRAINING,
  ModelLifecycleState.STOPPING,
  ModelLifecycleState.STOPPED,
];

function ModelStateBreakdown({ status }: { status: ClusterStatus }) {
  const { t } = useTranslation('cluster');
  const navigate = useNavigate();
  const other = status.modelCounts.other ?? 0;

  const stateRowStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 'var(--pf-t--global--spacer--md)',
    cursor: 'pointer',
    padding: 'var(--pf-t--global--spacer--xs) var(--pf-t--global--spacer--sm)',
    borderRadius: 'var(--pf-t--global--border--radius--small)',
  };

  const handleKeyDown = (e: React.KeyboardEvent, url: string) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      void navigate(url);
    }
  };

  return (
    <Card>
      <CardTitle>
        <Title headingLevel="h2" size="lg">
          {t('overview.modelStateBreakdown.title')}
        </Title>
      </CardTitle>
      <CardBody>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--pf-t--global--spacer--sm)',
          }}
        >
          {MODEL_STATE_DISPLAY_ORDER.map((state) => {
            const count = stateCountFromStatus(status, state);
            if (count === 0 && state !== ModelLifecycleState.ACTIVE) return null;
            const url = `/models?state=${state}`;
            return (
              <div
                key={state}
                role="link"
                tabIndex={0}
                onClick={() => void navigate(url)}
                onKeyDown={(e) => handleKeyDown(e, url)}
                aria-label={t('overview.modelStateBreakdown.viewModels', { state, count })}
                style={stateRowStyle}
              >
                <StateLabel state={state} isCompact />
                <span
                  style={{
                    fontSize: 'var(--pf-t--global--font--size--lg)',
                    fontWeight: 'var(--pf-t--global--font--weight--bold)',
                    minWidth: '2ch',
                    textAlign: 'right',
                  }}
                >
                  {count}
                </span>
              </div>
            );
          })}
          {other > 0 && (
            <div
              role="link"
              tabIndex={0}
              onClick={() =>
                void navigate(`/models?${OTHER_STATES.map((s) => `state=${s}`).join('&')}`)
              }
              onKeyDown={(e) =>
                handleKeyDown(e, `/models?${OTHER_STATES.map((s) => `state=${s}`).join('&')}`)
              }
              aria-label={t('overview.modelStateBreakdown.viewModels', {
                state: t('overview.modelStateBreakdown.other'),
                count: other,
              })}
              style={stateRowStyle}
            >
              <Label color="grey" isCompact>
                {t('overview.modelStateBreakdown.other')}
              </Label>
              <span
                style={{
                  fontSize: 'var(--pf-t--global--font--size--lg)',
                  fontWeight: 'var(--pf-t--global--font--weight--bold)',
                  minWidth: '2ch',
                  textAlign: 'right',
                }}
              >
                {other}
              </span>
            </div>
          )}
        </div>
      </CardBody>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Event type label color mapping
// ---------------------------------------------------------------------------
function getEventTypeColor(
  type: string,
): 'blue' | 'teal' | 'green' | 'orange' | 'red' | 'purple' | 'grey' | 'yellow' {
  switch (type) {
    case 'MODEL_DEPLOYED':
      return 'green';
    case 'MODEL_REMOVED':
      return 'orange';
    case 'MODEL_STATE_CHANGED':
      return 'blue';
    case 'WORKER_JOINED':
      return 'teal';
    case 'WORKER_LEFT':
      return 'orange';
    case 'WORKER_MEMORY_UPDATED':
      return 'grey';
    case 'EVICTION_TRIGGERED':
      return 'red';
    case 'PLACEMENT_COMPLETED':
      return 'purple';
    default:
      return 'grey';
  }
}

function formatEventType(type: string): string {
  return type
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// Row 4: Recent events
// ---------------------------------------------------------------------------
function EventEntry({ event }: { event: ClusterEvent }) {
  const color = getEventTypeColor(event.type);
  const description =
    event.message ??
    (event.modelName ? `Model: ${event.modelName}` : null) ??
    (event.workerId ? `Worker: ${event.workerId}` : null) ??
    '—';

  return (
    <li
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 'var(--pf-t--global--spacer--sm)',
        padding: 'var(--pf-t--global--spacer--xs) 0',
        borderBottom: '1px solid var(--pf-t--global--border--color--default)',
        listStyle: 'none',
      }}
    >
      <span
        style={{
          fontSize: 'var(--pf-t--global--font--size--sm)',
          color: 'var(--pf-t--global--text--color--subtle)',
          flexShrink: 0,
          minWidth: '5ch',
        }}
        title={event.timestamp}
      >
        {formatRelativeTime(event.timestamp)}
      </span>
      <Label color={color} isCompact style={{ flexShrink: 0 }}>
        {formatEventType(event.type)}
      </Label>
      <span
        style={{
          fontSize: 'var(--pf-t--global--font--size--sm)',
          color: 'var(--pf-t--global--text--color--default)',
          wordBreak: 'break-word',
        }}
      >
        {description}
      </span>
    </li>
  );
}

function RecentEvents() {
  const { t } = useTranslation('cluster');
  const { status: connectionStatus, events } = useEventStream();
  const recent = events.slice(0, 20);

  const connectionColor: 'green' | 'orange' | 'red' =
    connectionStatus === 'connected'
      ? 'green'
      : connectionStatus === 'reconnecting'
        ? 'orange'
        : 'red';

  return (
    <Card>
      <CardTitle>
        <Flex
          spaceItems={{ default: 'spaceItemsSm' }}
          alignItems={{ default: 'alignItemsCenter' }}
          justifyContent={{ default: 'justifyContentSpaceBetween' }}
        >
          <FlexItem>
            <Title headingLevel="h2" size="lg">
              {t('overview.recentEvents.title')}
            </Title>
          </FlexItem>
          <FlexItem>
            <span aria-live="polite">
              <Label color={connectionColor} isCompact>
                {connectionStatus === 'connected'
                  ? t('overview.recentEvents.connectionStatus.live')
                  : connectionStatus === 'reconnecting'
                    ? t('overview.recentEvents.connectionStatus.reconnecting')
                    : t('overview.recentEvents.connectionStatus.degraded')}
              </Label>
            </span>
          </FlexItem>
        </Flex>
      </CardTitle>
      <CardBody>
        {recent.length === 0 ? (
          <div
            style={{
              color: 'var(--pf-t--global--text--color--subtle)',
              fontSize: 'var(--pf-t--global--font--size--sm)',
              textAlign: 'center',
              padding: 'var(--pf-t--global--spacer--lg) 0',
            }}
          >
            {t('overview.recentEvents.noEvents')}
          </div>
        ) : (
          <ul
            aria-live="polite"
            aria-label={t('overview.recentEvents.ariaLabel')}
            style={{ margin: 0, padding: 0 }}
          >
            {recent.map((event, idx) => (
              <EventEntry key={`${event.timestamp}-${event.type}-${idx}`} event={event} />
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Main page component
// ---------------------------------------------------------------------------
export function ClusterOverview() {
  const { t } = useTranslation('cluster');
  const { t: tCommon } = useTranslation('common');
  const { data: status, isLoading, error } = useClusterStatus();

  if (isLoading) {
    return (
      <PageSection>
        <Flex justifyContent={{ default: 'justifyContentCenter' }}>
          <FlexItem>
            <Spinner size="xl" aria-label={t('overview.loading')} />
          </FlexItem>
        </Flex>
      </PageSection>
    );
  }

  if (error || !status) {
    return (
      <PageSection>
        <Alert variant="danger" title={t('overview.errors.failedToLoad')} isInline>
          <Content>{error instanceof Error ? error.message : tCommon('errors.unexpected')}</Content>
        </Alert>
      </PageSection>
    );
  }

  return (
    <PageSection>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--pf-t--global--spacer--lg)',
        }}
      >
        {/* Row 1: Summary cards */}
        <SummaryCards status={status} />

        {/* Rows 2 & 3: Donut chart + Model state breakdown side-by-side */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)',
            gap: 'var(--pf-t--global--spacer--lg)',
            alignItems: 'start',
          }}
        >
          <MemoryDonutChart status={status} />
          <ModelStateBreakdown status={status} />
        </div>

        {/* Row 2.5: Per-worker VRAM breakdown */}
        <MemoryVisualization />

        {/* Row 4: Recent events */}
        <RecentEvents />
      </div>
    </PageSection>
  );
}
