import { type ControlPlaneComponents } from '@sardeenz/types';

type ModelInfo = ControlPlaneComponents['schemas']['ModelInfo'];
type ModelDetail = ControlPlaneComponents['schemas']['ModelDetail'];
type ModelDeploymentRequest = ControlPlaneComponents['schemas']['ModelDeploymentRequest'];
type ClusterStatus = ControlPlaneComponents['schemas']['ClusterStatus'];
type ClusterMemory = ControlPlaneComponents['schemas']['ClusterMemory'];
type WorkerInfo = ControlPlaneComponents['schemas']['WorkerInfo'];
type WorkerDetail = ControlPlaneComponents['schemas']['WorkerDetail'];
type ErrorResponse = ControlPlaneComponents['schemas']['ErrorResponse'];

export { type ModelInfo, type ModelDetail, type ModelDeploymentRequest, type ClusterStatus, type ClusterMemory, type WorkerInfo, type WorkerDetail };

export const BASE_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? '/api';

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: Record<string, unknown>;

  constructor(
    status: number,
    message: string,
    code?: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const url = `${BASE_URL}${path}`;
  const headers: Record<string, string> = { ...options?.headers as Record<string, string> };
  if (options?.body) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(url, { ...options, headers });

  if (!res.ok) {
    let errorMessage = `HTTP ${res.status}`;
    let code: string | undefined;
    let details: Record<string, unknown> | undefined;
    try {
      const body = (await res.json()) as ErrorResponse;
      errorMessage = body.error ?? errorMessage;
      code = body.code;
      details = body.details;
    } catch {
      // Ignore parse errors
    }
    throw new ApiError(res.status, errorMessage, code, details);
  }

  return res.json() as T;
}

interface MetricsParams {
  start?: string;
  end?: string;
  step?: string;
}

function formatMetricsParams(params: MetricsParams): string {
  const searchParams = new URLSearchParams();
  if (params.start) searchParams.set('start', params.start);
  if (params.end) searchParams.set('end', params.end);
  if (params.step) searchParams.set('step', params.step);
  return searchParams.toString();
}

export { type MetricsParams };

export const api = {
  cluster: {
    getStatus: (signal?: AbortSignal) =>
      request<ClusterStatus>('/cluster/status', { signal }),
    getMemory: (signal?: AbortSignal) =>
      request<ClusterMemory>('/cluster/memory', { signal }),
  },
  models: {
    list: (state?: string, signal?: AbortSignal) => {
      const params = state ? `?state=${encodeURIComponent(state)}` : '';
      return request<{ models: ModelInfo[] }>(`/models${params}`, { signal });
    },
    get: (name: string, signal?: AbortSignal) =>
      request<ModelDetail>(`/models/${encodeURIComponent(name)}`, { signal }),
    deploy: (body: ModelDeploymentRequest) =>
      request<unknown>('/models', { method: 'POST', body: JSON.stringify(body) }),
    delete: (name: string) =>
      request<unknown>(`/models/${encodeURIComponent(name)}`, { method: 'DELETE' }),
    sleep: (name: string) =>
      request<unknown>(`/models/${encodeURIComponent(name)}/sleep`, { method: 'POST' }),
    wake: (name: string) =>
      request<unknown>(`/models/${encodeURIComponent(name)}/wake`, { method: 'POST' }),
  },
  workers: {
    list: (signal?: AbortSignal) =>
      request<{ workers: WorkerInfo[] }>('/workers', { signal }),
    get: (id: string, signal?: AbortSignal) =>
      request<WorkerDetail>(`/workers/${encodeURIComponent(id)}`, { signal }),
  },
  metrics: {
    getLatency: (params: MetricsParams, signal?: AbortSignal) =>
      request<unknown>(`/metrics/latency?${formatMetricsParams(params)}`, { signal }),
    getThroughput: (params: MetricsParams, signal?: AbortSignal) =>
      request<unknown>(`/metrics/throughput?${formatMetricsParams(params)}`, { signal }),
    getMemory: (params: MetricsParams, signal?: AbortSignal) =>
      request<unknown>(`/metrics/memory?${formatMetricsParams(params)}`, { signal }),
  },
};
