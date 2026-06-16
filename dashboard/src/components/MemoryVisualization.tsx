import {
  Card,
  CardBody,
  CardTitle,
  Flex,
  FlexItem,
  Spinner,
  Title,
} from '@patternfly/react-core';
import { useTranslation } from 'react-i18next';
import { type ControlPlaneComponents } from '@sardeenz/types';
import { useClusterMemory } from '../hooks/useCluster';
import { formatBytes } from '../utils/format';

type ClusterMemory = ControlPlaneComponents['schemas']['ClusterMemory'];
type DeviceInfo = ControlPlaneComponents['schemas']['DeviceInfo'];

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
            <span style={{ fontSize: 'var(--pf-t--global--font--size--sm)' }}>{t('overview.vramAllocation.legend.used')}</span>
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
            <span style={{ fontSize: 'var(--pf-t--global--font--size--sm)' }}>{t('overview.vramAllocation.legend.reserved')}</span>
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
            <span style={{ fontSize: 'var(--pf-t--global--font--size--sm)' }}>{t('overview.vramAllocation.legend.available')}</span>
          </FlexItem>
        </Flex>
      </FlexItem>
    </Flex>
  );
}

// ---------------------------------------------------------------------------
// Single device bar
// ---------------------------------------------------------------------------
interface DeviceBarProps {
  device: DeviceInfo;
}

function DeviceBar({ device }: DeviceBarProps) {
  const { t } = useTranslation('cluster');
  const { deviceIndex, deviceType, memoryTotalBytes, memoryUsedBytes, memoryAvailableBytes, memoryReservedBytes } =
    device;

  const total = memoryTotalBytes > 0 ? memoryTotalBytes : 1;
  const usedPercent = Math.min(100, (memoryUsedBytes / total) * 100);
  const reservedPercent = Math.min(100 - usedPercent, ((memoryReservedBytes ?? 0) / total) * 100);
  const availablePercent = Math.max(0, 100 - usedPercent - reservedPercent);

  const usedLabel = `${t('overview.vramAllocation.legend.used')}: ${formatBytes(memoryUsedBytes)}`;
  const reservedLabel =
    (memoryReservedBytes ?? 0) > 0
      ? ` | ${t('overview.vramAllocation.legend.reserved')}: ${formatBytes(memoryReservedBytes)}`
      : '';
  const availableLabel = ` | ${t('overview.vramAllocation.legend.available')}: ${formatBytes(memoryAvailableBytes)}`;
  const totalLabel = ` | ${t('overview.vramUsage.total')}: ${formatBytes(memoryTotalBytes)}`;
  const tooltipText = `${usedLabel}${reservedLabel}${availableLabel}${totalLabel}`;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--pf-t--global--spacer--md)',
      }}
    >
      {/* Device label */}
      <div
        style={{
          flexShrink: 0,
          width: '11ch',
          fontSize: 'var(--pf-t--global--font--size--sm)',
          color: 'var(--pf-t--global--text--color--subtle)',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
        title={`GPU ${deviceIndex} — ${deviceType}`}
      >
        GPU {deviceIndex}
        <span
          style={{
            fontSize: 'var(--pf-t--global--font--size--xs)',
            marginLeft: 'var(--pf-t--global--spacer--xs)',
            color: 'var(--pf-t--global--text--color--subtle)',
          }}
        >
          {deviceType}
        </span>
      </div>

      {/* Stacked bar */}
      <div
        style={{
          flex: 1,
          height: '24px',
          borderRadius: '4px',
          overflow: 'hidden',
          display: 'flex',
          background: 'var(--pf-t--global--background--color--secondary--default)',
          border: '1px solid var(--pf-t--global--border--color--default)',
        }}
        title={tooltipText}
        aria-label={tooltipText}
        role="img"
      >
        {usedPercent > 0 && (
          <div
            style={{
              width: `${usedPercent}%`,
              background: 'var(--pf-t--global--color--status--info--default)',
              transition: 'width 0.3s ease',
            }}
            title={usedLabel}
          />
        )}
        {reservedPercent > 0 && (
          <div
            style={{
              width: `${reservedPercent}%`,
              background: 'var(--pf-t--global--color--status--warning--default)',
              transition: 'width 0.3s ease',
            }}
            title={`${t('overview.vramAllocation.legend.reserved')}: ${formatBytes(memoryReservedBytes)}`}
          />
        )}
        {availablePercent > 0 && (
          <div
            style={{
              width: `${availablePercent}%`,
              background: 'var(--pf-t--global--background--color--secondary--default)',
              transition: 'width 0.3s ease',
            }}
            title={`${t('overview.vramAllocation.legend.available')}: ${formatBytes(memoryAvailableBytes)}`}
          />
        )}
      </div>

      {/* Memory value label */}
      <div
        style={{
          flexShrink: 0,
          fontSize: 'var(--pf-t--global--font--size--sm)',
          textAlign: 'right',
          whiteSpace: 'nowrap',
          minWidth: '13ch',
        }}
      >
        <span style={{ fontWeight: 'var(--pf-t--global--font--weight--bold)' }}>
          {formatBytes(memoryUsedBytes)}
        </span>
        <span style={{ color: 'var(--pf-t--global--text--color--subtle)' }}>
          {' '}/ {formatBytes(memoryTotalBytes)}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Single worker section
// ---------------------------------------------------------------------------
interface WorkerSectionProps {
  workerId: string;
  devices: DeviceInfo[];
}

function WorkerSection({ workerId, devices }: WorkerSectionProps) {
  const { t } = useTranslation('cluster');

  return (
    <div>
      {/* Worker header */}
      <div
        style={{
          fontWeight: 'var(--pf-t--global--font--weight--bold)',
          fontSize: 'var(--pf-t--global--font--size--sm)',
          marginBottom: 'var(--pf-t--global--spacer--sm)',
          color: 'var(--pf-t--global--text--color--default)',
        }}
      >
        {workerId}
      </div>

      {/* Device bars */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--pf-t--global--spacer--sm)',
        }}
      >
        {devices.length === 0 ? (
          <div
            style={{
              fontSize: 'var(--pf-t--global--font--size--sm)',
              color: 'var(--pf-t--global--text--color--subtle)',
            }}
          >
            {t('overview.vramAllocation.noDevices')}
          </div>
        ) : (
          devices.map((device) => (
            <DeviceBar key={device.deviceIndex} device={device} />
          ))
        )}
      </div>
    </div>
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

  // Prefer externally supplied data; fall back to fetched data.
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
            <Legend />
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
              <WorkerSection
                key={worker.workerId}
                workerId={worker.workerId}
                devices={worker.devices}
              />
            ))}
          </div>
        )}
      </CardBody>
    </Card>
  );
}
