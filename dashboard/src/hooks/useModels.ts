import { useQuery, useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { ModelLifecycleState } from '@sardeenz/types';
import { api, type ModelInfo, type ModelDeploymentRequest } from '../api/client';
import { useDegraded } from '../contexts/DegradedContext';
import { useEventStream } from './useEventStream';

type ModelListData = { models: ModelInfo[] };

export function useModels(state?: string) {
  const { reportFallback } = useDegraded();
  const { status: sseStatus } = useEventStream();
  const raw = useQuery({
    queryKey: ['models', { state }],
    queryFn: ({ signal }) => api.models.list(state, signal),
    refetchInterval: sseStatus === 'degraded' ? 2_000 : 10_000,
  });

  useEffect(() => {
    const isFallback =
      (raw.data as Record<string, unknown> | undefined)?.['source'] === 'redis-fallback';
    reportFallback('models-list', isFallback);
    return () => {
      reportFallback('models-list', false);
    };
  }, [raw.data, reportFallback]);

  return { ...raw, data: raw.data?.models };
}

export function useModel(name: string) {
  const { reportFallback } = useDegraded();
  const { status: sseStatus } = useEventStream();

  const query = useQuery({
    queryKey: ['models', name],
    queryFn: ({ signal }) => api.models.get(name, signal),
    enabled: !!name,
    // Faster polling during STARTING / PENDING to reflect loading progress quickly
    refetchInterval: (q) => {
      const state = (q.state.data as { state?: string } | undefined)?.state;
      const isTransient = state === 'STARTING' || state === 'PENDING';
      if (sseStatus === 'degraded') return 2_000;
      return isTransient ? 2_000 : 5_000;
    },
  });

  useEffect(() => {
    const isFallback =
      (query.data as Record<string, unknown> | undefined)?.['source'] === 'redis-fallback';
    reportFallback(`model-${name}`, isFallback);
    return () => {
      reportFallback(`model-${name}`, false);
    };
  }, [query.data, name, reportFallback]);

  return query;
}

// ---------------------------------------------------------------------------
// Optimistic mutation helper
// ---------------------------------------------------------------------------

type Snapshot = [readonly unknown[], ModelListData | undefined][];

// Apply an optimistic list update to one cached ['models', …] entry. The ['models'] prefix also
// matches the ['models', name] detail queries, whose data is a single ModelDetail with no `.models`
// array — spreading that undefined threw "models is not iterable", so leave non-list entries as-is.
export function updateModelListData(
  old: ModelListData | undefined,
  updater: (models: ModelInfo[]) => ModelInfo[],
): ModelListData | undefined {
  return old && Array.isArray(old.models) ? { ...old, models: updater(old.models) } : old;
}

function createOptimisticMutation<TArg>(
  queryClient: QueryClient,
  mutationFn: (arg: TArg) => Promise<unknown>,
  updater: (models: ModelInfo[], arg: TArg) => ModelInfo[],
) {
  return {
    mutationFn,
    onMutate: async (arg: TArg): Promise<{ previous: Snapshot }> => {
      await queryClient.cancelQueries({ queryKey: ['models'] });
      const previous = queryClient.getQueriesData<ModelListData>({ queryKey: ['models'] });
      queryClient.setQueriesData<ModelListData>({ queryKey: ['models'] }, (old) =>
        updateModelListData(old, (models) => updater(models, arg)),
      );
      return { previous };
    },
    onError: (_err: unknown, _arg: TArg, context?: { previous: Snapshot }) => {
      if (context?.previous) {
        for (const [key, data] of context.previous) {
          queryClient.setQueryData(key, data);
        }
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['models'] });
      void queryClient.invalidateQueries({ queryKey: ['cluster'] });
    },
  };
}

export function useDeployModel() {
  const queryClient = useQueryClient();
  return useMutation(
    createOptimisticMutation<ModelDeploymentRequest>(
      queryClient,
      (body) => api.models.deploy(body),
      (models, body) => [
        ...models,
        {
          modelName: body.modelName,
          state: ModelLifecycleState.PENDING,
          runnerType: body.runnerType,
          requiredMemory: body.requiredMemory,
          pinned: body.pinned ?? false,
          createdAt: new Date().toISOString(),
        },
      ],
    ),
  );
}

export function useSleepModel() {
  const queryClient = useQueryClient();
  return useMutation(
    createOptimisticMutation<string>(
      queryClient,
      (name) => api.models.sleep(name),
      (models, name) =>
        models.map((m) =>
          m.modelName === name ? { ...m, state: ModelLifecycleState.DRAINING } : m,
        ),
    ),
  );
}

export function useWakeModel() {
  const queryClient = useQueryClient();
  return useMutation(
    createOptimisticMutation<string>(
      queryClient,
      (name) => api.models.wake(name),
      (models, name) =>
        models.map((m) =>
          m.modelName === name ? { ...m, state: ModelLifecycleState.STARTING } : m,
        ),
    ),
  );
}

export function useStopModel() {
  const queryClient = useQueryClient();
  return useMutation(
    createOptimisticMutation<string>(
      queryClient,
      (name) => api.models.stop(name),
      (models, name) =>
        models.map((m) =>
          m.modelName === name ? { ...m, state: ModelLifecycleState.STOPPING } : m,
        ),
    ),
  );
}

export function useStartModel() {
  const queryClient = useQueryClient();
  return useMutation(
    createOptimisticMutation<string>(
      queryClient,
      (name) => api.models.start(name),
      (models, name) =>
        models.map((m) =>
          m.modelName === name ? { ...m, state: ModelLifecycleState.STARTING } : m,
        ),
    ),
  );
}

export function useDeleteModel() {
  const queryClient = useQueryClient();
  return useMutation(
    createOptimisticMutation<string>(
      queryClient,
      (name) => api.models.delete(name),
      (models, name) =>
        models.map((m) =>
          m.modelName === name ? { ...m, state: ModelLifecycleState.STOPPING } : m,
        ),
    ),
  );
}
