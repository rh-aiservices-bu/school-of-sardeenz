import type { Config } from '../config.js';
import type { ControlPlaneComponents } from '@sardeenz/types';
import { BffError, rethrowUpstreamAbort } from '../errors.js';
import { getActor, getActorRoles, getRequestId } from '../request-context.js';

export interface ProxyResult {
  status: number;
  data: unknown;
}

export class ControlPlaneClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly upstreamTimeoutMs: number;

  constructor(config: Config) {
    this.baseUrl = config.controlPlaneUrl;
    this.token = config.controlPlaneApiToken;
    this.upstreamTimeoutMs = config.upstreamTimeoutMs;
  }

  async proxyRequest(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const init: RequestInit = { method };
    // Only send a JSON content-type when there is actually a body. Setting it on
    // bodyless requests (DELETE, sleep/wake, etc.) trips Fastify's default JSON
    // parser with FST_ERR_CTP_EMPTY_JSON_BODY on the control plane.
    if (body !== undefined) {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    if (this.token) {
      const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
      headers['Authorization'] = `Bearer ${this.token}`;
      init.headers = headers;
    }
    // Forward the identity the BFF verified so the control plane can attribute the action
    // (#335), and the request id for BFF↔control-plane correlation. Only non-GET requests: read
    // paths (including the SSE log stream) are untouched. The two headers are independent — with
    // `AUTH_MODE=none`, or on any unauthenticated path, there is no actor but correlation must
    // still work — so `x-request-id` is sent whenever the context has one; the control plane then
    // records `actor: "service"`.
    if (method !== 'GET') {
      const actor = getActor();
      const requestId = getRequestId();
      if (actor !== undefined || requestId !== undefined) {
        const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
        if (actor !== undefined) {
          headers['X-Sardeenz-Actor'] = actor;
          const roles = getActorRoles();
          if (roles) headers['X-Sardeenz-Actor-Roles'] = roles.join(',');
        }
        if (requestId) headers['x-request-id'] = requestId;
        init.headers = headers;
      }
    }
    // No timeout here on purpose: the model-logs route streams through this method and must
    // stay untimed. Buffered callers pass a composed signal from `request()`'s call sites.
    if (signal) {
      init.signal = signal;
    }
    return fetch(url, init);
  }

  async request(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<ProxyResult> {
    let res: Response;
    try {
      res = await this.proxyRequest(method, path, body, signal);
    } catch (cause) {
      rethrowUpstreamAbort(cause, 'control-plane');
      throw BffError.upstreamError('Control plane unreachable', {
        path,
        cause: cause instanceof Error ? cause.message : String(cause),
      });
    }
    // 204 and 205 responses are intentionally bodyless. Trying to decode them as JSON turns a
    // successful mutation into a spurious 502 at the BFF boundary.
    if (res.status === 204 || res.status === 205) {
      return { status: res.status, data: undefined };
    }
    let data: unknown;
    try {
      data = await res.json();
    } catch (cause) {
      // The composed signal covers the body read too: a timeout or client disconnect that
      // lands mid-body must keep its timeout/502-vs-disconnect classification.
      rethrowUpstreamAbort(cause, 'control-plane');
      throw BffError.upstreamError('Control plane returned non-JSON response', {
        path,
        status: res.status,
      });
    }
    return { status: res.status, data };
  }

  async listModels(state?: string, signal?: AbortSignal): Promise<ProxyResult> {
    const path = state ? `/api/v1/models?state=${encodeURIComponent(state)}` : '/api/v1/models';
    return this.request('GET', path, undefined, signal);
  }

  async getModel(name: string, signal?: AbortSignal): Promise<ProxyResult> {
    return this.request('GET', `/api/v1/models/${encodeURIComponent(name)}`, undefined, signal);
  }

  async deployModel(body: unknown, signal?: AbortSignal): Promise<ProxyResult> {
    return this.request('POST', '/api/v1/models', body, signal);
  }

  async updateModel(name: string, body: unknown, signal?: AbortSignal): Promise<ProxyResult> {
    return this.request('PUT', `/api/v1/models/${encodeURIComponent(name)}`, body, signal);
  }

  async deleteModel(name: string, force = false, signal?: AbortSignal): Promise<ProxyResult> {
    const query = force ? '?force=true' : '';
    return this.request(
      'DELETE',
      `/api/v1/models/${encodeURIComponent(name)}${query}`,
      undefined,
      signal,
    );
  }

  async sleepModel(name: string, signal?: AbortSignal): Promise<ProxyResult> {
    return this.request(
      'POST',
      `/api/v1/models/${encodeURIComponent(name)}/sleep`,
      undefined,
      signal,
    );
  }

  async wakeModel(name: string, signal?: AbortSignal): Promise<ProxyResult> {
    return this.request(
      'POST',
      `/api/v1/models/${encodeURIComponent(name)}/wake`,
      undefined,
      signal,
    );
  }

  async stopModel(name: string, force = false, signal?: AbortSignal): Promise<ProxyResult> {
    const query = force ? '?force=true' : '';
    return this.request(
      'POST',
      `/api/v1/models/${encodeURIComponent(name)}/stop${query}`,
      undefined,
      signal,
    );
  }

  async startModel(name: string, signal?: AbortSignal): Promise<ProxyResult> {
    return this.request(
      'POST',
      `/api/v1/models/${encodeURIComponent(name)}/start`,
      undefined,
      signal,
    );
  }

  async createInstance(name: string, signal?: AbortSignal): Promise<ProxyResult> {
    return this.request(
      'POST',
      `/api/v1/models/${encodeURIComponent(name)}/instances`,
      undefined,
      signal,
    );
  }

  async deleteInstance(
    name: string,
    instanceId: string,
    signal?: AbortSignal,
  ): Promise<ProxyResult> {
    return this.request(
      'DELETE',
      `/api/v1/models/${encodeURIComponent(name)}/instances/${encodeURIComponent(instanceId)}`,
      undefined,
      signal,
    );
  }

  async sleepInstance(
    name: string,
    instanceId: string,
    signal?: AbortSignal,
  ): Promise<ProxyResult> {
    return this.request(
      'POST',
      `/api/v1/models/${encodeURIComponent(name)}/instances/${encodeURIComponent(
        instanceId,
      )}/sleep`,
      undefined,
      signal,
    );
  }

  async wakeInstance(name: string, instanceId: string, signal?: AbortSignal): Promise<ProxyResult> {
    return this.request(
      'POST',
      `/api/v1/models/${encodeURIComponent(name)}/instances/${encodeURIComponent(instanceId)}/wake`,
      undefined,
      signal,
    );
  }

  async moveInstance(
    name: string,
    instanceId: string,
    body: ControlPlaneComponents['schemas']['MoveModelInstanceRequest'],
    signal?: AbortSignal,
  ): Promise<ProxyResult> {
    return this.request(
      'POST',
      `/api/v1/models/${encodeURIComponent(name)}/instances/${encodeURIComponent(instanceId)}/move`,
      body,
      signal,
    );
  }

  async browseWeights(path?: string, signal?: AbortSignal): Promise<ProxyResult> {
    const qs = path ? `?path=${encodeURIComponent(path)}` : '';
    return this.request('GET', `/api/v1/weights${qs}`, undefined, signal);
  }

  async listWorkers(signal?: AbortSignal): Promise<ProxyResult> {
    return this.request('GET', '/api/v1/workers', undefined, signal);
  }

  async getWorker(id: string, signal?: AbortSignal): Promise<ProxyResult> {
    return this.request('GET', `/api/v1/workers/${encodeURIComponent(id)}`, undefined, signal);
  }

  async getClusterStatus(signal?: AbortSignal): Promise<ProxyResult> {
    return this.request('GET', '/api/v1/cluster/status', undefined, signal);
  }

  async getClusterMemory(signal?: AbortSignal): Promise<ProxyResult> {
    return this.request('GET', '/api/v1/cluster/memory', undefined, signal);
  }

  // Health probes are server-initiated (no browser client to disconnect), so they only need
  // the timeout — a hung control plane must not stall /readyz for undici's ~300 s default.
  async isHealthy(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/healthz`, {
        signal: AbortSignal.timeout(this.upstreamTimeoutMs),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async listCatalog(signal?: AbortSignal): Promise<ProxyResult> {
    return this.request('GET', '/api/v1/catalog', undefined, signal);
  }

  async refreshCatalog(signal?: AbortSignal): Promise<ProxyResult> {
    return this.request('POST', '/api/v1/catalog/refresh', undefined, signal);
  }

  async importRunner(id: string, signal?: AbortSignal): Promise<ProxyResult> {
    return this.request(
      'POST',
      `/api/v1/catalog/${encodeURIComponent(id)}/import`,
      undefined,
      signal,
    );
  }

  async uninstallRunner(id: string, signal?: AbortSignal): Promise<ProxyResult> {
    return this.request('DELETE', `/api/v1/catalog/${encodeURIComponent(id)}`, undefined, signal);
  }

  async listNotifications(
    limit?: number,
    offset?: number,
    signal?: AbortSignal,
  ): Promise<ProxyResult> {
    const params = new URLSearchParams();
    if (limit !== undefined) params.set('limit', String(limit));
    if (offset !== undefined) params.set('offset', String(offset));
    const qs = params.toString();
    return this.request('GET', `/api/v1/notifications${qs ? `?${qs}` : ''}`, undefined, signal);
  }

  async markNotificationRead(id: string, signal?: AbortSignal): Promise<ProxyResult> {
    return this.request(
      'POST',
      `/api/v1/notifications/${encodeURIComponent(id)}/read`,
      undefined,
      signal,
    );
  }

  async markAllNotificationsRead(signal?: AbortSignal): Promise<ProxyResult> {
    return this.request('POST', '/api/v1/notifications/read-all', undefined, signal);
  }

  async removeNotification(id: string, signal?: AbortSignal): Promise<ProxyResult> {
    return this.request(
      'DELETE',
      `/api/v1/notifications/${encodeURIComponent(id)}`,
      undefined,
      signal,
    );
  }

  async clearAllNotifications(signal?: AbortSignal): Promise<ProxyResult> {
    return this.request('DELETE', '/api/v1/notifications', undefined, signal);
  }
}
