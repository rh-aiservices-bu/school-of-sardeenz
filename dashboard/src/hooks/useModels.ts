import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type ModelDeploymentRequest } from '../api/client';

export function useModels(state?: string) {
  return useQuery({
    queryKey: ['models', { state }],
    queryFn: ({ signal }) => api.models.list(state, signal),
    select: (data) => data.models,
    refetchInterval: 10_000,
  });
}

export function useModel(name: string) {
  return useQuery({
    queryKey: ['models', name],
    queryFn: ({ signal }) => api.models.get(name, signal),
    enabled: !!name,
    refetchInterval: 5_000,
  });
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
