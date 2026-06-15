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
    const init: RequestInit = {
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (body !== undefined) {
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
    const data: unknown = await res.json();
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
}
