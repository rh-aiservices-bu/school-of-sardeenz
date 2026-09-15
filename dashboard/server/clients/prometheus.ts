import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { Agent, type Dispatcher } from 'undici';
import type { Config } from '../config.js';
import { BffError } from '../errors.js';

export class PrometheusClient {
  private readonly baseUrl: string;
  private readonly bearerTokenPath: string;
  private readonly tenantNamespace: string;
  private readonly dispatcher: Dispatcher | undefined;

  constructor(config: Config) {
    this.baseUrl = config.prometheusUrl;
    this.bearerTokenPath = config.prometheusBearerTokenPath;
    this.tenantNamespace = config.prometheusTenantNamespace;

    if (config.prometheusCaPath) {
      let ca: string;
      try {
        ca = readFileSync(config.prometheusCaPath, 'utf8');
      } catch (cause) {
        throw new Error(
          `Failed to read SARDEENZ_PROMETHEUS_CA_PATH (${config.prometheusCaPath}): ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
        );
      }
      this.dispatcher = new Agent({ connect: { ca } });
    }
  }

  /**
   * Builds fetch init with an optional dispatcher. undici's `dispatcher` fetch option is not
   * part of the DOM RequestInit type; spreading it in (rather than assigning it as a property on
   * a `RequestInit`-typed object) sidesteps TypeScript's excess-property check without a cast.
   */
  private fetchInit(headers?: Record<string, string>): object {
    return {
      ...(headers ? { headers } : {}),
      ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
    };
  }

  /** Reads the bearer token fresh on every call: projected ServiceAccount tokens rotate. */
  private async bearerToken(): Promise<string> {
    let token: string;
    try {
      token = (await readFile(this.bearerTokenPath, 'utf8')).trim();
    } catch (cause) {
      throw new BffError(502, 'PROMETHEUS_ERROR', 'Prometheus bearer token unavailable', {
        cause: cause instanceof Error ? cause.message : String(cause),
      });
    }
    if (!token) {
      throw new BffError(502, 'PROMETHEUS_ERROR', 'Prometheus bearer token unavailable', {
        cause: 'token file is empty',
      });
    }
    return token;
  }

  private async request(path: string, params: URLSearchParams): Promise<unknown> {
    if (this.tenantNamespace) {
      params.set('namespace', this.tenantNamespace);
    }

    const headers: Record<string, string> = {};
    if (this.bearerTokenPath) {
      headers['Authorization'] = `Bearer ${await this.bearerToken()}`;
    }

    const url = `${this.baseUrl}${path}?${params.toString()}`;
    let res: Response;
    try {
      res = await fetch(url, this.fetchInit(headers));
    } catch (cause) {
      throw new BffError(502, 'PROMETHEUS_ERROR', 'Prometheus unreachable', {
        cause: cause instanceof Error ? cause.message : String(cause),
      });
    }
    if (!res.ok) {
      throw new BffError(502, 'PROMETHEUS_ERROR', `Prometheus returned ${res.status.toString()}`);
    }
    return res.json() as Promise<unknown>;
  }

  async queryRange(query: string, start: string, end: string, step: string): Promise<unknown> {
    const params = new URLSearchParams({ query, start, end, step });
    return this.request('/api/v1/query_range', params);
  }

  async queryInstant(query: string, time?: string): Promise<unknown> {
    const params = new URLSearchParams({ query });
    if (time !== undefined) {
      params.set('time', time);
    }
    return this.request('/api/v1/query', params);
  }

  /**
   * Plain Prometheus serves `/-/healthy`; the Thanos Querier tenancy port does not, so when auth
   * or tenancy is configured the probe is a trivial authenticated instant query instead.
   */
  async isHealthy(): Promise<boolean> {
    try {
      if (this.bearerTokenPath || this.tenantNamespace) {
        await this.request('/api/v1/query', new URLSearchParams({ query: 'vector(1)' }));
        return true;
      }
      const res = await fetch(`${this.baseUrl}/-/healthy`, this.fetchInit());
      return res.ok;
    } catch {
      return false;
    }
  }
}
