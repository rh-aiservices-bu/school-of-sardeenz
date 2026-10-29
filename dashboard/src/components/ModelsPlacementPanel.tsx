/**
 * ModelsPlacementPanel — v1 GpuMemoryPanel port (#163, measured-only doctrine round).
 *
 * Replaces the old ledger-based PlacementBoard/WorkerGpuSection/MemoryVisualization trio.
 * Renders every worker's GPUs as a v1-style card: a nivo stacked bar (per-model colored
 * segments + Other + Free), a model chip row with colored dots and sleeping-moon icons, and a
 * GPU header showing device name/utilization/temperature when the worker reports them.
 *
 * Two views, switchable in the card header and persisted in localStorage:
 *  - "cards" (default): one card per worker placed side by side in a responsive grid. Since the
 *    fleet is one GPU per worker, each card renders its single GpuCard full width — the old
 *    per-worker collapsible section stacked full-width and left most of each row empty.
 *    Multi-GPU workers keep an inner auto-fill grid of GpuCards.
 *  - "compact": one row per worker (status label, worker link, inline CSS segment bar, summary,
 *    kebab). Actions aggregate: sleep all active / wake all sleeping / stop all. Per-model Move
 *    stays in the cards view, where the model a Move applies to is unambiguous.
 *
 * Other v2 adaptations (unchanged):
 *  - v1 fetched per-pod over N requests; v2's single `/api/cluster/memory` response already
 *    carries every worker, so one useClusterMemory() call replaces the whole per-pod fetch
 *    fan-out (fetchMemoryUsage/allPodsData in the v1 source).
 *  - v1 "pod" ≙ v2 "worker" — keyed by workerId.
 *  - Worker status comes from useWorkers() (ClusterMemory doesn't carry it).
 *  - KVCache mini-bar: activated (#165) — renders a Prealloc/Used/Free sub-bar per GPU when the
 *    worker reports a kvcached pool for that device (DeviceInfo.kvCache), v1 parity.
 */
import { createContext, useContext, useMemo, useState } from 'react';
import {
  Card,
  CardHeader,
  CardBody,
  CardTitle,
  EmptyState,
  EmptyStateBody,
  Flex,
  FlexItem,
  MenuToggle,
  type MenuToggleElement,
  Select,
  SelectOption,
  Spinner,
  Content,
  Alert,
  Label,
  Dropdown,
  DropdownItem,
  DropdownList,
  ToggleGroup,
  ToggleGroupItem,
  Tooltip,
} from '@patternfly/react-core';
import {
  BarsIcon,
  CubesIcon,
  EllipsisVIcon,
  MoonIcon,
  ServerIcon,
  ThLargeIcon,
} from '@patternfly/react-icons';
import { ResponsiveBar } from '@nivo/bar';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ModelLifecycleState, WorkerStatus, type ControlPlaneComponents } from '@sardeenz/types';
import { useClusterMemory } from '../hooks/useCluster';
import { useWorkers } from '../hooks/useWorkers';
import { formatBytes } from '../utils/format';
import { getWorkerStatusColor } from '../utils/state-colors';
import { getNivoTooltipTheme } from '../chartTheme';
import { useAuth } from '../contexts/AuthContext';
import { useDeleteInstance, useSleepInstance, useWakeInstance } from '../hooks/useModels';
import { MoveModelModal, type MoveSource } from './MoveModelModal';
import {
  attributeModelsToDevice,
  buildDeviceBarData,
  buildKvcacheData,
  buildWorkerBarData,
  summarizeWorkerVram,
  SLEEPING_PATTERN_DEFS,
  KVCACHE_COLORS,
  type WorkerBarSegment,
} from '../utils/gpuMemoryPanel';
import { assignModelColors, colorHexForModel, hexForColorIndex } from '../utils/memorySegments';

/**
 * Panel-wide model → color lookup. Computed once from every model in the cluster memory report
 * so co-displayed models never share a color and the same model is the same color everywhere
 * (both views).
 */
const ModelColorContext = createContext<(modelName: string) => string>(colorHexForModel);

type DeviceInfo = ControlPlaneComponents['schemas']['DeviceInfo'];
type WorkerModelInfo = ControlPlaneComponents['schemas']['WorkerModelInfo'];
type MemoryWorker = ControlPlaneComponents['schemas']['ClusterMemory']['workers'][number];

/** Which presentation the panel renders; persisted so a refresh keeps the chosen view. */
type PlacementView = 'cards' | 'compact';

const VIEW_STORAGE_KEY = 'sardeenz-placement-view';

function readStoredView(): PlacementView {
  try {
    return localStorage.getItem(VIEW_STORAGE_KEY) === 'compact' ? 'compact' : 'cards';
  } catch {
    return 'cards';
  }
}

