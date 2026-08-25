import { useState } from 'react';
import { Tooltip } from '@patternfly/react-core';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { type ControlPlaneComponents } from '@sardeenz/types';
import { formatBytes, formatPercentage } from '../utils/format';
import {
  computeDeviceSegments,
  computeModelSegments,
  type AttributedModel,
  type MemorySegment,
} from '../utils/memorySegments';

type DeviceInfo = ControlPlaneComponents['schemas']['DeviceInfo'];
type WorkerModelInfo = ControlPlaneComponents['schemas']['WorkerModelInfo'];

export type DisplayMode = 'bytes' | 'percent';

const SLEEPING_HATCH_BACKGROUND =
  'repeating-linear-gradient(-45deg, transparent 0 4px, var(--pf-t--global--color--nonstatus--gray--300) 4px 6px)';

function segmentLabel(
  t: (key: string, opts?: Record<string, unknown>) => string,
  seg: MemorySegment,
): string {
  if (seg.kind === 'model') {
    const memory = formatBytes(seg.bytes);
    if (seg.sleeping) {
      return t('overview.vramAllocation.tooltip.sleeping', { model: seg.modelName, memory });
    }
    if (seg.isEstimate) {
      return t('overview.vramAllocation.tooltip.modelEstimate', { model: seg.modelName, memory });
    }
    return t('overview.vramAllocation.tooltip.model', { model: seg.modelName, memory });
  }
  const legendKey =
    seg.kind === 'other'
      ? 'other'
      : seg.kind === 'reserved'
        ? 'reserved'
        : seg.kind === 'used'
          ? 'used'
          : 'available';
  return `${t(`overview.vramAllocation.legend.${legendKey}`)}: ${formatBytes(seg.bytes)}`;
}

// ---------------------------------------------------------------------------
// Single device bar (with tooltips + click-to-expand) — generalized DeviceBar
// ---------------------------------------------------------------------------
interface DeviceMemoryBarProps {
  device: DeviceInfo;
  displayMode: DisplayMode;
  models?: AttributedModel[];
}

