import type { Config } from '../config.js';
import { BffError } from '../errors.js';

export interface ProxyResult {
  status: number;
  data: unknown;
}

export class ControlPlaneClient {
  private readonly baseUrl: string;

  constructor(config: Config) {
    this.baseUrl = config.controlPlaneUrl;
  }

  async proxyRequest(method: string, path: string, body?: unknown): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const init: RequestInit = { method };
    // Only send a JSON content-type when there is actually a body. Setting it on
    // bodyless requests (DELETE, sleep/wake, etc.) trips Fastify's default JSON
    // parser with FST_ERR_CTP_EMPTY_JSON_BODY on the control plane.
    if (body !== undefined) {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    return fetch(url, init);
  }

  private async request(method: string, path: string, body?: unknown): Promise<ProxyResult> {
    let res: Response;
    try {
      res = await this.proxyRequest(method, path, body);
    } catch (cause) {
      throw BffError.upstreamError('Control plane unreachable', {
        path,
        cause: cause instanceof Error ? cause.message : String(cause),
      });
    }
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      throw BffError.upstreamError('Control plane returned non-JSON response', {
        path,
        status: res.status,
      });
    }
    return { status: res.status, data };
  }

  async listModels(state?: string): Promise<ProxyResult> {
    const path = state ? `/api/v1/models?state=${encodeURIComponent(state)}` : '/api/v1/models';
    return this.request('GET', path);
  }

  async getModel(name: string): Promise<ProxyResult> {
    return this.request('GET', `/api/v1/models/${encodeURIComponent(name)}`);
  }

  async deployModel(body: unknown): Promise<ProxyResult> {
    return this.request('POST', '/api/v1/models', body);
  }

  async deleteModel(name: string): Promise<ProxyResult> {
    return this.request('DELETE', `/api/v1/models/${encodeURIComponent(name)}`);
  }

  async sleepModel(name: string): Promise<ProxyResult> {
    return this.request('POST', `/api/v1/models/${encodeURIComponent(name)}/sleep`);
  }

  async wakeModel(name: string): Promise<ProxyResult> {
    return this.request('POST', `/api/v1/models/${encodeURIComponent(name)}/wake`);
  }

  async browseWeights(path?: string): Promise<ProxyResult> {
    const qs = path ? `?path=${encodeURIComponent(path)}` : '';
    return this.request('GET', `/api/v1/weights${qs}`);
  }

  async listWorkers(): Promise<ProxyResult> {
    return this.request('GET', '/api/v1/workers');
  }

  async getWorker(id: string): Promise<ProxyResult> {
    return this.request('GET', `/api/v1/workers/${encodeURIComponent(id)}`);
  }

  async getClusterStatus(): Promise<ProxyResult> {
    return this.request('GET', '/api/v1/cluster/status');
  }

  async getClusterMemory(): Promise<ProxyResult> {
    return this.request('GET', '/api/v1/cluster/memory');
  }

  async isHealthy(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/healthz`);
      return res.ok;
    } catch {
      return false;
    }
  }

  async listCatalog(): Promise<ProxyResult> {
    return this.request('GET', '/api/v1/catalog');
  }

  async refreshCatalog(): Promise<ProxyResult> {
    return this.request('POST', '/api/v1/catalog/refresh');
  }

  async importRunner(id: string): Promise<ProxyResult> {
    return this.request('POST', `/api/v1/catalog/${encodeURIComponent(id)}/import`);
  }

  async uninstallRunner(id: string): Promise<ProxyResult> {
    return this.request('DELETE', `/api/v1/catalog/${encodeURIComponent(id)}`);
  }

  async listNotifications(limit?: number, offset?: number): Promise<ProxyResult> {
    const params = new URLSearchParams();
    if (limit !== undefined) params.set('limit', String(limit));
    if (offset !== undefined) params.set('offset', String(offset));
    const qs = params.toString();
    return this.request('GET', `/api/v1/notifications${qs ? `?${qs}` : ''}`);
  }

  async markNotificationRead(id: string): Promise<ProxyResult> {
    return this.request('POST', `/api/v1/notifications/${encodeURIComponent(id)}/read`);
  }

  async markAllNotificationsRead(): Promise<ProxyResult> {
    return this.request('POST', '/api/v1/notifications/read-all');
  }

  async removeNotification(id: string): Promise<ProxyResult> {
    return this.request('DELETE', `/api/v1/notifications/${encodeURIComponent(id)}`);
  }

  async clearAllNotifications(): Promise<ProxyResult> {
    return this.request('DELETE', '/api/v1/notifications');
  }
}
