/**
 * ModelsPlacementPanel — v1 GpuMemoryPanel port (#163, measured-only doctrine round).
 *
 * Replaces the old ledger-based PlacementBoard/WorkerGpuSection/MemoryVisualization trio.
 * Renders every worker's GPUs as a v1-style card: a nivo stacked bar (per-model colored
 * segments + Other + Free), a model legend with colored dots and sleeping-moon icons, and a
 * GPU header showing device name/utilization/temperature when the worker reports them.
 *
 * Adapted for v2:
 *  - v1 fetched per-pod over N requests; v2's single `/api/cluster/memory` response already
 *    carries every worker, so one useClusterMemory() call replaces the whole per-pod fetch
 *    fan-out (fetchMemoryUsage/allPodsData in the v1 source).
 *  - v1 "pod" ≙ v2 "worker" — the collapsible NodeGroup concept is kept, now keyed by workerId.
 *  - Worker status comes from useWorkers() (ClusterMemory doesn't carry it) instead of v1's
 *    healthy/leader chips, which the v1 panel didn't actually have real data for either (see
 *    the source's own comment on `leaderPodId`).
 *  - KVCache mini-bar: activated (#165) — renders a Prealloc/Used/Free sub-bar per GPU when the
 *    worker reports a kvcached pool for that device (DeviceInfo.kvCache), v1 parity.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
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
} from '@patternfly/react-core';
import { CubesIcon, EllipsisVIcon, MoonIcon, ServerIcon } from '@patternfly/react-icons';
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
  summarizeWorkerVram,
  SLEEPING_PATTERN_DEFS,
  KVCACHE_COLORS,
} from '../utils/gpuMemoryPanel';

type DeviceInfo = ControlPlaneComponents['schemas']['DeviceInfo'];
type WorkerModelInfo = ControlPlaneComponents['schemas']['WorkerModelInfo'];
type MemoryWorker = ControlPlaneComponents['schemas']['ClusterMemory']['workers'][number];

// Auto-expand every worker group only when the cluster is small enough that "expand
// everything" is still a reasonable default (v1 adaptation — v1 had no multi-worker cap).
const AUTO_EXPAND_MAX_WORKERS = 2;

const REFRESH_OPTIONS: Array<{ value: number | null; labelKey: string }> = [
  { value: null, labelKey: 'none' },
  { value: 5000, labelKey: '5s' },
  { value: 15000, labelKey: '15s' },
  { value: 30000, labelKey: '30s' },
  { value: 60000, labelKey: '1m' },
];
const DEFAULT_REFRESH_MS = 5000;

// ---------------------------------------------------------------------------
// GpuCard — one device's stacked VRAM bar + legend
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
  const bar = useMemo(() => buildDeviceBarData(device, attributed), [device, attributed]);
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
  const modelRows = useMemo(
    () =>
      [...attributed].sort(
        (a, b) =>
          a.modelName.localeCompare(b.modelName) ||
          (a.instanceId ?? '').localeCompare(b.instanceId ?? ''),
      ),
    [attributed],
  );

  const header = device.deviceName ?? `GPU ${device.deviceIndex} · ${device.deviceType}`;
  const hasUtilOrTemp = device.utilizationPercent != null || device.temperatureC != null;

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

      {/* Models on this GPU */}
      <div
        style={{
          marginTop: 'var(--pf-t--global--spacer--xs)',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {modelRows.map((model, index) => {
          const hasInstance = Boolean(model.instanceId);
          const canSleep = model.state === ModelLifecycleState.ACTIVE;
          const canWake = model.state === ModelLifecycleState.SLEEPING;
          const canStop =
            model.state === ModelLifecycleState.ACTIVE ||
            model.state === ModelLifecycleState.SLEEPING ||
            model.state === ModelLifecycleState.ERROR;
          const isPending =
            (sleepInstance.isPending && sleepInstance.variables?.instanceId === model.instanceId) ||
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
                minHeight: '36px',
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--pf-t--global--spacer--xs)',
                borderBottom:
                  index < modelRows.length - 1
                    ? '1px solid var(--pf-t--global--border--color--default)'
                    : undefined,
              }}
            >
              <Link
                to={`/models/${encodeURIComponent(model.modelName)}`}
                aria-label={t('overview.modelsPlacement.legend.viewModel', {
                  model: model.displayName ?? model.modelName,
                })}
                style={{
                  fontSize: 'var(--pf-t--global--font--size--xs)',
                  flex: 1,
                  minWidth: 0,
                  opacity: model.sleeping ? 0.7 : 1,
                  textDecoration: 'none',
                  color: 'var(--pf-t--global--text--color--default)',
                }}
              >
                <span style={{ color: bar.colors[model.key] }}>●</span>{' '}
                {model.displayName ?? model.modelName}
                {model.sleeping && (
                  <MoonIcon
                    style={{
                      marginLeft: '3px',
                      fontSize: '10px',
                      color: 'var(--pf-t--global--text--color--subtle)',
                    }}
                  />
                )}{' '}
                ({formatBytes(model.bytes)})
              </Link>
              {canMove && (
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
                          deviceIndices: models?.find(
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
              )}
            </div>
          );
        })}
      </div>

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

      <Flex
        flexWrap={{ default: 'wrap' }}
        style={{
          marginTop: '4px',
          columnGap: 'var(--pf-t--global--spacer--sm)',
          rowGap: '2px',
        }}
      >
        {bar.otherBytes > 0 && (
          <FlexItem>
            <span style={{ fontSize: 'var(--pf-t--global--font--size--xs)' }}>
              <span style={{ color: bar.colors['Other'] }}>●</span>{' '}
              {t('overview.modelsPlacement.legend.other')}
            </span>
          </FlexItem>
        )}
        <FlexItem>
          <span style={{ fontSize: 'var(--pf-t--global--font--size--xs)' }}>
            <span style={{ color: bar.colors['Free'] }}>●</span>{' '}
            {t('overview.modelsPlacement.legend.free', { value: formatBytes(bar.freeBytes) })}
          </span>
        </FlexItem>
      </Flex>

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
          <Flex gap={{ default: 'gapSm' }} style={{ marginTop: '2px' }}>
            <FlexItem>
              <span style={{ fontSize: 'var(--pf-t--global--font--size--xs)' }}>
                <span style={{ color: KVCACHE_COLORS.Prealloc }}>●</span> Prealloc (
                {formatBytes(kvcache.preallocBytes)})
              </span>
            </FlexItem>
            <FlexItem>
              <span style={{ fontSize: 'var(--pf-t--global--font--size--xs)' }}>
                <span style={{ color: KVCACHE_COLORS.Used }}>●</span> Used (
                {formatBytes(kvcache.usedBytes)})
              </span>
            </FlexItem>
            <FlexItem>
              <span style={{ fontSize: 'var(--pf-t--global--font--size--xs)' }}>
                <span style={{ color: KVCACHE_COLORS.Free }}>●</span> Free (
                {formatBytes(kvcache.freeBytes)})
              </span>
            </FlexItem>
          </Flex>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// WorkerSection — collapsible group header + GPU grid for one worker
