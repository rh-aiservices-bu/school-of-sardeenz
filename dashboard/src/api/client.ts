import { type ControlPlaneComponents } from '@sardeenz/types';
import type { ChatCompletionBody } from '../pages/Playground/types';
import { parseSseBuffer, extractDelta } from '../utils/parseSse';

type ModelInfo = ControlPlaneComponents['schemas']['ModelInfo'];
type ModelDetail = ControlPlaneComponents['schemas']['ModelDetail'];
type ModelDeploymentRequest = ControlPlaneComponents['schemas']['ModelDeploymentRequest'];
type MoveModelInstanceRequest = ControlPlaneComponents['schemas']['MoveModelInstanceRequest'];
type MoveModelInstanceResponse = ControlPlaneComponents['schemas']['MoveModelInstanceResponse'];
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
  type MoveModelInstanceRequest,
  type MoveModelInstanceResponse,
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

export interface ChatStreamCallbacks {
  onChunk: (delta: string) => void;
  onDone: (fullText: string) => void;
  onError: (err: ApiError | Error) => void;
}

// A `fetch` abort surfaces as a `DOMException` named 'AbortError', NOT an `Error` instance — so
// `err instanceof Error` alone misses it. Check `.name` directly regardless of the error's type.
function isAbortError(err: unknown): boolean {
  return (err as { name?: unknown } | null)?.name === 'AbortError';
}

/**
 * Streams a chat completion from `POST /api/inference/chat/completions`. Cannot go through
 * `request()`, which always calls `res.json()` — the response here is an SSE stream read
 * incrementally via `fetch` + a manual reader (EventSource is GET-only and cannot send a body or
 * an Authorization header).
 *
 * On a real 401 the token is cleared and `auth:unauthorized` is dispatched, same as `request()`.
 * On any other failure — including an aborted generation — only `onError` fires; an aborted
 * generation must NOT log the user out.
 */
export async function streamChatCompletion(
  body: ChatCompletionBody,
  callbacks: ChatStreamCallbacks,
  signal: AbortSignal,
): Promise<void> {
  const { onChunk, onDone, onError } = callbacks;

  let res: Response;
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const token = getToken();
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    res = await fetch(`${BASE_URL}/inference/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...body, stream: true }),
      signal,
    });
  } catch (err) {
    if (isAbortError(err)) return;
    onError(err instanceof Error ? err : new Error(String(err)));
    return;
  }

  if (res.status === 401) {
    try {
      sessionStorage.removeItem(SESSION_KEY);
    } catch {
      /* ignore */
    }
    window.dispatchEvent(new Event('auth:unauthorized'));
    onError(new ApiError(401, 'Unauthorized', 'UNAUTHORIZED'));
    return;
  }

  if (!res.ok || !res.body) {
    let errorMessage = `HTTP ${res.status}`;
    let code: string | undefined;
    let details: Record<string, unknown> | undefined;
    try {
      const errBody = (await res.json()) as ErrorResponse;
      errorMessage = errBody.error ?? errorMessage;
      code = errBody.code;
      details = errBody.details;
    } catch {
      // Ignore parse errors
    }
    onError(new ApiError(res.status, errorMessage, code, details));
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const fullText: string[] = [];
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const { rest, events } = parseSseBuffer(buffer);
      buffer = rest;

      for (const line of events) {
        const { content, done: isDone } = extractDelta(line);
        if (isDone) {
          onDone(fullText.join(''));
          return;
        }
        if (content) {
          fullText.push(content);
          onChunk(content);
        }
      }
    }
    onDone(fullText.join(''));
  } catch (err) {
    if (isAbortError(err)) return;
    onError(err instanceof Error ? err : new Error(String(err)));
  }
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
    createInstance: (name: string) =>
      request<unknown>(`/models/${encodeURIComponent(name)}/instances`, { method: 'POST' }),
    deleteInstance: (name: string, instanceId: string) =>
      request<unknown>(
        `/models/${encodeURIComponent(name)}/instances/${encodeURIComponent(instanceId)}`,
        { method: 'DELETE' },
      ),
    sleepInstance: (name: string, instanceId: string) =>
      request<unknown>(
        `/models/${encodeURIComponent(name)}/instances/${encodeURIComponent(instanceId)}/sleep`,
        { method: 'POST' },
      ),
    wakeInstance: (name: string, instanceId: string) =>
      request<unknown>(
        `/models/${encodeURIComponent(name)}/instances/${encodeURIComponent(instanceId)}/wake`,
        { method: 'POST' },
      ),
    moveInstance: (name: string, instanceId: string, body: MoveModelInstanceRequest) =>
      request<MoveModelInstanceResponse>(
        `/models/${encodeURIComponent(name)}/instances/${encodeURIComponent(instanceId)}/move`,
        { method: 'POST', body: JSON.stringify(body) },
      ),
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
  inference: {
    chat: (body: ChatCompletionBody, callbacks: ChatStreamCallbacks, signal: AbortSignal) =>
      streamChatCompletion(body, callbacks, signal),
  },
  config: {
    get: (signal?: AbortSignal) => request<{ inferenceUrl: string }>('/config', { signal }),
  },
};
