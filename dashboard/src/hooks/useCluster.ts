import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { api } from '../api/client';
import { useDegraded } from '../contexts/DegradedContext';
import { useEventStream } from './useEventStream';

export function useClusterStatus() {
  const { reportFallback } = useDegraded();
  const { status: sseStatus } = useEventStream();
  const query = useQuery({
    queryKey: ['cluster', 'status'],
    queryFn: ({ signal }) => api.cluster.getStatus(signal),
    refetchInterval: sseStatus === 'degraded' ? 2_000 : 10_000,
  });

  useEffect(() => {
    const isFallback = (query.data as Record<string, unknown> | undefined)?.['source'] === 'redis-fallback';
    reportFallback('cluster-status', isFallback);
    return () => { reportFallback('cluster-status', false); };
  }, [query.data, reportFallback]);

  return query;
}

export function useClusterMemory() {
  const { reportFallback } = useDegraded();
  const { status: sseStatus } = useEventStream();
  const query = useQuery({
    queryKey: ['cluster', 'memory'],
    queryFn: ({ signal }) => api.cluster.getMemory(signal),
    refetchInterval: sseStatus === 'degraded' ? 2_000 : 10_000,
  });

  useEffect(() => {
    const isFallback = (query.data as Record<string, unknown> | undefined)?.['source'] === 'redis-fallback';
    reportFallback('cluster-memory', isFallback);
    return () => { reportFallback('cluster-memory', false); };
  }, [query.data, reportFallback]);

  return query;
}
