import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { Agent, type Dispatcher } from 'undici';
import type { Config } from '../config.js';
import { BffError, rethrowUpstreamAbort } from '../errors.js';

export class PrometheusClient {
  private readonly baseUrl: string;
  private readonly bearerTokenPath: string;
  private readonly tenantNamespace: string;
  private readonly upstreamTimeoutMs: number;
  private readonly dispatcher: Dispatcher | undefined;

  constructor(config: Config) {
    this.baseUrl = config.prometheusUrl;
    this.bearerTokenPath = config.prometheusBearerTokenPath;
    this.tenantNamespace = config.prometheusTenantNamespace;
    this.upstreamTimeoutMs = config.upstreamTimeoutMs;

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
  private fetchInit(headers?: Record<string, string>, signal?: AbortSignal): object {
    return {
      ...(headers ? { headers } : {}),
      ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
      ...(signal ? { signal } : {}),
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

  private async request(
    path: string,
    params: URLSearchParams,
    signal?: AbortSignal,
  ): Promise<unknown> {
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
      res = await fetch(url, this.fetchInit(headers, signal));
    } catch (cause) {
      rethrowUpstreamAbort(cause, 'prometheus');
      throw new BffError(502, 'PROMETHEUS_ERROR', 'Prometheus unreachable', {
        cause: cause instanceof Error ? cause.message : String(cause),
      });
    }
    if (!res.ok) {
      throw new BffError(502, 'PROMETHEUS_ERROR', `Prometheus returned ${res.status.toString()}`);
    }
    try {
      return (await res.json()) as unknown;
    } catch (cause) {
      // The composed signal covers the body read too: a timeout or client disconnect that
      // lands mid-body must keep its timeout/disconnect classification (as in the
      // control-plane client) rather than surfacing as an unhandled 500.
      rethrowUpstreamAbort(cause, 'prometheus');
      throw new BffError(502, 'PROMETHEUS_ERROR', 'Prometheus returned a non-JSON response', {
        status: res.status,
      });
    }
  }

  async queryRange(
    query: string,
    start: string,
    end: string,
    step: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const params = new URLSearchParams({ query, start, end, step });
    return this.request('/api/v1/query_range', params, signal);
  }

  async queryInstant(query: string, time?: string, signal?: AbortSignal): Promise<unknown> {
    const params = new URLSearchParams({ query });
    if (time !== undefined) {
      params.set('time', time);
    }
    return this.request('/api/v1/query', params, signal);
  }

  /**
   * Plain Prometheus serves `/-/healthy`; the Thanos Querier tenancy port does not, so when auth
   * or tenancy is configured the probe is a trivial authenticated instant query instead.
   */
  async isHealthy(): Promise<boolean> {
    try {
      // Server-initiated probe: timeout only, no browser client to disconnect.
      const signal = AbortSignal.timeout(this.upstreamTimeoutMs);
      if (this.bearerTokenPath || this.tenantNamespace) {
        await this.request('/api/v1/query', new URLSearchParams({ query: 'vector(1)' }), signal);
        return true;
      }
      const res = await fetch(`${this.baseUrl}/-/healthy`, this.fetchInit(undefined, signal));
      return res.ok;
    } catch {
      return false;
    }
  }
}
