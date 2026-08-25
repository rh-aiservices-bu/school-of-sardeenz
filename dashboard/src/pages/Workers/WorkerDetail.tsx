import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Alert,
  Breadcrumb,
  BreadcrumbItem,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Content,
  DescriptionList,
  DescriptionListDescription,
  DescriptionListGroup,
  DescriptionListTerm,
  ExpandableSection,
  Flex,
  FlexItem,
  Gallery,
  Label,
  PageSection,
  Progress,
  Spinner,
  Title,
} from '@patternfly/react-core';
import { Table, Thead, Tbody, Tr, Th, Td } from '@patternfly/react-table';
import { useTranslation } from 'react-i18next';
import { type ControlPlaneComponents } from '@sardeenz/types';
import { useWorker } from '../../hooks/useWorkers';
import { StateLabel } from '../../components/StateLabel';
import { formatBytes, formatDateTime, formatRelativeTime } from '../../utils/format';
import { getWorkerStatusColor } from '../../utils/state-colors';

type WorkerDetail = ControlPlaneComponents['schemas']['WorkerDetail'];
type DeviceInfo = ControlPlaneComponents['schemas']['DeviceInfo'];
type WorkerModelInfo = ControlPlaneComponents['schemas']['WorkerModelInfo'];
type WorkerRunnerCapability = ControlPlaneComponents['schemas']['WorkerRunnerCapability'];

// ---------------------------------------------------------------------------
// Device memory card
// ---------------------------------------------------------------------------
interface DeviceCardProps {
  device: DeviceInfo;
  /** Models running on this worker (shown inside the card for per-device context). */
  workerModels?: WorkerModelInfo[];
}

