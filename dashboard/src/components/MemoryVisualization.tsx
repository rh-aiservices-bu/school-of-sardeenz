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
  Tooltip,
} from '@patternfly/react-core';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { type ControlPlaneComponents } from '@sardeenz/types';
import { useClusterMemory } from '../hooks/useCluster';
import { formatBytes, formatPercentage } from '../utils/format';

type ClusterMemory = ControlPlaneComponents['schemas']['ClusterMemory'];
type DeviceInfo = ControlPlaneComponents['schemas']['DeviceInfo'];
type WorkerModelInfo = ControlPlaneComponents['schemas']['WorkerModelInfo'];

type DisplayMode = 'bytes' | 'percent';

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
// Single device bar (with tooltips + click-to-expand)
// ---------------------------------------------------------------------------
interface DeviceBarProps {
  device: DeviceInfo;
  displayMode: DisplayMode;
  models?: WorkerModelInfo[];
}

function DeviceBar({ device, displayMode, models }: DeviceBarProps) {
  const { t } = useTranslation('cluster');
  const [expanded, setExpanded] = useState(false);
  const {
    deviceIndex,
    deviceType,
    memoryTotalBytes,
    memoryUsedBytes,
    memoryAvailableBytes,
    memoryReservedBytes,
  } = device;

  const total = memoryTotalBytes > 0 ? memoryTotalBytes : 1;
  const usedPercent = Math.min(100, (memoryUsedBytes / total) * 100);
  const reservedPercent = Math.min(100 - usedPercent, ((memoryReservedBytes ?? 0) / total) * 100);
  const availablePercent = Math.max(0, 100 - usedPercent - reservedPercent);

  const usedPct = Math.round(usedPercent);
  const reservedPct = Math.round(reservedPercent);
  const availablePct = Math.max(0, 100 - usedPct - reservedPct);

  const usedTooltip = `${t('overview.vramAllocation.legend.used')}: ${formatBytes(memoryUsedBytes)} (${usedPct}%)`;
  const reservedTooltip =
    (memoryReservedBytes ?? 0) > 0
      ? `${t('overview.vramAllocation.legend.reserved')}: ${formatBytes(memoryReservedBytes)} (${reservedPct}%)`
      : '';
  const availableTooltip = `${t('overview.vramAllocation.legend.available')}: ${formatBytes(memoryAvailableBytes)} (${availablePct}%)`;

  const modelTooltipLines = models?.map((m) => `${m.modelName} (${m.memoryUsedBytes != null ? formatBytes(m.memoryUsedBytes) : '—'})`);

  const fullTooltip = [
    usedTooltip,
    reservedTooltip,
    availableTooltip,
    ...(modelTooltipLines?.length ? ['', ...modelTooltipLines] : []),
  ]
    .filter(Boolean)
    .join(' | ');

  return (
    <div>
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

        {/* Stacked bar — clickable to expand, segmented tooltips */}
        <Tooltip content={fullTooltip}>
          <div
            style={{
              flex: 1,
              height: '24px',
              borderRadius: '4px',
              overflow: 'hidden',
              display: 'flex',
              background: 'var(--pf-t--global--background--color--secondary--default)',
              border: '1px solid var(--pf-t--global--border--color--default)',
              cursor: 'pointer',
            }}
            role="button"
            tabIndex={0}
            aria-label={t('overview.vramAllocation.clickToExpand', { device: `GPU ${deviceIndex}` })}
            aria-expanded={expanded}
            onClick={() => setExpanded((e) => !e)}
            onKeyDown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); setExpanded((e) => !e); } }}
          >
            {usedPercent > 0 && (
              <Tooltip content={usedTooltip}>
                <div
                  style={{
                    width: `${usedPercent}%`,
                    background: 'var(--pf-t--global--color--status--info--default)',
                    transition: 'width 0.3s ease',
                    height: '100%',
                  }}
                />
              </Tooltip>
            )}
            {reservedPercent > 0 && (
              <Tooltip content={reservedTooltip}>
                <div
                  style={{
                    width: `${reservedPercent}%`,
                    background: 'var(--pf-t--global--color--status--warning--default)',
                    transition: 'width 0.3s ease',
                    height: '100%',
                  }}
                />
              </Tooltip>
            )}
            {availablePercent > 0 && (
              <Tooltip content={availableTooltip}>
                <div
                  style={{
                    width: `${availablePercent}%`,
                    background: 'var(--pf-t--global--background--color--secondary--default)',
                    transition: 'width 0.3s ease',
                    height: '100%',
                  }}
                />
              </Tooltip>
            )}
          </div>
        </Tooltip>

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
          {displayMode === 'bytes' ? (
            <>
              <span style={{ fontWeight: 'var(--pf-t--global--font--weight--bold)' }}>
                {formatBytes(memoryUsedBytes)}
              </span>
              <span style={{ color: 'var(--pf-t--global--text--color--subtle)' }}>
                {' '}/ {formatBytes(memoryTotalBytes)}
              </span>
            </>
          ) : (
            <span style={{ fontWeight: 'var(--pf-t--global--font--weight--bold)' }}>
              {t('overview.vramAllocation.usedPercent', { value: formatPercentage(memoryUsedBytes, memoryTotalBytes) })}
            </span>
          )}
        </div>
      </div>

      {/* Expanded detail panel */}
      {expanded && (
        <div
          style={{
            marginTop: 'var(--pf-t--global--spacer--sm)',
            marginLeft: 'calc(11ch + var(--pf-t--global--spacer--md))',
            padding: 'var(--pf-t--global--spacer--sm) var(--pf-t--global--spacer--md)',
            background: 'var(--pf-t--global--background--color--secondary--default)',
            borderRadius: '4px',
            border: '1px solid var(--pf-t--global--border--color--default)',
            fontSize: 'var(--pf-t--global--font--size--sm)',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--pf-t--global--spacer--xs)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: 'var(--pf-t--global--color--status--info--default)', fontWeight: 'var(--pf-t--global--font--weight--bold)' }}>
                {t('overview.vramAllocation.legend.used')}
              </span>
              <span>{formatBytes(memoryUsedBytes)} ({usedPct}%)</span>
            </div>
            {(memoryReservedBytes ?? 0) > 0 && (
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--pf-t--global--color--status--warning--default)', fontWeight: 'var(--pf-t--global--font--weight--bold)' }}>
                  {t('overview.vramAllocation.legend.reserved')}
                </span>
                <span>{formatBytes(memoryReservedBytes)} ({reservedPct}%)</span>
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ fontWeight: 'var(--pf-t--global--font--weight--bold)' }}>
                {t('overview.vramAllocation.legend.available')}
              </span>
              <span>{formatBytes(memoryAvailableBytes)} ({availablePct}%)</span>
            </div>
            <div
              style={{
                borderTop: '1px solid var(--pf-t--global--border--color--default)',
                paddingTop: 'var(--pf-t--global--spacer--xs)',
                display: 'flex',
                justifyContent: 'space-between',
                fontWeight: 'var(--pf-t--global--font--weight--bold)',
              }}
            >
              <span>{t('overview.vramUsage.total')}</span>
              <span>{formatBytes(memoryTotalBytes)}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Single worker section