// ---------------------------------------------------------------------------
function WorkerSection({
  worker,
  status,
  isExpanded,
  onToggle,
  onMove,
  canMove,
}: {
  worker: MemoryWorker;
  status?: WorkerStatus;
  isExpanded: boolean;
  onToggle: () => void;
  onMove: (source: MoveSource) => void;
  canMove: boolean;
}) {
  const { t } = useTranslation('cluster');
  const modelCount = worker.models?.length ?? 0;
  const { usedPercent } = summarizeWorkerVram(worker.devices);
  const statusColor = status ? getWorkerStatusColor(status) : undefined;
  const statusLabel = status ? status.charAt(0) + status.slice(1).toLowerCase() : null;

  return (
    <div style={{ marginBottom: 'var(--pf-t--global--spacer--sm)' }}>
      {/* Header */}
      <div
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') onToggle();
        }}
        role="button"
        tabIndex={0}
        aria-expanded={isExpanded}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--pf-t--global--spacer--sm)',
          padding: '8px 12px',
          background: 'var(--pf-t--global--background--color--secondary--default)',
          border: '1px solid var(--pf-t--global--border--color--default)',
          borderRadius: isExpanded ? '6px 6px 0 0' : '6px',
          cursor: 'pointer',
          userSelect: 'none',
        }}
      >
        <span
          style={{
            fontSize: '10px',
            color: 'var(--pf-t--global--text--color--subtle)',
            transition: 'transform 0.15s',
            transform: isExpanded ? 'rotate(0deg)' : 'rotate(-90deg)',
            width: '14px',
          }}
        >
          ▼
        </span>
        <ServerIcon style={{ color: 'var(--pf-t--global--text--color--subtle)' }} />
        <Link
          to={`/workers/${encodeURIComponent(worker.workerId)}`}
          onClick={(e) => e.stopPropagation()}
          style={{
            fontFamily: 'var(--pf-t--global--font--family--mono)',
            fontSize: 'var(--pf-t--global--font--size--sm)',
            fontWeight: 'var(--pf-t--global--font--weight--bold)',
            color: 'var(--pf-t--global--text--color--link--default)',
            textDecoration: 'none',
          }}
        >
          {worker.workerId}
        </Link>
        {statusLabel && (
          <Label color={statusColor} isCompact>
            {statusLabel}
          </Label>
        )}
        <span
          style={{
            color: 'var(--pf-t--global--text--color--subtle)',
            fontSize: 'var(--pf-t--global--font--size--xs)',
            marginLeft: 'auto',
          }}
        >
          {[
            t('overview.modelsPlacement.worker.gpuCount', { count: worker.devices.length }),
            t('overview.modelsPlacement.worker.modelCount', { count: modelCount }),
            t('overview.modelsPlacement.worker.vramPercent', { percent: usedPercent }),
          ].join(' · ')}
        </span>
      </div>

      {/* GPU grid */}
      {isExpanded && (
        <div
          style={{
            padding: 'var(--pf-t--global--spacer--sm)',
            border: '1px solid var(--pf-t--global--border--color--default)',
            borderTop: 'none',
            borderRadius: '0 0 6px 6px',
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
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
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Public component — "Models placement", used by both ClusterOverview and the GPU Memory page.
// ---------------------------------------------------------------------------
export function ModelsPlacementPanel() {
  const { t } = useTranslation('cluster');
  const [refreshInterval, setRefreshInterval] = useState<number | null>(DEFAULT_REFRESH_MS);
  const [isSelectOpen, setIsSelectOpen] = useState(false);
  const [expandedWorkers, setExpandedWorkers] = useState<Set<string>>(new Set());
  const hasAutoExpanded = useRef(false);
  const [moveSource, setMoveSource] = useState<MoveSource | null>(null);
  const { isAdmin } = useAuth();

  const { data: memory, isLoading, error } = useClusterMemory(refreshInterval ?? false);
  const { data: workers } = useWorkers();

  const statusByWorkerId = useMemo(() => {
    const map = new Map<string, WorkerStatus>();
    for (const w of workers ?? []) map.set(w.workerId, w.status);
    return map;
  }, [workers]);

  // Default expanded/collapsed is decided once, the first time data arrives — later refetches
  // must not clobber the user's manual toggles.
  useEffect(() => {
    if (hasAutoExpanded.current || !memory) return;
    hasAutoExpanded.current = true;
    if (memory.workers.length <= AUTO_EXPAND_MAX_WORKERS) {
      setExpandedWorkers(new Set(memory.workers.map((w) => w.workerId)));
    }
  }, [memory]);

  const toggleWorker = (workerId: string) => {
    setExpandedWorkers((prev) => {
      const next = new Set(prev);
      if (next.has(workerId)) next.delete(workerId);
      else next.add(workerId);
      return next;
    });
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

  return (
    <Card>
      <CardHeader actions={{ actions: refreshSelect }}>
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
          <>
            {memory.workers.map((worker) => (
              <WorkerSection
                key={worker.workerId}
                worker={worker}
                status={statusByWorkerId.get(worker.workerId)}
                isExpanded={expandedWorkers.has(worker.workerId)}
                onToggle={() => toggleWorker(worker.workerId)}
                onMove={setMoveSource}
                canMove={isAdmin}
              />
            ))}

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
          </>
        )}
        <MoveModelModal source={moveSource} onClose={() => setMoveSource(null)} />
      </CardBody>
    </Card>
  );
}
