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
import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation('workers');
  const totalUsed = worker.devices.reduce((sum, d) => sum + d.memoryUsedBytes, 0);
  const totalCapacity = worker.devices.reduce((sum, d) => sum + d.memoryTotalBytes, 0);
  const deviceCount = worker.devices.length;

  return (
    <Tr>
      <Td dataLabel={t('list.table.workerId')}>
        <Link to={`/workers/${encodeURIComponent(worker.workerId)}`}>{worker.workerId}</Link>
      </Td>
      <Td dataLabel={t('list.table.status')}>
        <WorkerStatusLabel status={worker.status} />
      </Td>
      <Td dataLabel={t('list.table.devices')}>
        {deviceCount > 0 ? `${deviceCount} GPU${deviceCount !== 1 ? 's' : ''}` : '—'}
      </Td>
      <Td dataLabel={t('list.table.memoryUsed')}>{formatBytes(totalUsed)}</Td>
      <Td dataLabel={t('list.table.memoryTotal')}>{formatBytes(totalCapacity)}</Td>
      <Td dataLabel={t('list.table.models')}>
        {worker.modelCount != null ? worker.modelCount : '—'}
      </Td>
      <Td dataLabel={t('list.table.lastHeartbeat')}>{formatRelativeTime(worker.lastHeartbeatAt)}</Td>
    </Tr>
  );
}

export function WorkerList() {
  const { t } = useTranslation('workers');
  const { t: tCommon } = useTranslation('common');
  const { data: workers, isLoading, error } = useWorkers();

  if (isLoading) {
    return (
      <PageSection>
        <Flex justifyContent={{ default: 'justifyContentCenter' }}>
          <FlexItem>
            <Spinner size="xl" aria-label={t('list.title')} />
          </FlexItem>
        </Flex>
      </PageSection>
    );
  }

  if (error) {
    return (
      <PageSection>
        <Alert variant="danger" title={t('list.errors.failedToLoad')} isInline>
          <Content>
            {error instanceof Error ? error.message : tCommon('errors.unexpected')}
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
            {t('list.title')}
          </Title>
        </Content>

        {isEmpty ? (
          <EmptyState headingLevel="h2" icon={ServerIcon} titleText={t('list.empty.title')}>
            <EmptyStateBody>
              {t('list.empty.body')}
            </EmptyStateBody>
          </EmptyState>
        ) : (
          <Table aria-label={t('list.title')} variant="compact">
            <Thead>
              <Tr>
                <Th>{t('list.table.workerId')}</Th>
                <Th>{t('list.table.status')}</Th>
                <Th>{t('list.table.devices')}</Th>
                <Th>{t('list.table.memoryUsed')}</Th>
                <Th>{t('list.table.memoryTotal')}</Th>
                <Th>{t('list.table.models')}</Th>
                <Th>{t('list.table.lastHeartbeat')}</Th>
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
