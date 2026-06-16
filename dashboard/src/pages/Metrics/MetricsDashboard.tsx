import { useMemo, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Content,
  DatePicker,
  EmptyState,
  EmptyStateBody,
  Grid,
  GridItem,
  HelperText,
  HelperTextItem,
  PageSection,
  Spinner,
  Split,
  SplitItem,
  Switch,
  TimePicker,
  ToggleGroup,
  ToggleGroupItem,
  Toolbar,
  ToolbarContent,
  ToolbarGroup,
  ToolbarItem,
} from '@patternfly/react-core';
import {
  Chart,
  ChartArea,
  ChartAxis,
  ChartGroup,
  ChartLine,
  ChartThemeColor,
  ChartVoronoiContainer,
} from '@patternfly/react-charts/victory';
import { ChartLineIcon } from '@patternfly/react-icons';
import {
  useLatencyMetrics,
  useThroughputMetrics,
  useMemoryMetrics,
  useConnectionMetrics,
  useParkingDuration,
  useWakeTriggers,
  useStateTransitions,
  useEvictions,
  useMemoryHistory,
  useOperationDurations,
  type TimeRange,
  type CustomRange,
} from '../../hooks/useMetrics';
import { useEventStream } from '../../hooks/useEventStream';
import { formatBytes } from '../../utils/format';

// ---------------------------------------------------------------------------
// Types for Prometheus responses
// ---------------------------------------------------------------------------

interface PrometheusRangeSeries {
  metric: Record<string, string>;
  values: Array<[number, string]>;
}

interface PrometheusRangeData {
  resultType: 'matrix';
  result: PrometheusRangeSeries[];
}

interface PrometheusRangeResult {
  status: string;
  data: PrometheusRangeData;
}

interface PrometheusInstantSeries {
  metric: Record<string, string>;
  value: [number, string];
}

interface PrometheusInstantData {
  resultType: 'vector';
  result: PrometheusInstantSeries[];
}

interface PrometheusInstantResult {
  status: string;
  data: PrometheusInstantData;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatHHMM(date: Date): string {
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
}

function isPrometheusRangeResult(value: unknown): value is PrometheusRangeResult {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v['status'] !== 'string') return false;
  const data = v['data'] as Record<string, unknown> | undefined;
  if (!data || data['resultType'] !== 'matrix') return false;
  return Array.isArray(data['result']);
}

function isPrometheusInstantResult(value: unknown): value is PrometheusInstantResult {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v['status'] !== 'string') return false;
  const data = v['data'] as Record<string, unknown> | undefined;
  if (!data || data['resultType'] !== 'vector') return false;
  return Array.isArray(data['result']);
}

interface ChartPoint {
  x: Date;
  y: number;
  name: string;
}

function seriesLabel(metric: Record<string, string>, fallback = 'series'): string {
  if (metric['model'] != null) return metric['model'];
  if (metric['from'] != null && metric['to'] != null) return `${metric['from']}→${metric['to']}`;
  return metric['reason'] ?? metric['instance'] ?? metric['device'] ?? fallback;
}

function parseRangeSeries(data: unknown): ChartPoint[][] {
  if (!isPrometheusRangeResult(data)) return [];
  return data.data.result.map((series) => {
    const name = seriesLabel(series.metric);
    return series.values.map(([ts, val]) => ({
      x: new Date(ts * 1000),
      y: parseFloat(val),
      name,
    }));
  });
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface MetricsEmptyStateProps {
  title?: string;
}

function MetricsEmptyState({ title }: MetricsEmptyStateProps) {
  const { t } = useTranslation('metrics');
  return (
    <EmptyState variant="sm" icon={ChartLineIcon} titleText={title ?? t('empty.title')} headingLevel="h3">
      <EmptyStateBody>
        {t('empty.body')}
      </EmptyStateBody>
    </EmptyState>
  );
}

interface MetricsCardLoadingProps {
  label?: string;
}

function MetricsCardLoading({ label }: MetricsCardLoadingProps) {
  const { t } = useTranslation('metrics');
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        height: '300px',
      }}
    >
      <Spinner aria-label={label ?? t('loading')} size="xl" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Line chart card
