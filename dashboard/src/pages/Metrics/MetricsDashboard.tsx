import { useMemo, useState } from 'react';
import {
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Content,
  EmptyState,
  EmptyStateBody,
  Grid,
  GridItem,
  PageSection,
  Spinner,
  ToggleGroup,
  ToggleGroupItem,
} from '@patternfly/react-core';
import {
  Chart,
  ChartAxis,
  ChartGroup,
  ChartLine,
  ChartThemeColor,
  ChartVoronoiContainer,
} from '@patternfly/react-charts/victory';
import { ChartLineIcon } from '@patternfly/react-icons';
import { useLatencyMetrics, useThroughputMetrics, useMemoryMetrics } from '../../hooks/useMetrics';
import type { MetricsParams } from '../../api/client';
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
// Time range configuration
// ---------------------------------------------------------------------------

type TimeRange = '15m' | '1h' | '6h' | '24h';

interface TimeRangeConfig {
  label: string;
  durationMs: number;
  step: string;
}

const TIME_RANGE_CONFIGS: Record<TimeRange, TimeRangeConfig> = {
  '15m': { label: '15m', durationMs: 15 * 60 * 1000, step: '15s' },
  '1h': { label: '1h', durationMs: 60 * 60 * 1000, step: '60s' },
  '6h': { label: '6h', durationMs: 6 * 60 * 60 * 1000, step: '300s' },
  '24h': { label: '24h', durationMs: 24 * 60 * 60 * 1000, step: '900s' },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildMetricsParams(range: TimeRange): MetricsParams {
  const { durationMs, step } = TIME_RANGE_CONFIGS[range];
  const end = new Date();
  const start = new Date(end.getTime() - durationMs);
  return {
    start: start.toISOString(),
    end: end.toISOString(),
    step,
  };
}

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

function parseRangeSeries(data: unknown): ChartPoint[][] {
  if (!isPrometheusRangeResult(data)) return [];
  return data.data.result.map((series) => {
    const name = series.metric['model'] ?? series.metric['instance'] ?? 'series';
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

function MetricsEmptyState({ title = 'No metrics data available' }: MetricsEmptyStateProps) {
  return (
    <EmptyState variant="sm" icon={ChartLineIcon} titleText={title} headingLevel="h3">
      <EmptyStateBody>
        Metrics require a running Prometheus instance and active traffic.
      </EmptyStateBody>
    </EmptyState>
  );
}

interface MetricsCardLoadingProps {
  label?: string;
}

function MetricsCardLoading({ label = 'Loading metrics…' }: MetricsCardLoadingProps) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        height: '300px',
      }}
    >
      <Spinner aria-label={label} size="xl" />
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
// Memory table card
// ---------------------------------------------------------------------------

interface MemoryCardProps {
  isLoading: boolean;
  hasError: boolean;
  data: unknown;
}

function MemoryCard({ isLoading, hasError, data }: MemoryCardProps) {
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
        <CardTitle>Device Memory</CardTitle>
      </CardHeader>
      <CardBody>
        {isLoading && <MetricsCardLoading label="Loading memory metrics…" />}
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
                  style={{
                    textAlign: 'left',
                    padding: '8px 12px',
                    borderBottom: '1px solid var(--pf-t--global--border--color--default)',
                    fontWeight: 'var(--pf-t--global--font--weight--heading--default)',
                  }}
                >
                  Device / Model
                </th>
                <th
                  style={{
                    textAlign: 'right',
                    padding: '8px 12px',
                    borderBottom: '1px solid var(--pf-t--global--border--color--default)',
                    fontWeight: 'var(--pf-t--global--font--weight--heading--default)',
                  }}
                >
                  Memory Used
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

export function MetricsDashboard() {
  const [selectedRange, setSelectedRange] = useState<TimeRange>('1h');

  const params = useMemo(() => buildMetricsParams(selectedRange), [selectedRange]);

  const latency = useLatencyMetrics(params);
  const throughput = useThroughputMetrics(params);
  const memory = useMemoryMetrics(params);

  const latencySeries = useMemo(() => parseRangeSeries(latency.data), [latency.data]);
  const throughputSeries = useMemo(() => parseRangeSeries(throughput.data), [throughput.data]);

  const timeRanges: TimeRange[] = ['15m', '1h', '6h', '24h'];

  return (
    <>
      <PageSection>
        <Content>
          <h1>Metrics</h1>
        </Content>
      </PageSection>

      <PageSection>
        <ToggleGroup aria-label="Time range selector">
          {timeRanges.map((range) => (
            <ToggleGroupItem
              key={range}
              text={TIME_RANGE_CONFIGS[range].label}
              isSelected={selectedRange === range}
              onChange={(_event, selected) => {
                if (selected) setSelectedRange(range);
              }}
              buttonId={`time-range-${range}`}
            />
          ))}
        </ToggleGroup>
      </PageSection>

      <PageSection>
        <Grid hasGutter>
          {/* Row 1: Inference performance */}
          <GridItem md={6}>
            <LineChartCard
              title="Request Latency (p95)"
              isLoading={latency.isLoading}
              hasError={!!latency.error}
              seriesData={latencySeries}
              yLabel="Latency (ms)"
              formatY={(v) => `${v.toFixed(0)} ms`}
            />
          </GridItem>
          <GridItem md={6}>
            <LineChartCard
              title="Request Throughput"
              isLoading={throughput.isLoading}
              hasError={!!throughput.error}
              seriesData={throughputSeries}
              yLabel="req/s"
              formatY={(v) => `${v.toFixed(2)} req/s`}
            />
          </GridItem>

          {/* Row 2: Device utilization */}
          <GridItem span={12}>
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
