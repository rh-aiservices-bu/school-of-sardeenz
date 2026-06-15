import { Link } from 'react-router-dom';
import {
  Alert,
  EmptyState,
  EmptyStateBody,
  Flex,
  FlexItem,
  Label,
  PageSection,
  Content,
  Spinner,
  Title,
} from '@patternfly/react-core';
import { Table, Thead, Tbody, Tr, Th, Td } from '@patternfly/react-table';
import { ServerIcon } from '@patternfly/react-icons';
import { WorkerStatus, type ControlPlaneComponents } from '@sardeenz/types';
import { useWorkers } from '../../hooks/useWorkers';
import { formatBytes, formatRelativeTime } from '../../utils/format';
import { getWorkerStatusColor } from '../../utils/state-colors';

type WorkerInfo = ControlPlaneComponents['schemas']['WorkerInfo'];

function WorkerStatusLabel({ status }: { status: WorkerStatus }) {
  const color = getWorkerStatusColor(status);
  const label = status.charAt(0) + status.slice(1).toLowerCase();
  return (
    <Label color={color} isCompact>
      {label}
    </Label>
  );
}

function WorkerRow({ worker }: { worker: WorkerInfo }) {
  const totalUsed = worker.devices.reduce((sum, d) => sum + d.memoryUsedBytes, 0);
  const totalCapacity = worker.devices.reduce((sum, d) => sum + d.memoryTotalBytes, 0);
  const deviceCount = worker.devices.length;

  return (
    <Tr>
      <Td dataLabel="Worker ID">
        <Link to={`/workers/${encodeURIComponent(worker.workerId)}`}>{worker.workerId}</Link>
      </Td>
      <Td dataLabel="Status">
        <WorkerStatusLabel status={worker.status} />
      </Td>
      <Td dataLabel="Devices">
        {deviceCount > 0 ? `${deviceCount} GPU${deviceCount !== 1 ? 's' : ''}` : '—'}
      </Td>
      <Td dataLabel="Memory Used">{formatBytes(totalUsed)}</Td>
      <Td dataLabel="Memory Total">{formatBytes(totalCapacity)}</Td>
      <Td dataLabel="Models">
        {worker.modelCount != null ? worker.modelCount : '—'}
      </Td>
      <Td dataLabel="Last Heartbeat">{formatRelativeTime(worker.lastHeartbeatAt)}</Td>
    </Tr>
  );
}

export function WorkerList() {
  const { data: workers, isLoading, error } = useWorkers();

  if (isLoading) {
    return (
      <PageSection>
        <Flex justifyContent={{ default: 'justifyContentCenter' }}>
          <FlexItem>
            <Spinner size="xl" aria-label="Loading workers" />
          </FlexItem>
        </Flex>
      </PageSection>
    );
  }

  if (error) {
    return (
      <PageSection>
        <Alert variant="danger" title="Failed to load workers" isInline>
          <Content>
            {error instanceof Error ? error.message : 'An unexpected error occurred.'}
          </Content>
        </Alert>
      </PageSection>
    );
  }

  const isEmpty = !workers || workers.length === 0;

  return (
    <PageSection>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--pf-t--global--spacer--lg)',
        }}
      >
        <Content>
          <Title headingLevel="h1" size="2xl">
            Workers
          </Title>
        </Content>

        {isEmpty ? (
          <EmptyState headingLevel="h2" icon={ServerIcon} titleText="No workers registered">
            <EmptyStateBody>
              Workers appear here once they connect and register with the control plane.
            </EmptyStateBody>
          </EmptyState>
        ) : (
          <Table aria-label="Worker list" variant="compact">
            <Thead>
              <Tr>
                <Th>Worker ID</Th>
                <Th>Status</Th>
                <Th>Devices</Th>
                <Th>Memory Used</Th>
                <Th>Memory Total</Th>
                <Th>Models</Th>
                <Th>Last Heartbeat</Th>
              </Tr>
            </Thead>
            <Tbody>
              {workers.map((worker) => (
                <WorkerRow key={worker.workerId} worker={worker} />
              ))}
            </Tbody>
          </Table>
        )}
      </div>
    </PageSection>
  );
}