export function DeviceMemoryBar({ device, displayMode, models }: DeviceMemoryBarProps) {
  const { t } = useTranslation('cluster');
  const [expanded, setExpanded] = useState(false);
  const {
    deviceIndex,
    deviceType,
    memoryTotalBytes,
    memoryUsedBytes,
    memoryReservedBytes,
    memoryMeasuredUsedBytes,
  } = device;

  // The stacked bar itself stays ledger-based (budgeting view); only the numeric readout
  // prefers the NVML-measured value when the worker reports one (#163).
  const hasMeasured = memoryMeasuredUsedBytes != null;
  const primaryUsedBytes = hasMeasured ? memoryMeasuredUsedBytes : memoryUsedBytes;
  const reserved = memoryReservedBytes ?? 0;

  const segments = models?.length
    ? computeModelSegments(device, models)
    : computeDeviceSegments(device);

  // Same source as the collapsed readout's percent (primaryUsedBytes) so the expanded
  // panel's "Total (X%)" row never disagrees with the number shown above it (#163 review).
  const usedPct = Math.round(
    Math.min(100, (primaryUsedBytes / Math.max(1, memoryTotalBytes)) * 100),
  );

  const summary = segments
    .filter((s) => s.widthPercent > 0)
    .map((s) => segmentLabel(t, s))
    .join(' | ');

  const ariaLabel = t('overview.vramAllocation.aria.deviceBreakdown', {
    index: deviceIndex,
    summary,
  });

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
          aria-label={ariaLabel}
          aria-expanded={expanded}
          onClick={() => setExpanded((e) => !e)}
          onKeyDown={(ev) => {
            if (ev.key === 'Enter' || ev.key === ' ') {
              ev.preventDefault();
              setExpanded((e) => !e);
            }
          }}
        >
          {segments.map(
            (seg) =>
              seg.widthPercent > 0 && (
                <Tooltip key={seg.key} content={segmentLabel(t, seg)}>
                  <div
                    style={{
                      width: `${seg.widthPercent}%`,
                      background: seg.colorToken,
                      backgroundImage: seg.sleeping ? SLEEPING_HATCH_BACKGROUND : undefined,
                      transition: 'width 0.3s ease',
                      height: '100%',
                    }}
                  />
                </Tooltip>
              ),
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
          {displayMode === 'bytes' ? (
            <>
              <span style={{ fontWeight: 'var(--pf-t--global--font--weight--bold)' }}>
                {formatBytes(primaryUsedBytes)}
              </span>
              <span style={{ color: 'var(--pf-t--global--text--color--subtle)' }}>
                {' '}
                / {formatBytes(memoryTotalBytes)}
              </span>
            </>
          ) : (
            <span style={{ fontWeight: 'var(--pf-t--global--font--weight--bold)' }}>
              {t('overview.vramAllocation.usedPercent', {
                value: formatPercentage(primaryUsedBytes, memoryTotalBytes),
              })}
            </span>
          )}
          {hasMeasured && (
            <div
              style={{
                fontSize: 'var(--pf-t--global--font--size--xs)',
                color: 'var(--pf-t--global--text--color--subtle)',
              }}
            >
              {t('overview.vramAllocation.measuredTag')}
            </div>
          )}
          {reserved > 0 && (
            <div
              style={{
                fontSize: 'var(--pf-t--global--font--size--xs)',
                color: 'var(--pf-t--global--text--color--subtle)',
              }}
            >
              {t('overview.vramAllocation.reservedInline', { value: formatBytes(reserved) })}
            </div>
          )}
        </div>
      </div>

      {/* The bar's fill stays ledger-based (#151 — per-model segments are estimates); when the
          readout above is measured, that's a different number than what's filled in below, so
          say so explicitly rather than leaving it looking like a mismatch. */}
      {hasMeasured && (
        <div
          style={{
            marginLeft: 'calc(11ch + var(--pf-t--global--spacer--md))',
            fontSize: 'var(--pf-t--global--font--size--xs)',
            color: 'var(--pf-t--global--text--color--subtle)',
            fontStyle: 'italic',
          }}
        >
          {t('overview.vramAllocation.barShowsAllocated')}
        </div>
      )}

      {/* Expanded detail panel — per-segment rows */}
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
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--pf-t--global--spacer--xs)',
            }}
          >
            {segments.map((seg) => (
              <div key={seg.key} style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 'var(--pf-t--global--spacer--xs)',
                    fontWeight: 'var(--pf-t--global--font--weight--bold)',
                  }}
                >
                  <span
                    aria-hidden="true"
                    style={{
                      display: 'inline-block',
                      flexShrink: 0,
                      width: '10px',
                      height: '10px',
                      borderRadius: '2px',
                      background: seg.colorToken,
                      border: '1px solid var(--pf-t--global--border--color--default)',
                    }}
                  />
                  {seg.kind === 'model'
                    ? seg.modelName
                    : t(
                        `overview.vramAllocation.legend.${seg.kind === 'other' ? 'other' : seg.kind}`,
                      )}
                  {seg.sleeping ? ` · ${t('overview.vramAllocation.legend.sleeping')}` : ''}
                  {seg.isEstimate ? ` (${t('overview.vramAllocation.tooltip.estimateNote')})` : ''}
                </span>
                <span>
                  {formatBytes(seg.bytes)} ({Math.round(seg.widthPercent)}%)
                </span>
              </div>
            ))}
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
              <span>
                {formatBytes(memoryTotalBytes)} ({usedPct}%)
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-worker GPU section — generalized WorkerSection, reusable by #124
// ---------------------------------------------------------------------------
export interface WorkerGpuSectionProps {
  workerId: string;
  devices: DeviceInfo[];
  models?: WorkerModelInfo[];
  displayMode: DisplayMode;
  /** default true; #124 may suppress and render its own header. */
  showHeader?: boolean;
  /** link target; default `/workers/${encodeURIComponent(workerId)}`. */
  headerTo?: string;
}

export function WorkerGpuSection({
  workerId,
  devices,
  models,
  displayMode,
  showHeader = true,
  headerTo,
}: WorkerGpuSectionProps) {
  const { t } = useTranslation('cluster');

  const isSingleDevice = devices.length === 1;
  const hasDeviceAttribution = models?.some((m) => m.deviceIndices);

  function attributedModelsFor(device: DeviceInfo): AttributedModel[] | undefined {
    const forDevice = hasDeviceAttribution
      ? models?.filter((m) => m.deviceIndices?.includes(device.deviceIndex))
      : isSingleDevice
        ? models
        : undefined;

    return forDevice?.map((m) => {
      const deviceCount = Math.max(1, m.deviceIndices?.length ?? 1);
      return {
        modelName: m.modelName,
        state: m.state,
        bytes: (m.memoryUsedBytes ?? 0) / deviceCount,
        isEstimate: deviceCount > 1,
      };
    });
  }

  return (
    <div>
      {/* Worker header — links to worker detail page */}
      {showHeader && (
        <div
          style={{
            marginBottom: 'var(--pf-t--global--spacer--sm)',
          }}
        >
          <Link
            to={headerTo ?? `/workers/${encodeURIComponent(workerId)}`}
            style={{
              fontWeight: 'var(--pf-t--global--font--weight--bold)',
              fontSize: 'var(--pf-t--global--font--size--sm)',
              color: 'var(--pf-t--global--text--color--link--default)',
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
              {models.map((model, i) => (
                <span
                  key={`${model.modelName}#${i}`}
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
      )}

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
            <DeviceMemoryBar
              key={device.deviceIndex}
              device={device}
              displayMode={displayMode}
              models={attributedModelsFor(device)}
            />
          ))
        )}
      </div>
    </div>
  );
}
