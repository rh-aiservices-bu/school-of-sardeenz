import type { Config } from '../config.js';

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

  async isHealthy(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/healthz`);
      return res.ok;
    } catch {
      return false;
    }
  }
}
