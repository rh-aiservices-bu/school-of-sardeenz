import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { api, type ModelDeploymentRequest } from '../api/client';
import { useDegraded } from '../contexts/DegradedContext';

export function useModels(state?: string) {
  const { reportFallback } = useDegraded();
  const raw = useQuery({
    queryKey: ['models', { state }],
    queryFn: ({ signal }) => api.models.list(state, signal),
    refetchInterval: 10_000,
  });

  useEffect(() => {
    const isFallback = (raw.data as Record<string, unknown> | undefined)?.['source'] === 'redis-fallback';
    reportFallback('models-list', isFallback);
    return () => { reportFallback('models-list', false); };
  }, [raw.data, reportFallback]);

  return { ...raw, data: raw.data?.models };
}

export function useModel(name: string) {
  const { reportFallback } = useDegraded();
  const query = useQuery({
    queryKey: ['models', name],
    queryFn: ({ signal }) => api.models.get(name, signal),
    enabled: !!name,
    refetchInterval: 5_000,
  });

  useEffect(() => {
    const isFallback = (query.data as Record<string, unknown> | undefined)?.['source'] === 'redis-fallback';
    reportFallback(`model-${name}`, isFallback);
    return () => { reportFallback(`model-${name}`, false); };
  }, [query.data, name, reportFallback]);

  return query;
}

export function useDeployModel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: ModelDeploymentRequest) => api.models.deploy(body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['models'] });
      void queryClient.invalidateQueries({ queryKey: ['cluster'] });
    },
  });
}

export function useSleepModel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.models.sleep(name),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['models'] });
      void queryClient.invalidateQueries({ queryKey: ['cluster'] });
    },
  });
}

export function useWakeModel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.models.wake(name),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['models'] });
      void queryClient.invalidateQueries({ queryKey: ['cluster'] });
    },
  });
}

export function useDeleteModel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.models.delete(name),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['models'] });
      void queryClient.invalidateQueries({ queryKey: ['cluster'] });
    },
  });
}