// ---------------------------------------------------------------------------

interface LineChartCardProps {
  title: string;
  isLoading: boolean;
  hasError: boolean;
  seriesData: ChartPoint[][];
  yLabel: string;
  formatY: (y: number) => string;
}

function LineChartCard({
  title,
  isLoading,
  hasError,
  seriesData,
  yLabel,
  formatY,
}: LineChartCardProps) {
  const hasData = seriesData.length > 0 && seriesData.some((s) => s.length > 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardBody>
        {isLoading && <MetricsCardLoading />}
        {!isLoading && (hasError || !hasData) && <MetricsEmptyState />}
        {!isLoading && !hasError && hasData && (
          <div style={{ height: '300px' }}>
            <Chart
              ariaDesc={title}
              ariaTitle={title}
              containerComponent={
                <ChartVoronoiContainer
                  labels={({ datum }: { datum: ChartPoint }) =>
                    `${datum.name}: ${formatY(datum.y)}\n${formatHHMM(datum.x)}`
                  }
                  constrainToVisibleArea
                />
              }
              height={300}
              padding={{ bottom: 50, left: 70, right: 20, top: 20 }}
              themeColor={ChartThemeColor.multi}
              scale={{ x: 'time', y: 'linear' }}
            >
              <ChartAxis
                tickFormat={(t: Date | number) => {
                  const d = t instanceof Date ? t : new Date(t);
                  return formatHHMM(d);
                }}
                style={{ tickLabels: { fontSize: 10 } }}
              />
              <ChartAxis
                dependentAxis
                label={yLabel}
                tickFormat={(v: number) => formatY(v)}
                style={{
                  axisLabel: { fontSize: 11, padding: 55 },
                  tickLabels: { fontSize: 10 },
                }}
              />
              <ChartGroup>
                {seriesData.map((series, idx) => (
                  <ChartLine key={idx} data={series} x="x" y="y" />
                ))}
              </ChartGroup>
            </Chart>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Area chart card (for memory over time)
// ---------------------------------------------------------------------------

interface AreaChartCardProps {
  title: string;
  isLoading: boolean;
  hasError: boolean;
  seriesData: ChartPoint[][];
  yLabel: string;
  formatY: (y: number) => string;
}

function AreaChartCard({
  title,
  isLoading,
  hasError,
  seriesData,
  yLabel,
  formatY,
}: AreaChartCardProps) {
  const hasData = seriesData.length > 0 && seriesData.some((s) => s.length > 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardBody>
        {isLoading && <MetricsCardLoading />}
        {!isLoading && (hasError || !hasData) && <MetricsEmptyState />}
        {!isLoading && !hasError && hasData && (
          <div style={{ height: '300px' }}>
            <Chart
              ariaDesc={title}
              ariaTitle={title}
              containerComponent={
                <ChartVoronoiContainer
                  labels={({ datum }: { datum: ChartPoint }) =>
                    `${datum.name}: ${formatY(datum.y)}\n${formatHHMM(datum.x)}`
                  }
                  constrainToVisibleArea
                />
              }
              height={300}
              padding={{ bottom: 50, left: 80, right: 20, top: 20 }}
              themeColor={ChartThemeColor.multi}
              scale={{ x: 'time', y: 'linear' }}
            >
              <ChartAxis
                tickFormat={(t: Date | number) => {
                  const d = t instanceof Date ? t : new Date(t);
                  return formatHHMM(d);
                }}
                style={{ tickLabels: { fontSize: 10 } }}
              />
              <ChartAxis
                dependentAxis
                label={yLabel}
                tickFormat={(v: number) => formatY(v)}
                style={{
                  axisLabel: { fontSize: 11, padding: 65 },
                  tickLabels: { fontSize: 10 },
                }}
              />
              <ChartGroup>
                {seriesData.map((series, idx) => (
                  <ChartArea key={idx} data={series} x="x" y="y" />
                ))}
              </ChartGroup>
            </Chart>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Memory table card
// ---------------------------------------------------------------------------

interface MemoryCardProps {
  isLoading: boolean;
  hasError: boolean;
  data: unknown;
}

function MemoryCard({ isLoading, hasError, data }: MemoryCardProps) {
  const { t } = useTranslation('metrics');
  const rows = useMemo(() => {
    if (!isPrometheusInstantResult(data)) return [];
    return data.data.result.map((series) => {
      const label =
        series.metric['model'] ??
        series.metric['device'] ??
        series.metric['instance'] ??
        'unknown';
      const bytes = parseFloat(series.value[1]);
      return { label, bytes };
    });
  }, [data]);

  const hasData = rows.length > 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('charts.deviceMemoryCurrent')}</CardTitle>
      </CardHeader>
      <CardBody>
        {isLoading && <MetricsCardLoading label={t('loadingMemory')} />}
        {!isLoading && (hasError || !hasData) && <MetricsEmptyState />}
        {!isLoading && !hasError && hasData && (
          <table
            style={{
              width: '100%',
              borderCollapse: 'collapse',
              fontSize: 'var(--pf-t--global--font--size--body--default)',
            }}
          >
            <thead>
              <tr>
                <th
                  scope="col"
                  style={{
                    textAlign: 'left',
                    padding: '8px 12px',
                    borderBottom: '1px solid var(--pf-t--global--border--color--default)',
                    fontWeight: 'var(--pf-t--global--font--weight--heading--default)',
                  }}
                >
                  {t('table.deviceModel')}
                </th>
                <th
                  scope="col"
                  style={{
                    textAlign: 'right',
                    padding: '8px 12px',
                    borderBottom: '1px solid var(--pf-t--global--border--color--default)',
                    fontWeight: 'var(--pf-t--global--font--weight--heading--default)',
                  }}
                >
                  {t('table.memoryUsed')}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ label, bytes }, idx) => (
                <tr
                  key={idx}
                  style={{
                    background:
                      idx % 2 === 0
                        ? 'var(--pf-t--global--background--color--primary--default)'
                        : 'var(--pf-t--global--background--color--secondary--default)',
                  }}
                >
                  <td style={{ padding: '8px 12px' }}>{label}</td>
                  <td
                    style={{
                      padding: '8px 12px',
                      textAlign: 'right',
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {formatBytes(bytes)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardBody>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

function formatDateForPicker(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function formatTimeForPicker(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function parseDateAndTime(dateStr: string, timeStr: string): Date {
  const [year, month, day] = dateStr.split('-').map(Number);
  const [hours, minutes] = timeStr.split(':').map(Number);
  return new Date(year, month - 1, day, hours, minutes);
}

export function MetricsDashboard() {
  const { t } = useTranslation('metrics');
  const [selectedRange, setSelectedRange] = useState<TimeRange>('1h');
  const [autoRefresh, setAutoRefresh] = useState(true);
  const { status: sseStatus } = useEventStream();

  // Custom range state
  const defaultEnd = new Date();
  const defaultStart = new Date(defaultEnd.getTime() - 60 * 60 * 1000);
  const [customStartDate, setCustomStartDate] = useState(formatDateForPicker(defaultStart));
  const [customStartTime, setCustomStartTime] = useState(formatTimeForPicker(defaultStart));
  const [customEndDate, setCustomEndDate] = useState(formatDateForPicker(defaultEnd));
  const [customEndTime, setCustomEndTime] = useState(formatTimeForPicker(defaultEnd));

  const customRange: CustomRange | undefined = useMemo(() => {
    if (selectedRange !== 'custom') return undefined;
    const start = parseDateAndTime(customStartDate, customStartTime);
    const end = parseDateAndTime(customEndDate, customEndTime);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) return undefined;
    return { start, end };
  }, [selectedRange, customStartDate, customStartTime, customEndDate, customEndTime]);

  const isCustomValid = selectedRange !== 'custom' || (
    customRange != null && customRange.end > customRange.start
  );

  const isCustom = selectedRange === 'custom';

  // Disable auto-refresh for custom (historical) ranges
  const effectiveAutoRefresh = isCustom ? false : autoRefresh;

  // When SSE is degraded and auto-refresh is on, poll more aggressively to
  // compensate for the loss of real-time push updates.
  const refetchInterval: number | false = effectiveAutoRefresh
    ? sseStatus === 'degraded' ? 5_000 : 30_000
    : false;

  const hookCustom = isCustomValid ? customRange : undefined;
  const latency = useLatencyMetrics(selectedRange, refetchInterval, hookCustom);
  const throughput = useThroughputMetrics(selectedRange, refetchInterval, hookCustom);
  const memory = useMemoryMetrics(selectedRange, refetchInterval, hookCustom);
  const connections = useConnectionMetrics(selectedRange, refetchInterval, hookCustom);
  const parkingDuration = useParkingDuration(selectedRange, refetchInterval, hookCustom);
  const wakeTriggers = useWakeTriggers(selectedRange, refetchInterval, hookCustom);
  const stateTransitions = useStateTransitions(selectedRange, refetchInterval, hookCustom);
  const evictions = useEvictions(selectedRange, refetchInterval, hookCustom);
  const memoryHistory = useMemoryHistory(selectedRange, refetchInterval, hookCustom);
  const operations = useOperationDurations(selectedRange, refetchInterval, hookCustom);

  const handlePresetSelect = useCallback((range: TimeRange) => {
    setSelectedRange(range);
    if (range !== 'custom') {
      setAutoRefresh(true);
    }
  }, []);

  // Parse latency multi-quantile response
  const latencyData = latency.data as { p50?: unknown; p95?: unknown; p99?: unknown } | undefined;
  const latencySeriesP50 = useMemo(() => parseRangeSeries(latencyData?.p50), [latencyData?.p50]);
  const latencySeriesP95 = useMemo(() => parseRangeSeries(latencyData?.p95), [latencyData?.p95]);
  const latencySeriesP99 = useMemo(() => parseRangeSeries(latencyData?.p99), [latencyData?.p99]);

  // Flatten all quantiles into labelled series for the latency chart
  const latencySeries = useMemo<ChartPoint[][]>(() => {
    const labelSeries = (series: ChartPoint[][], label: string): ChartPoint[][] =>
      series.map((s) => s.map((pt) => ({ ...pt, name: label })));
    return [
      ...labelSeries(latencySeriesP50, 'p50'),
      ...labelSeries(latencySeriesP95, 'p95'),
      ...labelSeries(latencySeriesP99, 'p99'),
    ];
  }, [latencySeriesP50, latencySeriesP95, latencySeriesP99]);

  const throughputSeries = useMemo(() => parseRangeSeries(throughput.data), [throughput.data]);

  // Connections
  const connectionsData = connections.data as { active?: unknown; parked?: unknown } | undefined;
  const activeConnectionsSeries = useMemo(() => {
    const series = parseRangeSeries(connectionsData?.active);
    return series.map((s) => s.map((pt) => ({ ...pt, name: 'active' })));
  }, [connectionsData?.active]);
  const parkedConnectionsSeries = useMemo(() => parseRangeSeries(connectionsData?.parked), [connectionsData?.parked]);

  // Parking duration
  const parkingData = parkingDuration.data as { p50?: unknown; p95?: unknown } | undefined;
  const parkingP50 = useMemo(() => {
    const series = parseRangeSeries(parkingData?.p50);
    return series.map((s) => s.map((pt) => ({ ...pt, name: 'p50' })));
  }, [parkingData?.p50]);
  const parkingP95 = useMemo(() => {
    const series = parseRangeSeries(parkingData?.p95);
    return series.map((s) => s.map((pt) => ({ ...pt, name: 'p95' })));
  }, [parkingData?.p95]);
  const parkingDurationSeries = useMemo<ChartPoint[][]>(() => [...parkingP50, ...parkingP95], [parkingP50, parkingP95]);

  const wakeTriggersSeries = useMemo(() => parseRangeSeries(wakeTriggers.data), [wakeTriggers.data]);
  const stateTransitionsSeries = useMemo(() => parseRangeSeries(stateTransitions.data), [stateTransitions.data]);
  const evictionsSeries = useMemo(() => parseRangeSeries(evictions.data), [evictions.data]);
  const memoryHistorySeries = useMemo(() => parseRangeSeries(memoryHistory.data), [memoryHistory.data]);

  // Operations — each key is a separate Prometheus range result
  const operationsData = operations.data as {
    deploy?: unknown;
    sleep?: unknown;
    wake?: unknown;
    eviction?: unknown;
    placement?: unknown;
  } | undefined;
  const operationsSeries = useMemo<ChartPoint[][]>(() => {
    const entries: Array<[string, unknown]> = [
      ['deploy', operationsData?.deploy],
      ['sleep', operationsData?.sleep],
      ['wake', operationsData?.wake],
      ['eviction', operationsData?.eviction],
      ['placement', operationsData?.placement],
    ];
    return entries.flatMap(([label, raw]) =>
      parseRangeSeries(raw).map((s) => s.map((pt) => ({ ...pt, name: label }))),
    );
  }, [operationsData]);

  const presetRanges: Exclude<TimeRange, 'custom'>[] = ['15m', '1h', '6h', '24h', '7d'];

  return (
    <>
      <PageSection>
        <Content>
          <h1>{t('title')}</h1>
        </Content>
      </PageSection>

      <PageSection>
        <Toolbar>
          <ToolbarContent>
            <ToolbarGroup>
              <ToolbarItem>
                <ToggleGroup aria-label={t('timeRangeSelector')}>
                  {presetRanges.map((range) => (
                    <ToggleGroupItem
                      key={range}
                      text={range}
                      isSelected={selectedRange === range}
                      onChange={(_event, selected) => {
                        if (selected) handlePresetSelect(range);
                      }}
                      buttonId={`time-range-${range}`}
                    />
                  ))}
                  <ToggleGroupItem
                    text={t('customRange')}
                    isSelected={selectedRange === 'custom'}
                    onChange={(_event, selected) => {
                      if (selected) setSelectedRange('custom');
                    }}
                    buttonId="time-range-custom"
                  />
                </ToggleGroup>
              </ToolbarItem>
            </ToolbarGroup>
            <ToolbarGroup align={{ default: 'alignEnd' }}>
              <ToolbarItem>
                <Switch
                  id="auto-refresh-switch"
                  label={t('autoRefresh')}
                  isChecked={effectiveAutoRefresh}
                  isDisabled={isCustom}
                  onChange={(_event, checked) => setAutoRefresh(checked)}
                />
              </ToolbarItem>
            </ToolbarGroup>
          </ToolbarContent>
          {isCustom && (
            <ToolbarContent>
              <ToolbarItem>
                <Split hasGutter>
                  <SplitItem>
                    <span style={{ fontWeight: 'var(--pf-t--global--font--weight--bold)', marginRight: 'var(--pf-t--global--spacer--sm)' }}>
                      {t('customRangeStart')}
                    </span>
                    <DatePicker
                      value={customStartDate}
                      onChange={(_event, value) => setCustomStartDate(value)}
                      aria-label={t('customRangeStart')}
                    />
                    <TimePicker
                      time={customStartTime}
                      onChange={(_event, time) => setCustomStartTime(time)}
                      is24Hour
                      aria-label={t('customRangeStartTime')}
                      style={{ marginLeft: 'var(--pf-t--global--spacer--sm)' }}
                    />
                  </SplitItem>
                  <SplitItem>
                    <span style={{ fontWeight: 'var(--pf-t--global--font--weight--bold)', marginRight: 'var(--pf-t--global--spacer--sm)' }}>
                      {t('customRangeEnd')}
                    </span>
                    <DatePicker
                      value={customEndDate}
                      onChange={(_event, value) => setCustomEndDate(value)}
                      aria-label={t('customRangeEnd')}
                    />
                    <TimePicker
                      time={customEndTime}
                      onChange={(_event, time) => setCustomEndTime(time)}
                      is24Hour
                      aria-label={t('customRangeEndTime')}
                      style={{ marginLeft: 'var(--pf-t--global--spacer--sm)' }}
                    />
                  </SplitItem>
                </Split>
              </ToolbarItem>
              {!isCustomValid && (
                <ToolbarItem>
                  <HelperText>
                    <HelperTextItem variant="error">{t('customRangeInvalid')}</HelperTextItem>
                  </HelperText>
                </ToolbarItem>
              )}
            </ToolbarContent>
          )}
        </Toolbar>
      </PageSection>

      <PageSection>
        <Grid hasGutter>
          {/* Row 1: Request Traffic */}
          <GridItem md={6}>
            <LineChartCard
              title={t('charts.requestLatency')}
              isLoading={latency.isLoading}
              hasError={!!latency.error}
              seriesData={latencySeries}
              yLabel={t('yLabels.latency')}
              formatY={(v) => `${v.toFixed(3)} s`}
            />
          </GridItem>
          <GridItem md={6}>
            <LineChartCard
              title={t('charts.requestThroughput')}
              isLoading={throughput.isLoading}
              hasError={!!throughput.error}
              seriesData={throughputSeries}
              yLabel={t('yLabels.throughput')}
              formatY={(v) => `${v.toFixed(2)} req/s`}
            />
          </GridItem>

          {/* Row 2: Connections & Parking */}
          <GridItem md={4}>
            <LineChartCard
              title={t('charts.activeConnections')}
              isLoading={connections.isLoading}
              hasError={!!connections.error}
              seriesData={activeConnectionsSeries}
              yLabel={t('yLabels.connections')}
              formatY={(v) => v.toFixed(0)}
            />
          </GridItem>
          <GridItem md={4}>
            <LineChartCard
              title={t('charts.parkedConnections')}
              isLoading={connections.isLoading}
              hasError={!!connections.error}
              seriesData={parkedConnectionsSeries}
              yLabel={t('yLabels.connections')}
              formatY={(v) => v.toFixed(0)}
            />
          </GridItem>
          <GridItem md={4}>
            <LineChartCard
              title={t('charts.parkingDuration')}
              isLoading={parkingDuration.isLoading}
              hasError={!!parkingDuration.error}
              seriesData={parkingDurationSeries}
              yLabel={t('yLabels.duration')}
              formatY={(v) => `${v.toFixed(3)} s`}
            />
          </GridItem>

          {/* Row 3: Model Lifecycle */}
          <GridItem md={4}>
            <LineChartCard
              title={t('charts.wakeTriggers')}
              isLoading={wakeTriggers.isLoading}
              hasError={!!wakeTriggers.error}
              seriesData={wakeTriggersSeries}
              yLabel={t('yLabels.triggers')}
              formatY={(v) => `${v.toFixed(3)}/s`}
            />
          </GridItem>
          <GridItem md={4}>
            <LineChartCard
              title={t('charts.stateTransitions')}
              isLoading={stateTransitions.isLoading}
              hasError={!!stateTransitions.error}
              seriesData={stateTransitionsSeries}
              yLabel={t('yLabels.transitions')}
              formatY={(v) => `${v.toFixed(3)}/s`}
            />
          </GridItem>
          <GridItem md={4}>
            <LineChartCard
              title={t('charts.evictions')}
              isLoading={evictions.isLoading}
              hasError={!!evictions.error}
              seriesData={evictionsSeries}
              yLabel={t('yLabels.evictions')}
              formatY={(v) => `${v.toFixed(3)}/s`}
            />
          </GridItem>

          {/* Row 4: Memory & Operations */}
          <GridItem md={4}>
            <AreaChartCard
              title={t('charts.memoryOverTime')}
              isLoading={memoryHistory.isLoading}
              hasError={!!memoryHistory.error}
              seriesData={memoryHistorySeries}
              yLabel={t('yLabels.vram')}
              formatY={(v) => formatBytes(v)}
            />
          </GridItem>
          <GridItem md={4}>
            <LineChartCard
              title={t('charts.operationDuration')}
              isLoading={operations.isLoading}
              hasError={!!operations.error}
              seriesData={operationsSeries}
              yLabel={t('yLabels.duration')}
              formatY={(v) => `${v.toFixed(3)} s`}
            />
          </GridItem>
          <GridItem md={4}>
            <MemoryCard
              isLoading={memory.isLoading}
              hasError={!!memory.error}
              data={memory.data}
            />
          </GridItem>
        </Grid>
      </PageSection>
    </>
  );
}
