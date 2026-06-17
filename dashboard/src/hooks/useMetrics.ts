import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';

export type TimeRange = '15m' | '1h' | '6h' | '24h' | '7d' | 'custom';

export interface CustomRange {
  start: Date;
  end: Date;
}

const TIME_RANGE_DURATIONS: Record<
  Exclude<TimeRange, 'custom'>,
  { durationMs: number; step: string }
> = {
  '15m': { durationMs: 15 * 60 * 1000, step: '15s' },
  '1h': { durationMs: 60 * 60 * 1000, step: '60s' },
  '6h': { durationMs: 6 * 60 * 60 * 1000, step: '300s' },
  '24h': { durationMs: 24 * 60 * 60 * 1000, step: '900s' },
  '7d': { durationMs: 7 * 24 * 60 * 60 * 1000, step: '3600s' },
};

function computeStep(durationMs: number): string {
  if (durationMs <= 30 * 60_000) return '15s';
  if (durationMs <= 2 * 3600_000) return '60s';
  if (durationMs <= 12 * 3600_000) return '300s';
  if (durationMs <= 48 * 3600_000) return '900s';
  return '3600s';
}

function buildFreshParams(range: TimeRange, custom?: CustomRange) {
  if (range === 'custom' && custom) {
    const durationMs = custom.end.getTime() - custom.start.getTime();
    return {
      start: custom.start.toISOString(),
      end: custom.end.toISOString(),
      step: computeStep(durationMs),
    };
  }
  const preset = range === 'custom' ? '1h' : range;
  const { durationMs, step } = TIME_RANGE_DURATIONS[preset];
  const end = new Date();
  const start = new Date(end.getTime() - durationMs);
  return { start: start.toISOString(), end: end.toISOString(), step };
}

function customQueryKey(custom?: CustomRange): string | undefined {
  if (!custom) return undefined;
  return `${custom.start.getTime()}-${custom.end.getTime()}`;
}

export function useLatencyMetrics(
  range: TimeRange,
  refetchInterval: number | false = 30_000,
  custom?: CustomRange,
) {
  return useQuery({
    queryKey: ['metrics', 'latency', range, customQueryKey(custom)],
    queryFn: ({ signal }) => api.metrics.getLatency(buildFreshParams(range, custom), signal),
    refetchInterval,
  });
}

export function useThroughputMetrics(
  range: TimeRange,
  refetchInterval: number | false = 30_000,
  custom?: CustomRange,
) {
  return useQuery({
    queryKey: ['metrics', 'throughput', range, customQueryKey(custom)],
    queryFn: ({ signal }) => api.metrics.getThroughput(buildFreshParams(range, custom), signal),
    refetchInterval,
  });
}

export function useMemoryMetrics(
  range: TimeRange,
  refetchInterval: number | false = 30_000,
  custom?: CustomRange,
) {
  return useQuery({
    queryKey: ['metrics', 'memory', range, customQueryKey(custom)],
    queryFn: ({ signal }) => api.metrics.getMemory(buildFreshParams(range, custom), signal),
    refetchInterval,
  });
}

export function useConnectionMetrics(
  range: TimeRange,
  refetchInterval: number | false = 30_000,
  custom?: CustomRange,
) {
  return useQuery({
    queryKey: ['metrics', 'connections', range, customQueryKey(custom)],
    queryFn: ({ signal }) => api.metrics.getConnections(buildFreshParams(range, custom), signal),
    refetchInterval,
  });
}

export function useParkingDuration(
  range: TimeRange,
  refetchInterval: number | false = 30_000,
  custom?: CustomRange,
) {
  return useQuery({
    queryKey: ['metrics', 'parking-duration', range, customQueryKey(custom)],
    queryFn: ({ signal }) =>
      api.metrics.getParkingDuration(buildFreshParams(range, custom), signal),
    refetchInterval,
  });
}

export function useWakeTriggers(
  range: TimeRange,
  refetchInterval: number | false = 30_000,
  custom?: CustomRange,
) {
  return useQuery({
    queryKey: ['metrics', 'wake-triggers', range, customQueryKey(custom)],
    queryFn: ({ signal }) => api.metrics.getWakeTriggers(buildFreshParams(range, custom), signal),
    refetchInterval,
  });
}

export function useStateTransitions(
  range: TimeRange,
  refetchInterval: number | false = 30_000,
  custom?: CustomRange,
) {
  return useQuery({
    queryKey: ['metrics', 'state-transitions', range, customQueryKey(custom)],
    queryFn: ({ signal }) =>
      api.metrics.getStateTransitions(buildFreshParams(range, custom), signal),
    refetchInterval,
  });
}

export function useEvictions(
  range: TimeRange,
  refetchInterval: number | false = 30_000,
  custom?: CustomRange,
) {
  return useQuery({
    queryKey: ['metrics', 'evictions', range, customQueryKey(custom)],
    queryFn: ({ signal }) => api.metrics.getEvictions(buildFreshParams(range, custom), signal),
    refetchInterval,
  });
}

export function useMemoryHistory(
  range: TimeRange,
  refetchInterval: number | false = 30_000,
  custom?: CustomRange,
) {
  return useQuery({
    queryKey: ['metrics', 'memory-history', range, customQueryKey(custom)],
    queryFn: ({ signal }) => api.metrics.getMemoryHistory(buildFreshParams(range, custom), signal),
    refetchInterval,
  });
}

export function useOperationDurations(
  range: TimeRange,
  refetchInterval: number | false = 30_000,
  custom?: CustomRange,
) {
  return useQuery({
    queryKey: ['metrics', 'operations', range, customQueryKey(custom)],
    queryFn: ({ signal }) => api.metrics.getOperations(buildFreshParams(range, custom), signal),
    refetchInterval,
  });
}
