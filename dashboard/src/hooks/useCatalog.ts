import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useEventStream } from './useEventStream';

// The runner catalog merged with import state. Import progress arrives via the SSE stream
// (CATALOG_* events invalidate ['catalog'] in useEventStream), so we poll gently otherwise.
export function useCatalog() {
  const { status: sseStatus } = useEventStream();
  return useQuery({
    queryKey: ['catalog'],
    queryFn: ({ signal }) => api.catalog.list(signal),
    refetchInterval: sseStatus === 'degraded' ? 5_000 : false,
  });
}

export function useRefreshCatalog() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.catalog.refresh(),
    onSuccess: (data) => queryClient.setQueryData(['catalog'], data),
  });
}

export function useImportRunner() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.catalog.import(id),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ['catalog'] }),
  });
}

export function useUninstallRunner() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.catalog.uninstall(id),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ['catalog'] }),
  });
}
