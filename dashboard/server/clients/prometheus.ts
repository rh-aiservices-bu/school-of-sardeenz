import type { Config } from '../config.js';
import { BffError } from '../errors.js';

export class PrometheusClient {
  private readonly baseUrl: string;

  constructor(config: Config) {
    this.baseUrl = config.prometheusUrl;
  }

  async queryRange(query: string, start: string, end: string, step: string): Promise<unknown> {
    const params = new URLSearchParams({ query, start, end, step });
    const url = `${this.baseUrl}/api/v1/query_range?${params.toString()}`;
    let res: Response;
    try {
      res = await fetch(url);
    } catch (cause) {
      throw new BffError(
        502,
        'PROMETHEUS_ERROR',
        'Prometheus unreachable',
        { cause: cause instanceof Error ? cause.message : String(cause) },
      );
    }
    if (!res.ok) {
      throw new BffError(502, 'PROMETHEUS_ERROR', `Prometheus returned ${res.status.toString()}`);
    }
    return res.json() as Promise<unknown>;
  }

  async queryInstant(query: string): Promise<unknown> {
    const params = new URLSearchParams({ query });
    const url = `${this.baseUrl}/api/v1/query?${params.toString()}`;
    let res: Response;
    try {
      res = await fetch(url);
    } catch (cause) {
      throw new BffError(
        502,
        'PROMETHEUS_ERROR',
        'Prometheus unreachable',
        { cause: cause instanceof Error ? cause.message : String(cause) },
      );
    }
    if (!res.ok) {
      throw new BffError(502, 'PROMETHEUS_ERROR', `Prometheus returned ${res.status.toString()}`);
    }
    return res.json() as Promise<unknown>;
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
