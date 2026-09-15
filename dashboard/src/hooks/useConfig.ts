import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';

// Server config does not change at runtime — cache indefinitely.
export function useConfig() {
  return useQuery({
    queryKey: ['config'],
    queryFn: ({ signal }) => api.config.get(signal),
    staleTime: Infinity,
    gcTime: Infinity,
  });
}
