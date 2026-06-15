import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';

export type TimeRange = '15m' | '1h' | '6h' | '24h';

const TIME_RANGE_DURATIONS: Record<TimeRange, { durationMs: number; step: string }> = {
  '15m': { durationMs: 15 * 60 * 1000, step: '15s' },
  '1h': { durationMs: 60 * 60 * 1000, step: '60s' },
  '6h': { durationMs: 6 * 60 * 60 * 1000, step: '300s' },
  '24h': { durationMs: 24 * 60 * 60 * 1000, step: '900s' },
};

function buildFreshParams(range: TimeRange) {
  const { durationMs, step } = TIME_RANGE_DURATIONS[range];
  const end = new Date();
  const start = new Date(end.getTime() - durationMs);
  return { start: start.toISOString(), end: end.toISOString(), step };
}

export function useLatencyMetrics(range: TimeRange) {
  return useQuery({
    queryKey: ['metrics', 'latency', range],
    queryFn: ({ signal }) => api.metrics.getLatency(buildFreshParams(range), signal),
    refetchInterval: 30_000,
  });
}

export function useThroughputMetrics(range: TimeRange) {
  return useQuery({
    queryKey: ['metrics', 'throughput', range],
    queryFn: ({ signal }) => api.metrics.getThroughput(buildFreshParams(range), signal),
    refetchInterval: 30_000,
  });
}

export function useMemoryMetrics(range: TimeRange) {
  return useQuery({
    queryKey: ['metrics', 'memory', range],
    queryFn: ({ signal }) => api.metrics.getMemory(buildFreshParams(range), signal),
    refetchInterval: 30_000,
  });
}