// ---------------------------------------------------------------------------
interface WorkerSectionProps {
  workerId: string;
  devices: DeviceInfo[];
  models?: WorkerModelInfo[];
  displayMode: DisplayMode;
}

function WorkerSection({ workerId, devices, models, displayMode }: WorkerSectionProps) {
  const { t } = useTranslation('cluster');

  const isSingleDevice = devices.length === 1;

  return (
    <div>
      {/* Worker header — links to worker detail page */}
      <div
        style={{
          marginBottom: 'var(--pf-t--global--spacer--sm)',
        }}
      >
        <Link
          to={`/workers/${encodeURIComponent(workerId)}`}
          style={{
            fontWeight: 'var(--pf-t--global--font--weight--bold)',
            fontSize: 'var(--pf-t--global--font--size--sm)',
            color: 'var(--pf-t--global--link--color--default)',
            textDecoration: 'none',
          }}
        >
          {workerId}
        </Link>

        {/* Worker-level model names */}
        {models && models.length > 0 && (
          <div
            style={{
              marginTop: '2px',
              display: 'flex',
              flexWrap: 'wrap',
              gap: 'var(--pf-t--global--spacer--xs)',
            }}
          >
            {models.map((model) => (
              <span
                key={model.modelName}
                style={{
                  fontSize: 'var(--pf-t--global--font--size--xs)',
                  color: 'var(--pf-t--global--text--color--subtle)',
                  background: 'var(--pf-t--global--background--color--secondary--default)',
                  border: '1px solid var(--pf-t--global--border--color--default)',
                  borderRadius: '4px',
                  padding: '0 var(--pf-t--global--spacer--xs)',
                  lineHeight: '1.6',
                }}
              >
                {model.modelName}
                <span style={{ margin: '0 2px' }}>&middot;</span>
                {model.state}
              </span>
            ))}
          </div>
        )}
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
            <DeviceBar
              key={device.deviceIndex}
              device={device}
              displayMode={displayMode}
              models={isSingleDevice ? models : undefined}
            />
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
            <Flex spaceItems={{ default: 'spaceItemsMd' }} alignItems={{ default: 'alignItemsCenter' }}>
              <FlexItem>
                <ToggleGroup aria-label={t('overview.vramAllocation.displayModeLabel')}>
                  <ToggleGroupItem
                    text={t('overview.vramAllocation.displayGiB')}
                    isSelected={displayMode === 'bytes'}
                    onChange={(_event, selected) => { if (selected) setDisplayMode('bytes'); }}
                    buttonId="display-mode-bytes"
                  />
                  <ToggleGroupItem
                    text={t('overview.vramAllocation.displayPercent')}
                    isSelected={displayMode === 'percent'}
                    onChange={(_event, selected) => { if (selected) setDisplayMode('percent'); }}
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
              <WorkerSection
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
