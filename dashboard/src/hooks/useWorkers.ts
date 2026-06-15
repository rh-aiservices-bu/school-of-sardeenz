import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';

export function useWorkers() {
  return useQuery({
    queryKey: ['workers'],
    queryFn: ({ signal }) => api.workers.list(signal),
    select: (data) => data.workers,
    refetchInterval: 10_000,
  });
}

export function useWorker(id: string) {
  return useQuery({
    queryKey: ['workers', id],
    queryFn: ({ signal }) => api.workers.get(id, signal),
    enabled: !!id,
    refetchInterval: 5_000,
  });
}
