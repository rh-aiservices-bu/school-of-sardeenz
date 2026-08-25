import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import type { ControlPlaneComponents } from '@sardeenz/types';
import { WorkerStatus } from '@sardeenz/types';
import { api } from '../api/client';
import { useDegraded } from '../contexts/DegradedContext';
import { useEventStream } from './useEventStream';

type WorkerInfo = ControlPlaneComponents['schemas']['WorkerInfo'];
type WorkerRunnerCapability = ControlPlaneComponents['schemas']['WorkerRunnerCapability'];

export interface SelectOption {
  value: string;
  label: string;
}

// Preserves the pre-#67 hardcoded lists as the fallback when no live capability
// data is available (loading, error, no online workers, or none advertising caps).
export const FALLBACK_RUNNER_OPTIONS: SelectOption[] = [
  { value: 'vllm', label: 'vLLM' },
  { value: 'mlserver', label: 'MLServer' },
  { value: 'triton', label: 'Triton' },
];

export const FALLBACK_DEVICE_TYPES = ['CUDA', 'ROCM', 'CPU'] as const;

/**
 * Flatten the runner capabilities advertised by ONLINE workers only.
 * Draining/degraded/offline workers must not contribute options.
 * Reusable capability accessor — #124 (move-model target filtering) consumes this.
 */
export function collectOnlineCapabilities(
  workers: WorkerInfo[] | undefined,
): WorkerRunnerCapability[] {
  if (!workers) return [];
  return workers
    .filter((w) => w.status === WorkerStatus.ONLINE)
    .flatMap((w) => w.runnerCapabilities ?? []);
}

/** Deduplicate by runnerType, label from engineName, sort by label. Fallback when empty. */
export function computeRunnerOptions(caps: WorkerRunnerCapability[]): {
  options: SelectOption[];
  isFallback: boolean;
} {
  const byType = new Map<string, string>();
  for (const c of caps) {
    if (!byType.has(c.runnerType)) {
      byType.set(c.runnerType, c.engineName || c.runnerType);
    }
  }
  if (byType.size === 0) {
    return { options: FALLBACK_RUNNER_OPTIONS, isFallback: true };
  }
  const options = [...byType.entries()]
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label));
  return { options, isFallback: false };
}

/**
 * Device types are the union of supportedDeviceTypes across the capabilities
 * matching the selected runnerType, with the "Any" ('') option always at the head.
 * anyLabel is passed in (it is translated in the caller) so this stays i18n-free.
 */
export function computeDeviceOptions(
  caps: WorkerRunnerCapability[],
  runnerType: string,
  anyLabel: string,
): { options: SelectOption[]; isFallback: boolean } {
  const head: SelectOption = { value: '', label: anyLabel };
  const devices = new Set<string>();
  for (const c of caps) {
    if (c.runnerType === runnerType) {
      for (const d of c.supportedDeviceTypes) devices.add(d);
    }
  }
  if (devices.size === 0) {
    return {
      options: [head, ...FALLBACK_DEVICE_TYPES.map((v) => ({ value: v, label: v }))],
      isFallback: true,
    };
  }
  const options = [head, ...[...devices].sort().map((v) => ({ value: v, label: v }))];
  return { options, isFallback: false };
}

/**
 * Reconcile a currently-selected runnerType against resolved options.
 * Returns the same value if still valid, else the first option's value, else the
 * input unchanged (empty options — never happens given fallback, but defensive).
 */
export function reconcileRunnerType(current: string, options: SelectOption[]): string {
  if (options.length === 0) return current;
  if (options.some((o) => o.value === current)) return current;
  return options[0].value;
}

/**
 * Reconcile a currently-selected deviceType against device options recomputed for a
 * (possibly new) runnerType. Returns the same value if still valid, else '' — the "Any"
 * option, always at the head of computeDeviceOptions' result. Unlike reconcileRunnerType,
 * the fallback is always '' rather than options[0], since '' is guaranteed to be a valid
 * choice (it means "no constraint") even when options is otherwise empty or unexpected.
 */
export function reconcileDeviceType(current: string, options: SelectOption[]): string {
  if (options.some((o) => o.value === current)) return current;
  return '';
}

export function useWorkers() {
  const { reportFallback } = useDegraded();
  const { status: sseStatus } = useEventStream();
  const raw = useQuery({
    queryKey: ['workers'],
    queryFn: ({ signal }) => api.workers.list(signal),
    refetchInterval: sseStatus === 'degraded' ? 2_000 : 10_000,
  });

  useEffect(() => {
    const isFallback =
      (raw.data as Record<string, unknown> | undefined)?.['source'] === 'redis-fallback';
    reportFallback('workers-list', isFallback);
    return () => {
      reportFallback('workers-list', false);
    };
  }, [raw.data, reportFallback]);

  return { ...raw, data: raw.data?.workers };
}

/**
 * Aggregated online-worker runner capabilities. Shared accessor for #67 (deploy
 * form) and #124 (placement/move-target filtering). isFallback = no live data.
 */
export function useWorkerCapabilities(): {
  capabilities: WorkerRunnerCapability[];
  isFallback: boolean;
} {
  const { data: workers, isLoading, isError } = useWorkers();
  return useMemo(() => {
    if (isLoading || isError) return { capabilities: [], isFallback: true };
    const capabilities = collectOnlineCapabilities(workers);
    return { capabilities, isFallback: capabilities.length === 0 };
  }, [workers, isLoading, isError]);
}

/** Runner-type select options derived from live worker capabilities, with fallback. */
export function useRunnerTypes(): { options: SelectOption[]; isFallback: boolean } {
  const { capabilities } = useWorkerCapabilities();
  return useMemo(() => computeRunnerOptions(capabilities), [capabilities]);
}

export function useWorker(id: string) {
  const { reportFallback } = useDegraded();
  const { status: sseStatus } = useEventStream();
  const query = useQuery({
    queryKey: ['workers', id],
    queryFn: ({ signal }) => api.workers.get(id, signal),
    enabled: !!id,
    refetchInterval: sseStatus === 'degraded' ? 2_000 : 5_000,
  });

  useEffect(() => {
    const isFallback =
      (query.data as Record<string, unknown> | undefined)?.['source'] === 'redis-fallback';
    reportFallback(`worker-${id}`, isFallback);
    return () => {
      reportFallback(`worker-${id}`, false);
    };
  }, [query.data, id, reportFallback]);

  return query;
}