const REFRESH_OPTIONS = [
  { value: null, labelKey: 'none' },
  { value: 5000, labelKey: '5s' },
  { value: 15000, labelKey: '15s' },
  { value: 30000, labelKey: '30s' },
  { value: 60000, labelKey: '1m' },
] as const;
const DEFAULT_REFRESH_MS = 5000;

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

/** Moon icon marking a sleeping model (v1 signature). */
function SleepingMoon() {
  return (
    <MoonIcon
      style={{
        marginLeft: '3px',
        fontSize: '10px',
        color: 'var(--pf-t--global--text--color--subtle)',
      }}
    />
  );
}

/** Pure-CSS stacked VRAM strip for the compact view — no chart library for a 10px bar. */
function WorkerInlineBar({
  segments,
  otherBytes,
  freeBytes,
}: {
  segments: WorkerBarSegment[];
  otherBytes: number;
  freeBytes: number;
}) {
  const total = segments.reduce((sum, s) => sum + s.bytes, 0) + otherBytes + freeBytes;
  if (total <= 0) return null;
  const pct = (bytes: number) => `${(bytes / total) * 100}%`;
  return (
    <div
      style={{
        display: 'flex',
        width: '100%',
        height: '10px',
        borderRadius: '3px',
        overflow: 'hidden',
        background: 'var(--pf-t--global--background--color--secondary--default)',
      }}
    >
      {segments.map((segment) => (
        <div
          key={segment.key}
          style={{
            width: pct(segment.bytes),
            background: segment.color,
            opacity: segment.sleeping ? 0.55 : 1,
          }}
        />
      ))}
      {otherBytes > 0 && (
        <div style={{ width: pct(otherBytes), background: '#8B8D8F' }} />
      )}
      {freeBytes > 0 && <div style={{ width: pct(freeBytes), background: '#D2D2D2' }} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// GpuCard — one device's stacked VRAM bar + model chip row
// ---------------------------------------------------------------------------

function GpuCard({
  device,
  workerDeviceCount,
  models,
  onMove,
  canMove,
}: {
  device: DeviceInfo;
  workerDeviceCount: number;
  models: WorkerModelInfo[] | undefined;
  onMove: (source: MoveSource) => void;
  canMove: boolean;
}) {
  const { t } = useTranslation('cluster');
  const navigate = useNavigate();
  const sleepInstance = useSleepInstance();
  const wakeInstance = useWakeInstance();
  const stopInstance = useDeleteInstance();
  const [openMenuKey, setOpenMenuKey] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const attributed = useMemo(
    () => attributeModelsToDevice(device, workerDeviceCount, models),
    [device, workerDeviceCount, models],
  );
  const colorFor = useContext(ModelColorContext);
  const bar = useMemo(
    () => buildDeviceBarData(device, attributed, colorFor),
    [device, attributed, colorFor],
  );
  const kvcache = useMemo(
    () => buildKvcacheData(device, (models?.length ?? 0) > 0),
    [device, models],
  );
  const usedPercent =
    device.memoryTotalBytes > 0
      ? Math.round((device.memoryUsedBytes / device.memoryTotalBytes) * 100)
      : 0;

  const keyToModel = useMemo(() => {
    const map = new Map<string, (typeof bar.entries)[number]>();
    for (const entry of bar.entries) map.set(entry.key, entry);
    return map;
  }, [bar.entries]);

  // Every model with an instance — ERROR/STARTING models carry no NVML bytes (measured-only
  // doctrine) but must still get action rows (Stop an ERROR instance).
  const actionModels = useMemo(() => {
    const withBytes = new Set(bar.entries.map((entry) => entry.key));
    const extra = (models ?? []).filter((model) => {
      const key = model.instanceId ? `${model.modelName}#${model.instanceId}` : model.modelName;
      return model.instanceId && !withBytes.has(key);
    });
    return [
      ...bar.entries,
      ...extra.map((model) => ({
        key: `${model.modelName}#${model.instanceId}`,
        modelName: model.modelName,
        displayName: model.displayName,
        instanceId: model.instanceId,
        state: model.state,
        bytes: 0,
        sleeping: model.state === ModelLifecycleState.SLEEPING,
      })),
    ].sort(
      (a, b) =>
        b.bytes - a.bytes ||
        a.modelName.localeCompare(b.modelName) ||
        (a.instanceId ?? '').localeCompare(b.instanceId ?? ''),
    );
  }, [bar.entries, models]);

  // Chips render measured models only; action rows render every model with an instance.
  const modelChips = useMemo(
    () =>
      [...bar.entries].sort(
        (a, b) =>
          b.bytes - a.bytes ||
          a.modelName.localeCompare(b.modelName) ||
          (a.instanceId ?? '').localeCompare(b.instanceId ?? ''),
      ),
    [bar.entries],
  );

  const header = device.deviceName ?? `GPU ${device.deviceIndex} · ${device.deviceType}`;
  const hasUtilOrTemp = device.utilizationPercent != null || device.temperatureC != null;

  // Legend details moved into a hover tooltip (#206): the card previously spent three rows
  // restating what the segments and tooltips already show.
  const legendTooltip = (
    <div>
      <div style={{ fontWeight: 'bold', marginBottom: '4px' }}>
        {t('overview.modelsPlacement.legend.segments')}
      </div>
      {modelChips.map((model) => (
        <div key={model.key}>
          <span style={{ color: bar.colors[model.key] }}>●</span>{' '}
          {model.displayName ?? model.modelName}
          {model.sleeping && ' ☾'} — {formatBytes(model.bytes)}
        </div>
      ))}
      {bar.otherBytes > 0 && (
        <div>
          <span style={{ color: bar.colors['Other'] }}>●</span>{' '}
          {t('overview.modelsPlacement.legend.other')} — {formatBytes(bar.otherBytes)}
        </div>
      )}
      <div>
        <span style={{ color: bar.colors['Free'] }}>●</span>{' '}
        {t('overview.modelsPlacement.legend.free', { value: formatBytes(bar.freeBytes) })}
      </div>
      {kvcache && (
        <div style={{ marginTop: '4px' }}>
          {t('overview.modelsPlacement.gpu.kvCacheLine', {
            used: formatBytes(kvcache.usedBytes),
            total: formatBytes(kvcache.totalBytes),
          })}
        </div>
      )}
    </div>
  );

  return (
    <div
      style={{
        border: '1px solid var(--pf-t--global--border--color--default)',
        borderRadius: '6px',
        padding: '10px 12px',
        background: 'var(--pf-t--global--background--color--primary--default)',
      }}
    >
      {/* Header */}
      <Flex
        justifyContent={{ default: 'justifyContentSpaceBetween' }}
        alignItems={{ default: 'alignItemsCenter' }}
      >
        <FlexItem>
          <span
            style={{
              fontSize: 'var(--pf-t--global--font--size--sm)',
              fontWeight: 'var(--pf-t--global--font--weight--bold)',
            }}
          >
            {header}
          </span>
        </FlexItem>
        {hasUtilOrTemp && (
          <FlexItem>
            <span
              style={{
                fontSize: 'var(--pf-t--global--font--size--xs)',
                color: 'var(--pf-t--global--text--color--subtle)',
              }}
            >
              {t('overview.modelsPlacement.gpu.utilTemp', {
                util: device.utilizationPercent ?? '—',
                temp: device.temperatureC ?? '—',
              })}
            </span>
          </FlexItem>
        )}
      </Flex>

      {/* VRAM info */}
      <div
        style={{
          fontSize: 'var(--pf-t--global--font--size--xs)',
          color: 'var(--pf-t--global--text--color--subtle)',
          margin: '4px 0',
        }}
      >
        {t('overview.modelsPlacement.gpu.vramLine', {
          used: formatBytes(device.memoryUsedBytes),
          total: formatBytes(device.memoryTotalBytes),
          percent: usedPercent,
        })}
      </div>

      {/* Stacked VRAM bar */}
      <div style={{ height: '24px' }}>
        <ResponsiveBar
          data={bar.data}
          keys={bar.keys}
          indexBy="id"
          layout="horizontal"
          margin={{ top: 0, right: 0, bottom: 0, left: 0 }}
          padding={0}
          valueFormat={formatBytes}
          colors={(datum) => bar.colors[datum.id as string] || '#ccc'}
          defs={SLEEPING_PATTERN_DEFS}
          fill={bar.fill}
          borderRadius={4}
          enableLabel={false}
          enableGridY={false}
          enableGridX={false}
          axisTop={null}
          axisRight={null}
          axisBottom={null}
          axisLeft={null}
          theme={getNivoTooltipTheme()}
          onClick={(datum) => {
            const model = keyToModel.get(datum.id as string);
            if (model) void navigate(`/models/${encodeURIComponent(model.modelName)}`);
          }}
        />
      </div>

      {/* Model chips + Other/Free — details in the hover tooltip */}
      <Tooltip content={legendTooltip}>
        <Flex
          flexWrap={{ default: 'wrap' }}
          alignItems={{ default: 'alignItemsCenter' }}
          style={{
            marginTop: '6px',
            columnGap: 'var(--pf-t--global--spacer--sm)',
            rowGap: '2px',
          }}
        >
          {modelChips.map((model) => (
            <FlexItem key={model.key}>
              <Link
                to={`/models/${encodeURIComponent(model.modelName)}`}
                aria-label={t('overview.modelsPlacement.legend.viewModel', {
                  model: model.displayName ?? model.modelName,
                })}
                style={{
                  fontSize: 'var(--pf-t--global--font--size--xs)',
                  whiteSpace: 'nowrap',
                  opacity: model.sleeping ? 0.7 : 1,
                  textDecoration: 'none',
                  color: 'var(--pf-t--global--text--color--default)',
                }}
              >
                <span style={{ color: bar.colors[model.key] }}>●</span>{' '}
                {model.displayName ?? model.modelName}
                {model.sleeping && <SleepingMoon />} ({formatBytes(model.bytes)})
              </Link>
            </FlexItem>
          ))}
          {bar.otherBytes > 0 && (
            <FlexItem>
              <span
                style={{
                  fontSize: 'var(--pf-t--global--font--size--xs)',
                  whiteSpace: 'nowrap',
                }}
              >
                <span style={{ color: bar.colors['Other'] }}>●</span>{' '}
                {t('overview.modelsPlacement.legend.other')} (
                {formatBytes(bar.otherBytes)})
              </span>
            </FlexItem>
          )}
          <FlexItem>
            <span
              style={{ fontSize: 'var(--pf-t--global--font--size--xs)', whiteSpace: 'nowrap' }}
            >
              <span style={{ color: bar.colors['Free'] }}>●</span>{' '}
              {t('overview.modelsPlacement.legend.free', {
                value: formatBytes(bar.freeBytes),
              })}
            </span>
          </FlexItem>
        </Flex>
      </Tooltip>

      {/* Per-model actions — kept as the one place with a per-model Move */}
      {canMove && actionModels.some((model) => model.instanceId) && (
        <div
          style={{
            marginTop: '4px',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          {actionModels.map((model) => {
            const hasInstance = Boolean(model.instanceId);
            const canSleep = model.state === ModelLifecycleState.ACTIVE;
            const canWake = model.state === ModelLifecycleState.SLEEPING;
            const canStop =
              model.state === ModelLifecycleState.ACTIVE ||
              model.state === ModelLifecycleState.SLEEPING ||
              model.state === ModelLifecycleState.ERROR;
            const isPending =
              (sleepInstance.isPending &&
                sleepInstance.variables?.instanceId === model.instanceId) ||
              (wakeInstance.isPending && wakeInstance.variables?.instanceId === model.instanceId) ||
              (stopInstance.isPending && stopInstance.variables?.instanceId === model.instanceId);

            const mutateInstance = (action: 'sleep' | 'wake' | 'stop') => {
              if (!model.instanceId) return;
              setOpenMenuKey(null);
              setActionError(null);
              const variables = { modelName: model.modelName, instanceId: model.instanceId };
              const mutation =
                action === 'sleep' ? sleepInstance : action === 'wake' ? wakeInstance : stopInstance;
              mutation.mutate(variables, {
                onError: (error) =>
                  setActionError(
                    error instanceof Error
                      ? error.message
                      : t('overview.modelsPlacement.actions.failed'),
                  ),
              });
            };

            return (
              <div
                key={model.key}
                style={{
                  minHeight: '28px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--pf-t--global--spacer--xs)',
                }}
              >
                <span
                  style={{
                    fontSize: 'var(--pf-t--global--font--size--xs)',
                    flex: 1,
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    opacity: model.sleeping ? 0.7 : 1,
                  }}
                >
                  <span style={{ color: bar.colors[model.key] }}>●</span>{' '}
                  {model.displayName ?? model.modelName}
                  {model.sleeping && <SleepingMoon />} ({formatBytes(model.bytes)})
                </span>
                <Dropdown
                  isOpen={openMenuKey === model.key}
                  onSelect={() => setOpenMenuKey(null)}
                  onOpenChange={(isOpen) => {
                    if (!isOpen) setOpenMenuKey(null);
                  }}
                  toggle={(toggleRef) => (
                    <MenuToggle
                      ref={toggleRef}
                      variant="plain"
                      isExpanded={openMenuKey === model.key}
                      isDisabled={!hasInstance || isPending}
                      aria-label={t('overview.modelsPlacement.actions.ariaLabel', {
                        model: model.displayName ?? model.modelName,
                      })}
                      onClick={() => setOpenMenuKey(openMenuKey === model.key ? null : model.key)}
                    >
                      <EllipsisVIcon />
                    </MenuToggle>
                  )}
                  popperProps={{ position: 'right' }}
                >
                  <DropdownList>
                    <DropdownItem
                      key={canWake ? 'wake' : 'sleep'}
                      isDisabled={!hasInstance || (!canSleep && !canWake)}
                      onClick={() => mutateInstance(canWake ? 'wake' : 'sleep')}
                    >
                      {t(
                        canWake
                          ? 'overview.modelsPlacement.actions.wake'
                          : 'overview.modelsPlacement.actions.sleep',
                      )}
                    </DropdownItem>
                    <DropdownItem
                      key="move"
                      isDisabled={!hasInstance || model.state !== ModelLifecycleState.ACTIVE}
                      onClick={() => {
                        if (!model.instanceId || model.state !== ModelLifecycleState.ACTIVE) return;
                        setOpenMenuKey(null);
                        onMove({
                          modelName: model.modelName,
                          instanceId: model.instanceId,
                          workerId: '',
                          deviceIndices:
                            models?.find(
                              (candidate) => candidate.instanceId === model.instanceId,
                            )?.deviceIndices ?? [device.deviceIndex],
                        });
                      }}
                    >
                      {t('overview.modelsPlacement.actions.move')}
                    </DropdownItem>
                    <DropdownItem
                      key="stop"
                      isDanger
                      isDisabled={!hasInstance || !canStop}
                      onClick={() => mutateInstance('stop')}
                    >
                      {t('overview.modelsPlacement.actions.stop')}
                    </DropdownItem>
                  </DropdownList>
                </Dropdown>
              </div>
            );
          })}
        </div>
      )}

      {actionError && (
        <Alert
          variant="danger"
          isInline
          isPlain
          title={t('overview.modelsPlacement.actions.failed')}
          style={{ marginTop: 'var(--pf-t--global--spacer--xs)' }}
        >
          {actionError}
        </Alert>
      )}

      {/*
        KVCache mini-bar (issue #165, v1 parity): renders when the worker reports a kvcached
        pool for this device (DeviceInfo.kvCache) and the worker has models — otherwise omitted
        entirely, exactly like the device stats above (absent means absent, not an empty bar).
      */}
      {kvcache && (
        <div
          style={{
            marginTop: '6px',
            paddingTop: '6px',
            borderTop: '1px solid var(--pf-t--global--border--color--default)',
          }}
        >
          <div
            style={{
              fontSize: 'var(--pf-t--global--font--size--xs)',
              color: 'var(--pf-t--global--text--color--subtle)',
              marginBottom: '2px',
            }}
          >
            {t('overview.modelsPlacement.gpu.kvCacheLine', {
              used: formatBytes(kvcache.usedBytes),
              total: formatBytes(kvcache.totalBytes),
            })}
          </div>
          <div style={{ height: '12px' }}>
            <ResponsiveBar
              data={kvcache.data}
              keys={kvcache.keys}
              indexBy="id"
              layout="horizontal"
              margin={{ top: 0, right: 0, bottom: 0, left: 0 }}
              padding={0}
              valueFormat={formatBytes}
              colors={(bar) => KVCACHE_COLORS[bar.id as keyof typeof KVCACHE_COLORS] || '#ccc'}
              borderRadius={3}
              enableLabel={false}
              enableGridY={false}
              enableGridX={false}
              axisTop={null}
              axisRight={null}
              axisBottom={null}
              axisLeft={null}
              theme={getNivoTooltipTheme()}
            />
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// WorkerCard — one worker in the cards view: header + GPU card grid
// ---------------------------------------------------------------------------

function WorkerCard({
  worker,
  status,
  onMove,
  canMove,
}: {
  worker: MemoryWorker;
  status?: WorkerStatus;
  onMove: (source: MoveSource) => void;
  canMove: boolean;
}) {
  const { t } = useTranslation('cluster');
  const modelCount = worker.models?.length ?? 0;
  const { usedPercent } = summarizeWorkerVram(worker.devices);
  const statusColor = status ? getWorkerStatusColor(status) : undefined;
  const statusLabel = status ? status.charAt(0) + status.slice(1).toLowerCase() : null;

  return (
    <div>
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--pf-t--global--spacer--sm)',
          padding: '8px 12px',
          background: 'var(--pf-t--global--background--color--secondary--default)',
          border: '1px solid var(--pf-t--global--border--color--default)',
          borderRadius: '6px 6px 0 0',
        }}
      >
        <ServerIcon style={{ color: 'var(--pf-t--global--text--color--subtle)' }} />
        <Link
          to={`/workers/${encodeURIComponent(worker.workerId)}`}
          style={{
            fontFamily: 'var(--pf-t--global--font--family--mono)',
            fontSize: 'var(--pf-t--global--font--size--sm)',
            fontWeight: 'var(--pf-t--global--font--weight--bold)',
            color: 'var(--pf-t--global--text--color--link--default)',
            textDecoration: 'none',
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {worker.workerId}
        </Link>
        {statusLabel && (
          <Label color={statusColor} isCompact>
            {statusLabel}
          </Label>
        )}
      </div>

      {/* GPU grid — one GPU per worker renders full width (the fleet norm); a multi-GPU
          worker keeps an auto-fill grid of per-GPU cards. */}
      <div
        style={{
          padding: 'var(--pf-t--global--spacer--sm)',
          border: '1px solid var(--pf-t--global--border--color--default)',
          borderTop: 'none',
          borderRadius: '0 0 6px 6px',
          display: 'grid',
          gridTemplateColumns:
            worker.devices.length === 1 ? '1fr' : 'repeat(auto-fill, minmax(300px, 1fr))',
          gap: 'var(--pf-t--global--spacer--sm)',
        }}
      >
        {worker.devices.map((device) => (
          <GpuCard
            key={device.deviceIndex}
            device={device}
            workerDeviceCount={worker.devices.length}
            models={worker.models}
            onMove={(source) => onMove({ ...source, workerId: worker.workerId })}
            canMove={canMove}
          />
        ))}
        {worker.devices.length === 0 && (
          <span
            style={{
              fontSize: 'var(--pf-t--global--font--size--xs)',
              color: 'var(--pf-t--global--text--color--subtle)',
            }}
          >
            {t('overview.modelsPlacement.empty.title')}
          </span>
        )}
      </div>

      {/* Summary — under the card so the header line stays single-line */}
      <div
        style={{
          marginTop: '2px',
          fontSize: 'var(--pf-t--global--font--size--xs)',
          color: 'var(--pf-t--global--text--color--subtle)',
        }}
      >
        {[
          t('overview.modelsPlacement.worker.gpuCount', { count: worker.devices.length }),
          t('overview.modelsPlacement.worker.modelCount', { count: modelCount }),
          t('overview.modelsPlacement.worker.vramPercent', { percent: usedPercent }),
        ].join(' · ')}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// WorkerRow — one worker in the compact view: single ~48px row + aggregate kebab
// ---------------------------------------------------------------------------

function WorkerRow({
  worker,
  status,
  colorFor,
}: {
  worker: MemoryWorker;
  status?: WorkerStatus;
  colorFor: (modelName: string) => string;
}) {
  const { t } = useTranslation('cluster');
  const sleepInstance = useSleepInstance();
  const wakeInstance = useWakeInstance();
  const stopInstance = useDeleteInstance();
  const [openMenu, setOpenMenu] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const modelRows = worker.models ?? [];
  const modelCount = modelRows.length;
  const { usedPercent } = summarizeWorkerVram(worker.devices);
  const statusColor = status ? getWorkerStatusColor(status) : undefined;
  const statusLabel = status ? status.charAt(0) + status.slice(1).toLowerCase() : null;

  const bar = useMemo(
    () => buildWorkerBarData(worker.devices, worker.models, colorFor),
    [worker.devices, worker.models, colorFor],
  );

  const isPending = modelRows.some(
    (model) =>
      (sleepInstance.isPending && sleepInstance.variables?.instanceId === model.instanceId) ||
      (wakeInstance.isPending && wakeInstance.variables?.instanceId === model.instanceId) ||
      (stopInstance.isPending && stopInstance.variables?.instanceId === model.instanceId),
  );

  const targets = (action: 'sleep' | 'wake' | 'stop') =>
    modelRows.filter((model) => {
      if (!model.instanceId) return false;
      if (action === 'sleep') return model.state === ModelLifecycleState.ACTIVE;
      if (action === 'wake') return model.state === ModelLifecycleState.SLEEPING;
      return (
        model.state === ModelLifecycleState.ACTIVE ||
        model.state === ModelLifecycleState.SLEEPING ||
        model.state === ModelLifecycleState.ERROR
      );
    });

  const mutateWorker = (action: 'sleep' | 'wake' | 'stop') => {
    setOpenMenu(false);
    setActionError(null);
    const mutation =
      action === 'sleep' ? sleepInstance : action === 'wake' ? wakeInstance : stopInstance;
    for (const model of targets(action)) {
      mutation.mutate(
        { modelName: model.modelName, instanceId: model.instanceId! },
        {
          onError: (error) =>
            setActionError(
              error instanceof Error ? error.message : t('overview.modelsPlacement.actions.failed'),
            ),
        },
      );
    }
  };

  return (
    <div>
      <div
        style={{
          minHeight: '44px',
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--pf-t--global--spacer--sm)',
          padding: '6px 0',
          borderBottom: '1px solid var(--pf-t--global--border--color--default)',
        }}
      >
        {statusLabel && (
          <Label color={statusColor} isCompact>
            {statusLabel}
          </Label>
        )}
        <Link
          to={`/workers/${encodeURIComponent(worker.workerId)}`}
          style={{
            fontFamily: 'var(--pf-t--global--font--family--mono)',
            fontSize: 'var(--pf-t--global--font--size--sm)',
            fontWeight: 'var(--pf-t--global--font--weight--bold)',
            color: 'var(--pf-t--global--text--color--link--default)',
            textDecoration: 'none',
            flexShrink: 0,
          }}
        >
          {worker.workerId}
        </Link>
        <div style={{ flex: 1, minWidth: '120px' }}>
          <WorkerInlineBar
            segments={bar.segments}
            otherBytes={bar.otherBytes}
            freeBytes={bar.freeBytes}
          />
        </div>
        <span
          style={{
            color: 'var(--pf-t--global--text--color--subtle)',
            fontSize: 'var(--pf-t--global--font--size--xs)',
            whiteSpace: 'nowrap',
          }}
        >
          {[
            t('overview.modelsPlacement.worker.gpuCount', { count: worker.devices.length }),
            t('overview.modelsPlacement.worker.modelCount', { count: modelCount }),
            t('overview.modelsPlacement.worker.vramPercent', { percent: usedPercent }),
          ].join(' · ')}
        </span>
        <Dropdown
          isOpen={openMenu}
          onSelect={() => setOpenMenu(false)}
          onOpenChange={(isOpen) => {
            if (!isOpen) setOpenMenu(false);
          }}
          toggle={(toggleRef) => (
            <MenuToggle
              ref={toggleRef}
              variant="plain"
              isExpanded={openMenu}
              isDisabled={modelCount === 0 || isPending}
              aria-label={t('overview.modelsPlacement.row.ariaLabel', { worker: worker.workerId })}
              onClick={() => setOpenMenu(!openMenu)}
            >
              <EllipsisVIcon />
            </MenuToggle>
          )}
          popperProps={{ position: 'right' }}
        >
          <DropdownList>
            <DropdownItem
              key="sleep"
              isDisabled={targets('sleep').length === 0}
              onClick={() => mutateWorker('sleep')}
            >
              {t('overview.modelsPlacement.row.sleepAll')}
            </DropdownItem>
            <DropdownItem
              key="wake"
              isDisabled={targets('wake').length === 0}
              onClick={() => mutateWorker('wake')}
            >
              {t('overview.modelsPlacement.row.wakeAll')}
            </DropdownItem>
            <DropdownItem
              key="stop"
              isDanger
              isDisabled={targets('stop').length === 0}
              onClick={() => mutateWorker('stop')}
            >
              {t('overview.modelsPlacement.row.stopAll')}
            </DropdownItem>
          </DropdownList>
        </Dropdown>
      </div>
      {actionError && (
        <Alert
          variant="danger"
          isInline
          isPlain
          title={t('overview.modelsPlacement.actions.failed')}
        >
          {actionError}
        </Alert>
      )}
      {/*
        Kept out of the single-line row: raw used/total bytes are available on hover via the
        worker summary (vramPercent) and the worker detail page.
      */}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Public component — "Models placement", used by both ClusterOverview and the GPU Memory page.
// ---------------------------------------------------------------------------
export function ModelsPlacementPanel() {
  const { t } = useTranslation('cluster');
  const [view, setView] = useState<PlacementView>(readStoredView);
  const [refreshInterval, setRefreshInterval] = useState<number | null>(DEFAULT_REFRESH_MS);
  const [isSelectOpen, setIsSelectOpen] = useState(false);
  const [moveSource, setMoveSource] = useState<MoveSource | null>(null);
  const { isAdmin } = useAuth();

  const { data: memory, isLoading, error } = useClusterMemory(refreshInterval ?? false);
  const { data: workers } = useWorkers();

  const statusByWorkerId = useMemo(() => {
    const map = new Map<string, WorkerStatus>();
    for (const w of workers ?? []) map.set(w.workerId, w.status);
    return map;
  }, [workers]);

  // One collision-free color assignment for every model in the report (see ModelColorContext).
  const colorFor = useMemo(() => {
    const names = (memory?.workers ?? []).flatMap((w) => (w.models ?? []).map((m) => m.modelName));
    const assignment = assignModelColors(names);
    return (modelName: string) => {
      const index = assignment.get(modelName);
      return index === undefined ? colorHexForModel(modelName) : hexForColorIndex(index);
    };
  }, [memory]);

  const switchView = (next: PlacementView) => {
    setView(next);
    try {
      localStorage.setItem(VIEW_STORAGE_KEY, next);
    } catch {
      // storage unavailable (private mode, SSR) — session-only choice is fine
    }
  };

  const totals = useMemo(() => {
    const allDevices = (memory?.workers ?? []).flatMap((w) => w.devices);
    const freeBytes = allDevices.reduce(
      (sum, d) => sum + Math.max(0, d.memoryTotalBytes - d.memoryUsedBytes),
      0,
    );
    return { freeBytes, deviceCount: allDevices.length };
  }, [memory]);

  const selectedOption =
    REFRESH_OPTIONS.find((opt) => opt.value === refreshInterval) ?? REFRESH_OPTIONS[1];
  const selectedLabel = t(`overview.modelsPlacement.refresh.${selectedOption.labelKey}`);

  const refreshSelect = (
    <Select
      toggle={(toggleRef: React.Ref<MenuToggleElement>) => (
        <MenuToggle
          ref={toggleRef}
          onClick={() => setIsSelectOpen(!isSelectOpen)}
          isExpanded={isSelectOpen}
          aria-label={t('overview.modelsPlacement.refresh.ariaLabel')}
          style={{ minWidth: '100px' }}
        >
          {t('overview.modelsPlacement.refresh.toggleLabel', { label: selectedLabel })}
        </MenuToggle>
      )}
      onSelect={(_ev, value) => {
        setRefreshInterval(value === 'null' ? null : Number(value));
        setIsSelectOpen(false);
      }}
      selected={refreshInterval === null ? 'null' : String(refreshInterval)}
      isOpen={isSelectOpen}
      onOpenChange={setIsSelectOpen}
    >
      {REFRESH_OPTIONS.map((option) => (
        <SelectOption
          key={option.value === null ? 'null' : option.value}
          value={option.value === null ? 'null' : String(option.value)}
        >
          {t(`overview.modelsPlacement.refresh.${option.labelKey}`)}
        </SelectOption>
      ))}
    </Select>
  );

  const viewToggle = (
    <ToggleGroup aria-label={t('overview.modelsPlacement.view.ariaLabel')}>
      <Tooltip content={t('overview.modelsPlacement.view.cards')}>
        <ToggleGroupItem
          icon={<ThLargeIcon />}
          aria-label={t('overview.modelsPlacement.view.cards')}
          buttonId="placement-view-cards"
          isSelected={view === 'cards'}
          onChange={(_event, selected) => {
            if (selected) switchView('cards');
          }}
        />
      </Tooltip>
      <Tooltip content={t('overview.modelsPlacement.view.compact')}>
        <ToggleGroupItem
          icon={<BarsIcon />}
          aria-label={t('overview.modelsPlacement.view.compact')}
          buttonId="placement-view-compact"
          isSelected={view === 'compact'}
          onChange={(_event, selected) => {
            if (selected) switchView('compact');
          }}
        />
      </Tooltip>
    </ToggleGroup>
  );

  return (
    <Card>
      <CardHeader actions={{ actions: [viewToggle, refreshSelect] }}>
        <CardTitle>
          <Content component="h2">{t('overview.modelsPlacement.title')}</Content>
        </CardTitle>
      </CardHeader>
      <CardBody>
        {isLoading && !memory ? (
          <Flex justifyContent={{ default: 'justifyContentCenter' }}>
            <FlexItem>
              <Spinner size="lg" aria-label={t('overview.modelsPlacement.loading')} />
            </FlexItem>
          </Flex>
        ) : error && !memory ? (
          <Alert
            variant="warning"
            title={t('overview.modelsPlacement.errors.failedToLoad')}
            isInline
          >
            {error instanceof Error ? error.message : String(error)}
          </Alert>
        ) : !memory || memory.workers.length === 0 ? (
          <EmptyState
            headingLevel="h3"
            icon={CubesIcon}
            titleText={t('overview.modelsPlacement.empty.title')}
          >
            <EmptyStateBody>{t('overview.modelsPlacement.empty.body')}</EmptyStateBody>
          </EmptyState>
        ) : (
          <ModelColorContext.Provider value={colorFor}>
            {view === 'cards' ? (
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))',
                  gap: 'var(--pf-t--global--spacer--md)',
                  alignItems: 'start',
                }}
              >
                {memory.workers.map((worker) => (
                  <WorkerCard
                    key={worker.workerId}
                    worker={worker}
                    status={statusByWorkerId.get(worker.workerId)}
                    onMove={setMoveSource}
                    canMove={isAdmin}
                  />
                ))}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {memory.workers.map((worker) => (
                  <WorkerRow
                    key={worker.workerId}
                    worker={worker}
                    status={statusByWorkerId.get(worker.workerId)}
                    colorFor={colorFor}
                  />
                ))}
              </div>
            )}

            {totals.deviceCount > 1 && (
              <div
                style={{
                  marginTop: 'var(--pf-t--global--spacer--md)',
                  paddingTop: 'var(--pf-t--global--spacer--sm)',
                  borderTop: '1px solid var(--pf-t--global--border--color--default)',
                }}
              >
                <Content
                  component="small"
                  style={{ color: 'var(--pf-t--global--text--color--subtle)' }}
                >
                  {t('overview.modelsPlacement.totalFree', {
                    value: formatBytes(totals.freeBytes),
                    count: totals.deviceCount,
                  })}
                </Content>
              </div>
            )}
          </ModelColorContext.Provider>
        )}
        <MoveModelModal source={moveSource} onClose={() => setMoveSource(null)} />
      </CardBody>
    </Card>
  );
}
