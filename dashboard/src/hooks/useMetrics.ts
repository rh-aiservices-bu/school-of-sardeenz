import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';

export type TimeRange = '15m' | '1h' | '6h' | '24h' | '7d';

const TIME_RANGE_DURATIONS: Record<TimeRange, { durationMs: number; step: string }> = {
  '15m': { durationMs: 15 * 60 * 1000, step: '15s' },
  '1h': { durationMs: 60 * 60 * 1000, step: '60s' },
  '6h': { durationMs: 6 * 60 * 60 * 1000, step: '300s' },
  '24h': { durationMs: 24 * 60 * 60 * 1000, step: '900s' },
  '7d': { durationMs: 7 * 24 * 60 * 60 * 1000, step: '3600s' },
};

function buildFreshParams(range: TimeRange) {
  const { durationMs, step } = TIME_RANGE_DURATIONS[range];
  const end = new Date();
  const start = new Date(end.getTime() - durationMs);
  return { start: start.toISOString(), end: end.toISOString(), step };
}

export function useLatencyMetrics(range: TimeRange, refetchInterval: number | false = 30_000) {
  return useQuery({
    queryKey: ['metrics', 'latency', range],
    queryFn: ({ signal }) => api.metrics.getLatency(buildFreshParams(range), signal),
    refetchInterval,
  });
}

export function useThroughputMetrics(range: TimeRange, refetchInterval: number | false = 30_000) {
  return useQuery({
    queryKey: ['metrics', 'throughput', range],
    queryFn: ({ signal }) => api.metrics.getThroughput(buildFreshParams(range), signal),
    refetchInterval,
  });
}

export function useMemoryMetrics(range: TimeRange, refetchInterval: number | false = 30_000) {
  return useQuery({
    queryKey: ['metrics', 'memory', range],
    queryFn: ({ signal }) => api.metrics.getMemory(buildFreshParams(range), signal),
    refetchInterval,
  });
}

export function useConnectionMetrics(range: TimeRange, refetchInterval: number | false = 30_000) {
  return useQuery({
    queryKey: ['metrics', 'connections', range],
    queryFn: ({ signal }) => api.metrics.getConnections(buildFreshParams(range), signal),
    refetchInterval,
  });
}

export function useParkingDuration(range: TimeRange, refetchInterval: number | false = 30_000) {
  return useQuery({
    queryKey: ['metrics', 'parking-duration', range],
    queryFn: ({ signal }) => api.metrics.getParkingDuration(buildFreshParams(range), signal),
    refetchInterval,
  });
}

export function useWakeTriggers(range: TimeRange, refetchInterval: number | false = 30_000) {
  return useQuery({
    queryKey: ['metrics', 'wake-triggers', range],
    queryFn: ({ signal }) => api.metrics.getWakeTriggers(buildFreshParams(range), signal),
    refetchInterval,
  });
}

export function useStateTransitions(range: TimeRange, refetchInterval: number | false = 30_000) {
  return useQuery({
    queryKey: ['metrics', 'state-transitions', range],
    queryFn: ({ signal }) => api.metrics.getStateTransitions(buildFreshParams(range), signal),
    refetchInterval,
  });
}

export function useEvictions(range: TimeRange, refetchInterval: number | false = 30_000) {
  return useQuery({
    queryKey: ['metrics', 'evictions', range],
    queryFn: ({ signal }) => api.metrics.getEvictions(buildFreshParams(range), signal),
    refetchInterval,
  });
}

export function useMemoryHistory(range: TimeRange, refetchInterval: number | false = 30_000) {
  return useQuery({
    queryKey: ['metrics', 'memory-history', range],
    queryFn: ({ signal }) => api.metrics.getMemoryHistory(buildFreshParams(range), signal),
    refetchInterval,
  });
}

export function useOperationDurations(range: TimeRange, refetchInterval: number | false = 30_000) {
  return useQuery({
    queryKey: ['metrics', 'operations', range],
    queryFn: ({ signal }) => api.metrics.getOperations(buildFreshParams(range), signal),
    refetchInterval,
  });
}
