import { useQuery } from '@tanstack/react-query';
import { api, type MetricsParams } from '../api/client';

export function useLatencyMetrics(params: MetricsParams) {
  return useQuery({
    queryKey: ['metrics', 'latency', params],
    queryFn: ({ signal }) => api.metrics.getLatency(params, signal),
    refetchInterval: 30_000,
  });
}

export function useThroughputMetrics(params: MetricsParams) {
  return useQuery({
    queryKey: ['metrics', 'throughput', params],
    queryFn: ({ signal }) => api.metrics.getThroughput(params, signal),
    refetchInterval: 30_000,
  });
}

export function useMemoryMetrics(params: MetricsParams) {
  return useQuery({
    queryKey: ['metrics', 'memory', params],
    queryFn: ({ signal }) => api.metrics.getMemory(params, signal),
    refetchInterval: 30_000,
  });
}
