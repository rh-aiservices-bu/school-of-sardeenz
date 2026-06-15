import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';

export function useClusterStatus() {
  return useQuery({
    queryKey: ['cluster', 'status'],
    queryFn: ({ signal }) => api.cluster.getStatus(signal),
    refetchInterval: 10_000,
  });
}

export function useClusterMemory() {
  return useQuery({
    queryKey: ['cluster', 'memory'],
    queryFn: ({ signal }) => api.cluster.getMemory(signal),
    refetchInterval: 10_000,
  });
}