function DeviceCard({ device, workerModels }: DeviceCardProps) {
  const { t } = useTranslation('workers');
  const {
    deviceIndex,
    deviceType,
    deviceName,
    memoryTotalBytes,
    memoryUsedBytes,
    memoryAvailableBytes,
    utilizationPercent,
    temperatureC,
  } = device;
  // memoryUsedBytes IS the NVML measurement now (doctrine: measured memory is the only number,
  // #163) — no more allocated-estimate/reserved lines to show.
  const usedPercent =
    memoryTotalBytes > 0
      ? Math.min(100, Math.round((memoryUsedBytes / memoryTotalBytes) * 100))
      : 0;
  const hasUtilOrTemp = utilizationPercent != null || temperatureC != null;

  return (
    <Card isCompact>
      <CardHeader>
        <CardTitle>{deviceName ?? `GPU ${deviceIndex} — ${deviceType}`}</CardTitle>
      </CardHeader>
      <CardBody>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--pf-t--global--spacer--sm)',
          }}
        >
          {hasUtilOrTemp && (
            <div
              style={{
                fontSize: 'var(--pf-t--global--font--size--xs)',
                color: 'var(--pf-t--global--text--color--subtle)',
              }}
            >
              {t('detail.utilTemp', { util: utilizationPercent ?? '—', temp: temperatureC ?? '—' })}
            </div>
          )}
          <Progress value={usedPercent} aria-label={`GPU ${deviceIndex} memory usage`} />
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              fontSize: 'var(--pf-t--global--font--size--sm)',
            }}
          >
            <span style={{ fontWeight: 'var(--pf-t--global--font--weight--bold)' }}>
              {t('detail.memory.used', { value: formatBytes(memoryUsedBytes) })}
            </span>
            <span style={{ color: 'var(--pf-t--global--text--color--subtle)' }}>
              {t('detail.memory.total', { value: formatBytes(memoryTotalBytes) })}
            </span>
          </div>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--pf-t--global--spacer--xs)',
              fontSize: 'var(--pf-t--global--font--size--sm)',
              color: 'var(--pf-t--global--text--color--subtle)',
            }}
          >
            <div>{t('detail.memory.available', { value: formatBytes(memoryAvailableBytes) })}</div>
          </div>

          {/* Per-device model breakdown */}
          {workerModels !== undefined && (
            <div
              style={{
                borderTop: '1px solid var(--pf-t--global--border--color--default)',
                paddingTop: 'var(--pf-t--global--spacer--sm)',
                marginTop: 'var(--pf-t--global--spacer--xs)',
              }}
            >
              <div
                style={{
                  fontSize: 'var(--pf-t--global--font--size--xs)',
                  fontWeight: 'var(--pf-t--global--font--weight--bold)',
                  color: 'var(--pf-t--global--text--color--subtle)',
                  marginBottom: 'var(--pf-t--global--spacer--xs)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                }}
              >
                {t('detail.deviceModels.title')}
              </div>
              {workerModels.length === 0 ? (
                <div
                  style={{
                    fontSize: 'var(--pf-t--global--font--size--sm)',
                    color: 'var(--pf-t--global--text--color--subtle)',
                  }}
                >
                  {t('detail.deviceModels.none')}
                </div>
              ) : (
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 'var(--pf-t--global--spacer--xs)',
                  }}
                >
                  {workerModels.map((m) => (
                    <div
                      key={m.modelName}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        fontSize: 'var(--pf-t--global--font--size--sm)',
                      }}
                    >
                      <Link
                        to={`/models/${encodeURIComponent(m.modelName)}`}
                        style={{
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          maxWidth: '60%',
                        }}
                      >
                        {m.modelName}
                      </Link>
                      <span
                        style={{
                          color: 'var(--pf-t--global--text--color--subtle)',
                          whiteSpace: 'nowrap',
                          marginLeft: 'var(--pf-t--global--spacer--xs)',
                        }}
                      >
                        {m.memoryUsedBytes != null ? formatBytes(m.memoryUsedBytes) : '—'}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </CardBody>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Running models table
// ---------------------------------------------------------------------------
function RunningModelsSection({ models }: { models: WorkerModelInfo[] }) {
  const { t } = useTranslation('workers');

  if (models.length === 0) {
    return (
      <div
        style={{
          color: 'var(--pf-t--global--text--color--subtle)',
          fontSize: 'var(--pf-t--global--font--size--sm)',
          padding: 'var(--pf-t--global--spacer--md) 0',
        }}
      >
        {t('detail.noModels')}
      </div>
    );
  }

  return (
    <Table aria-label={t('detail.runningModels')} variant="compact">
      <Thead>
        <Tr>
          <Th>{t('detail.runningModelsTable.modelName')}</Th>
          <Th>{t('detail.runningModelsTable.state')}</Th>
          <Th>{t('detail.runningModelsTable.devices')}</Th>
          <Th>{t('detail.runningModelsTable.memoryUsed')}</Th>
        </Tr>
      </Thead>
      <Tbody>
        {models.map((model) => (
          <Tr key={model.modelName}>
            <Td dataLabel={t('detail.runningModelsTable.modelName')}>
              <Link to={`/models/${encodeURIComponent(model.modelName)}`}>{model.modelName}</Link>
            </Td>
            <Td dataLabel={t('detail.runningModelsTable.state')}>
              <StateLabel state={model.state} />
            </Td>
            <Td dataLabel={t('detail.runningModelsTable.devices')}>
              {model.deviceIndices ? model.deviceIndices.map((i) => `GPU ${i}`).join(', ') : '—'}
            </Td>
            <Td dataLabel={t('detail.runningModelsTable.memoryUsed')}>
              {model.memoryUsedBytes != null ? formatBytes(model.memoryUsedBytes) : '—'}
            </Td>
          </Tr>
        ))}
      </Tbody>
    </Table>
  );
}

// ---------------------------------------------------------------------------
// Runner capability row
// ---------------------------------------------------------------------------
function CapabilityCard({ capability }: { capability: WorkerRunnerCapability }) {
  const { t } = useTranslation('workers');

  return (
    <Card isCompact>
      <CardHeader>
        <CardTitle>
          {capability.engineName}{' '}
          <Label color="blue" isCompact>
            {capability.runnerType}
          </Label>
        </CardTitle>
      </CardHeader>
      <CardBody>
        <DescriptionList isCompact isHorizontal>
          <DescriptionListGroup>
            <DescriptionListTerm>{t('detail.capabilityCard.modelTypes')}</DescriptionListTerm>
            <DescriptionListDescription>
              {capability.supportedModelTypes.length > 0
                ? capability.supportedModelTypes.join(', ')
                : '—'}
            </DescriptionListDescription>
          </DescriptionListGroup>
          <DescriptionListGroup>
            <DescriptionListTerm>{t('detail.capabilityCard.deviceTypes')}</DescriptionListTerm>
            <DescriptionListDescription>
              {capability.supportedDeviceTypes.length > 0
                ? capability.supportedDeviceTypes.join(', ')
                : '—'}
            </DescriptionListDescription>
          </DescriptionListGroup>
          {capability.supportedSleepLevels && capability.supportedSleepLevels.length > 0 && (
            <DescriptionListGroup>
              <DescriptionListTerm>{t('detail.capabilityCard.sleepLevels')}</DescriptionListTerm>
              <DescriptionListDescription>
                {capability.supportedSleepLevels.join(', ')}
              </DescriptionListDescription>
            </DescriptionListGroup>
          )}
        </DescriptionList>
      </CardBody>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Main detail component
// ---------------------------------------------------------------------------
function WorkerDetailContent({ worker }: { worker: WorkerDetail }) {
  const { t } = useTranslation('workers');
  const statusColor = getWorkerStatusColor(worker.status);
  const statusLabel = worker.status.charAt(0) + worker.status.slice(1).toLowerCase();

  const hasCapabilities = worker.runnerCapabilities != null && worker.runnerCapabilities.length > 0;

  const [capabilitiesExpanded, setCapabilitiesExpanded] = useState(false);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--pf-t--global--spacer--lg)',
      }}
    >
      {/* Breadcrumb */}
      <Breadcrumb>
        <BreadcrumbItem>
          <Link to="/">{t('detail.breadcrumb.cluster')}</Link>
        </BreadcrumbItem>
        <BreadcrumbItem>
          <Link to="/workers">{t('detail.breadcrumb.workers')}</Link>
        </BreadcrumbItem>
        <BreadcrumbItem isActive>{worker.workerId}</BreadcrumbItem>
      </Breadcrumb>

      {/* Header */}
      <Flex alignItems={{ default: 'alignItemsCenter' }} spaceItems={{ default: 'spaceItemsMd' }}>
        <FlexItem>
          <Title headingLevel="h1" size="2xl">
            {worker.workerId}
          </Title>
        </FlexItem>
        <FlexItem>
          <Label color={statusColor}>{statusLabel}</Label>
        </FlexItem>
      </Flex>

      {/* Worker metadata */}
      <DescriptionList isCompact isHorizontal columnModifier={{ default: '2Col' }}>
        <DescriptionListGroup>
          <DescriptionListTerm>{t('detail.fields.lastHeartbeat')}</DescriptionListTerm>
          <DescriptionListDescription>
            {worker.lastHeartbeatAt ? (
              <>
                {formatRelativeTime(worker.lastHeartbeatAt)}{' '}
                <span
                  style={{
                    color: 'var(--pf-t--global--text--color--subtle)',
                    fontSize: 'var(--pf-t--global--font--size--sm)',
                  }}
                >
                  ({formatDateTime(worker.lastHeartbeatAt)})
                </span>
              </>
            ) : (
              '—'
            )}
          </DescriptionListDescription>
        </DescriptionListGroup>
        {worker.joinedAt && (
          <DescriptionListGroup>
            <DescriptionListTerm>{t('detail.fields.joined')}</DescriptionListTerm>
            <DescriptionListDescription>
              {formatDateTime(worker.joinedAt)}
            </DescriptionListDescription>
          </DescriptionListGroup>
        )}
        <DescriptionListGroup>
          <DescriptionListTerm>{t('detail.fields.devices')}</DescriptionListTerm>
          <DescriptionListDescription>
            {worker.devices.length > 0
              ? `${worker.devices.length} GPU${worker.devices.length !== 1 ? 's' : ''}`
              : '—'}
          </DescriptionListDescription>
        </DescriptionListGroup>
        <DescriptionListGroup>
          <DescriptionListTerm>{t('detail.fields.modelsRunning')}</DescriptionListTerm>
          <DescriptionListDescription>{worker.models.length}</DescriptionListDescription>
        </DescriptionListGroup>
      </DescriptionList>

      {/* Device memory cards */}
      {worker.devices.length > 0 &&
        (() => {
          const hasDeviceAttribution = worker.models.some((m) => m.deviceIndices);
          return (
            <div>
              <Title
                headingLevel="h2"
                size="lg"
                style={{ marginBottom: 'var(--pf-t--global--spacer--md)' }}
              >
                {t('detail.deviceMemory')}
              </Title>
              <Gallery hasGutter minWidths={{ default: '280px' }}>
                {worker.devices.map((device) => (
                  <DeviceCard
                    key={device.deviceIndex}
                    device={device}
                    workerModels={
                      hasDeviceAttribution
                        ? worker.models.filter((m) => m.deviceIndices?.includes(device.deviceIndex))
                        : undefined
                    }
                  />
                ))}
              </Gallery>
            </div>
          );
        })()}

      {/* Running models */}
      <div>
        <Title
          headingLevel="h2"
          size="lg"
          style={{ marginBottom: 'var(--pf-t--global--spacer--md)' }}
        >
          {t('detail.runningModels')}
        </Title>
        <RunningModelsSection models={worker.models} />
      </div>

      {/* Runner capabilities */}
      {hasCapabilities && (
        <div>
          <ExpandableSection
            toggleText={
              capabilitiesExpanded
                ? t('detail.capabilities.hide')
                : t('detail.capabilities.show', { count: worker.runnerCapabilities!.length })
            }
            onToggle={(_ev, isExpanded) => setCapabilitiesExpanded(isExpanded)}
            isExpanded={capabilitiesExpanded}
          >
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--pf-t--global--spacer--sm)',
                marginTop: 'var(--pf-t--global--spacer--sm)',
              }}
            >
              {worker.runnerCapabilities!.map((cap) => (
                <CapabilityCard key={`${cap.runnerType}-${cap.engineName}`} capability={cap} />
              ))}
            </div>
          </ExpandableSection>
        </div>
      )}
    </div>
  );
}

export function WorkerDetail() {
  const { t } = useTranslation('workers');
  const { t: tCommon } = useTranslation('common');
  const { workerId } = useParams<{ workerId: string }>();
  const id = workerId ?? '';
  const { data: worker, isLoading, error } = useWorker(id);

  if (isLoading) {
    return (
      <PageSection>
        <Flex justifyContent={{ default: 'justifyContentCenter' }}>
          <FlexItem>
            <Spinner size="xl" aria-label={t('detail.errors.failedToLoad')} />
          </FlexItem>
        </Flex>
      </PageSection>
    );
  }

  if (error) {
    return (
      <PageSection>
        <Alert variant="danger" title={t('detail.errors.failedToLoad')} isInline>
          <Content>{error instanceof Error ? error.message : tCommon('errors.unexpected')}</Content>
        </Alert>
      </PageSection>
    );
  }

  if (!worker) {
    return (
      <PageSection>
        <Alert variant="warning" title={t('detail.errors.notFound')} isInline>
          <Content>{t('detail.errors.notFoundBody', { workerId: id })}</Content>
        </Alert>
      </PageSection>
    );
  }

  return (
    <PageSection>
      <WorkerDetailContent worker={worker} />
    </PageSection>
  );
}
