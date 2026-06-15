import type { Config } from '../config.js';

export class PrometheusClient {
  private readonly baseUrl: string;

  constructor(config: Config) {
    this.baseUrl = config.prometheusUrl;
  }

  async isHealthy(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/-/healthy`);
      return res.ok;
    } catch {
      return false;
    }
  }
}
