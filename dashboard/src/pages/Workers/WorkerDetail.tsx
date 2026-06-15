import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
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
function DeviceCard({ device }: { device: DeviceInfo }) {
  const { deviceIndex, deviceType, memoryTotalBytes, memoryUsedBytes, memoryAvailableBytes, memoryReservedBytes } = device;
  const usedPercent = memoryTotalBytes > 0 ? Math.round((memoryUsedBytes / memoryTotalBytes) * 100) : 0;

  return (
    <Card isCompact>
      <CardHeader>
        <CardTitle>
          GPU {deviceIndex} — {deviceType}
        </CardTitle>
      </CardHeader>
      <CardBody>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--pf-t--global--spacer--sm)',
          }}
        >
          <Progress
            value={usedPercent}
            aria-label={`GPU ${deviceIndex} memory usage`}
          />
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              fontSize: 'var(--pf-t--global--font--size--sm)',
            }}
          >
            <span style={{ fontWeight: 'var(--pf-t--global--font--weight--bold)' }}>
              {formatBytes(memoryUsedBytes)} used
            </span>
            <span style={{ color: 'var(--pf-t--global--text--color--subtle)' }}>
              {formatBytes(memoryTotalBytes)} total
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
            <div>Available: {formatBytes(memoryAvailableBytes)}</div>
            {memoryReservedBytes != null && memoryReservedBytes > 0 && (
              <div>Reserved: {formatBytes(memoryReservedBytes)}</div>
            )}
          </div>
        </div>
      </CardBody>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Running models table
// ---------------------------------------------------------------------------
function RunningModelsSection({ models }: { models: WorkerModelInfo[] }) {
  if (models.length === 0) {
    return (
      <div
        style={{
          color: 'var(--pf-t--global--text--color--subtle)',
          fontSize: 'var(--pf-t--global--font--size--sm)',
          padding: 'var(--pf-t--global--spacer--md) 0',
        }}
      >
        No models running on this worker.
      </div>
    );
  }

  return (
    <Table aria-label="Running models" variant="compact">
      <Thead>
        <Tr>
          <Th>Model Name</Th>
          <Th>State</Th>
          <Th>Memory Used</Th>
        </Tr>
      </Thead>
      <Tbody>
        {models.map((model) => (
          <Tr key={model.modelName}>
            <Td dataLabel="Model Name">
              <Link to={`/models/${encodeURIComponent(model.modelName)}`}>
                {model.modelName}
              </Link>
            </Td>
            <Td dataLabel="State">
              <StateLabel state={model.state} />
            </Td>
            <Td dataLabel="Memory Used">
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
            <DescriptionListTerm>Model types</DescriptionListTerm>
            <DescriptionListDescription>
              {capability.supportedModelTypes.length > 0
                ? capability.supportedModelTypes.join(', ')
                : '—'}
            </DescriptionListDescription>
          </DescriptionListGroup>
          <DescriptionListGroup>
            <DescriptionListTerm>Device types</DescriptionListTerm>
            <DescriptionListDescription>
              {capability.supportedDeviceTypes.length > 0
                ? capability.supportedDeviceTypes.join(', ')
                : '—'}
            </DescriptionListDescription>
          </DescriptionListGroup>
          {capability.supportedSleepLevels && capability.supportedSleepLevels.length > 0 && (
            <DescriptionListGroup>
              <DescriptionListTerm>Sleep levels</DescriptionListTerm>
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
  const statusColor = getWorkerStatusColor(worker.status);
  const statusLabel = worker.status.charAt(0) + worker.status.slice(1).toLowerCase();

  const hasCapabilities =
    worker.runnerCapabilities != null && worker.runnerCapabilities.length > 0;

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
          <Link to="/">Cluster</Link>
        </BreadcrumbItem>
        <BreadcrumbItem>
          <Link to="/workers">Workers</Link>
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
          <DescriptionListTerm>Last heartbeat</DescriptionListTerm>
          <DescriptionListDescription>
            {worker.lastHeartbeatAt ? (
              <>
                {formatRelativeTime(worker.lastHeartbeatAt)}{' '}
                <span style={{ color: 'var(--pf-t--global--text--color--subtle)', fontSize: 'var(--pf-t--global--font--size--sm)' }}>
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
            <DescriptionListTerm>Joined</DescriptionListTerm>
            <DescriptionListDescription>
              {formatDateTime(worker.joinedAt)}
            </DescriptionListDescription>
          </DescriptionListGroup>
        )}
        <DescriptionListGroup>
          <DescriptionListTerm>Devices</DescriptionListTerm>
          <DescriptionListDescription>
            {worker.devices.length > 0
              ? `${worker.devices.length} GPU${worker.devices.length !== 1 ? 's' : ''}`
              : '—'}
          </DescriptionListDescription>
        </DescriptionListGroup>
        <DescriptionListGroup>
          <DescriptionListTerm>Models running</DescriptionListTerm>
          <DescriptionListDescription>{worker.models.length}</DescriptionListDescription>
        </DescriptionListGroup>
      </DescriptionList>

      {/* Device memory cards */}
      {worker.devices.length > 0 && (
        <div>
          <Title
            headingLevel="h2"
            size="lg"
            style={{ marginBottom: 'var(--pf-t--global--spacer--md)' }}
          >
            Device Memory
          </Title>
          <Gallery hasGutter minWidths={{ default: '280px' }}>
            {worker.devices.map((device) => (
              <DeviceCard key={device.deviceIndex} device={device} />
            ))}
          </Gallery>
        </div>
      )}

      {/* Running models */}
      <div>
        <Title
          headingLevel="h2"
          size="lg"
          style={{ marginBottom: 'var(--pf-t--global--spacer--md)' }}
        >
          Running Models
        </Title>
        <RunningModelsSection models={worker.models} />
      </div>

      {/* Runner capabilities */}
      {hasCapabilities && (
        <div>
          <ExpandableSection
            toggleText={
              capabilitiesExpanded
                ? 'Hide runner capabilities'
                : `Show runner capabilities (${worker.runnerCapabilities!.length})`
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
  const { workerId } = useParams<{ workerId: string }>();
  const id = workerId ?? '';
  const { data: worker, isLoading, error } = useWorker(id);

  if (isLoading) {
    return (
      <PageSection>
        <Flex justifyContent={{ default: 'justifyContentCenter' }}>
          <FlexItem>
            <Spinner size="xl" aria-label="Loading worker details" />
          </FlexItem>
        </Flex>
      </PageSection>
    );
  }

  if (error) {
    return (
      <PageSection>
        <Alert variant="danger" title="Failed to load worker details" isInline>
          <Content>
            {error instanceof Error ? error.message : 'An unexpected error occurred.'}
          </Content>
        </Alert>
      </PageSection>
    );
  }

  if (!worker) {
    return (
      <PageSection>
        <Alert variant="warning" title="Worker not found" isInline>
          <Content>Worker &quot;{id}&quot; was not found or has disconnected.</Content>
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
