import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { api } from '../api/client';
import { useDegraded } from '../contexts/DegradedContext';

export function useWorkers() {
  const { reportFallback } = useDegraded();
  const raw = useQuery({
    queryKey: ['workers'],
    queryFn: ({ signal }) => api.workers.list(signal),
    refetchInterval: 10_000,
  });

  useEffect(() => {
    const isFallback = (raw.data as Record<string, unknown> | undefined)?.['source'] === 'redis-fallback';
    reportFallback('workers-list', isFallback);
    return () => { reportFallback('workers-list', false); };
  }, [raw.data, reportFallback]);

  return { ...raw, data: raw.data?.workers };
}

export function useWorker(id: string) {
  const { reportFallback } = useDegraded();
  const query = useQuery({
    queryKey: ['workers', id],
    queryFn: ({ signal }) => api.workers.get(id, signal),
    enabled: !!id,
    refetchInterval: 5_000,
  });

  useEffect(() => {
    const isFallback = (query.data as Record<string, unknown> | undefined)?.['source'] === 'redis-fallback';
    reportFallback(`worker-${id}`, isFallback);
    return () => { reportFallback(`worker-${id}`, false); };
  }, [query.data, id, reportFallback]);

  return query;
}
