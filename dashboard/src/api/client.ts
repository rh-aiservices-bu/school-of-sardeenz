import { type ControlPlaneComponents } from '@sardeenz/types';

type ModelInfo = ControlPlaneComponents['schemas']['ModelInfo'];
type ModelDetail = ControlPlaneComponents['schemas']['ModelDetail'];
type ModelDeploymentRequest = ControlPlaneComponents['schemas']['ModelDeploymentRequest'];
type ClusterStatus = ControlPlaneComponents['schemas']['ClusterStatus'];
type ClusterMemory = ControlPlaneComponents['schemas']['ClusterMemory'];
type WorkerInfo = ControlPlaneComponents['schemas']['WorkerInfo'];
type WorkerDetail = ControlPlaneComponents['schemas']['WorkerDetail'];
type ErrorResponse = ControlPlaneComponents['schemas']['ErrorResponse'];
type Notification = ControlPlaneComponents['schemas']['Notification'];
type RunnerCatalogView = ControlPlaneComponents['schemas']['RunnerCatalogView'];
type CatalogItem = ControlPlaneComponents['schemas']['CatalogItem'];
type CatalogItemStatus = ControlPlaneComponents['schemas']['CatalogItemStatus'];
type WeightsListing = ControlPlaneComponents['schemas']['WeightsListing'];
type WeightsEntry = ControlPlaneComponents['schemas']['WeightsEntry'];

export {
  type ModelInfo,
  type ModelDetail,
  type ModelDeploymentRequest,
  type ClusterStatus,
  type ClusterMemory,
  type WorkerInfo,
  type WorkerDetail,
  type Notification,
  type RunnerCatalogView,
  type CatalogItem,
  type CatalogItemStatus,
  type WeightsListing,
  type WeightsEntry,
};

export const BASE_URL = import.meta.env.VITE_API_URL ?? '/api';

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: Record<string, unknown>;

  constructor(status: number, message: string, code?: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const SESSION_KEY = 'sardeenz_auth_token';

function getToken(): string | null {
  try {
    return sessionStorage.getItem(SESSION_KEY);
  } catch {
    return null;
  }
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const url = `${BASE_URL}${path}`;
  const headers: Record<string, string> = { ...(options?.headers as Record<string, string>) };
  if (options?.body) {
    headers['Content-Type'] = 'application/json';
  }

  // Attach auth token when available
  const token = getToken();
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(url, { ...options, headers });

  if (res.status === 401) {
    // Clear token and notify AuthContext
    try {
      sessionStorage.removeItem(SESSION_KEY);
    } catch {
      /* ignore */
    }
    window.dispatchEvent(new Event('auth:unauthorized'));
  }

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
    getStatus: (signal?: AbortSignal) => request<ClusterStatus>('/cluster/status', { signal }),
    getMemory: (signal?: AbortSignal) => request<ClusterMemory>('/cluster/memory', { signal }),
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
    stop: (name: string) =>
      request<unknown>(`/models/${encodeURIComponent(name)}/stop`, { method: 'POST' }),
    start: (name: string) =>
      request<unknown>(`/models/${encodeURIComponent(name)}/start`, { method: 'POST' }),
  },
  workers: {
    list: (signal?: AbortSignal) => request<{ workers: WorkerInfo[] }>('/workers', { signal }),
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
    getConnections: (params: MetricsParams, signal?: AbortSignal) =>
      request<unknown>(`/metrics/connections?${formatMetricsParams(params)}`, { signal }),
    getParkingDuration: (params: MetricsParams, signal?: AbortSignal) =>
      request<unknown>(`/metrics/parking-duration?${formatMetricsParams(params)}`, { signal }),
    getWakeTriggers: (params: MetricsParams, signal?: AbortSignal) =>
      request<unknown>(`/metrics/wake-triggers?${formatMetricsParams(params)}`, { signal }),
    getStateTransitions: (params: MetricsParams, signal?: AbortSignal) =>
      request<unknown>(`/metrics/state-transitions?${formatMetricsParams(params)}`, { signal }),
    getEvictions: (params: MetricsParams, signal?: AbortSignal) =>
      request<unknown>(`/metrics/evictions?${formatMetricsParams(params)}`, { signal }),
    getMemoryHistory: (params: MetricsParams, signal?: AbortSignal) =>
      request<unknown>(`/metrics/memory-history?${formatMetricsParams(params)}`, { signal }),
    getOperations: (params: MetricsParams, signal?: AbortSignal) =>
      request<unknown>(`/metrics/operations?${formatMetricsParams(params)}`, { signal }),
  },
  weights: {
    list: (path?: string, signal?: AbortSignal) => {
      const qs = path ? `?path=${encodeURIComponent(path)}` : '';
      return request<WeightsListing>(`/weights${qs}`, { signal });
    },
  },
  catalog: {
    list: (signal?: AbortSignal) => request<RunnerCatalogView>('/catalog', { signal }),
    refresh: () => request<RunnerCatalogView>('/catalog/refresh', { method: 'POST' }),
    import: (id: string) =>
      request<CatalogItemStatus>(`/catalog/${encodeURIComponent(id)}/import`, { method: 'POST' }),
    uninstall: (id: string) =>
      request<void>(`/catalog/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  },
  notifications: {
    list: (limit?: number, offset?: number, signal?: AbortSignal) => {
      const params = new URLSearchParams();
      if (limit !== undefined) params.set('limit', String(limit));
      if (offset !== undefined) params.set('offset', String(offset));
      const qs = params.toString();
      return request<{ notifications: Notification[] }>(`/notifications${qs ? `?${qs}` : ''}`, {
        signal,
      });
    },
    markRead: (id: string) =>
      request<void>(`/notifications/${encodeURIComponent(id)}/read`, { method: 'POST' }),
    markAllRead: () => request<void>('/notifications/read-all', { method: 'POST' }),
    remove: (id: string) =>
      request<void>(`/notifications/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    clearAll: () => request<void>('/notifications', { method: 'DELETE' }),
  },
};
