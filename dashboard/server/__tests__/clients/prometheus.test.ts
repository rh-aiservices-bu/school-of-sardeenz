// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrometheusClient } from '../../clients/prometheus.js';
import { ClientDisconnectedError } from '../../clients/upstream-signal.js';
import { BffError } from '../../errors.js';
import type { Config } from '../../config.js';

const baseConfig: Config = {
  listenAddr: '0.0.0.0',
  listenPort: 4000,
  logLevel: 'silent',
  controlPlaneUrl: 'http://cp.test',
  redisUrl: 'redis://localhost:6379',
  redisKeyPrefix: 'sardeenz',
  prometheusUrl: 'http://prom.test',
  prometheusBearerTokenPath: '',
  prometheusCaPath: '',
  prometheusTenantNamespace: '',
  inferenceUrl: 'http://inference.test',
  maxConcurrentInferenceRequestsPerUser: 4,
  upstreamTimeoutMs: 15_000,
  authMode: 'none',
  adminUsername: 'admin',
  adminPassword: '',
  jwtSecret: '',
  jwtExpirationHours: 8,
  oauthClientId: 'sardeenz',
  oauthClientSecret: '',
  oauthIssuerUrl: '',
  k8sApiUrl: '',
  namespace: 'sardeenz',
  controlPlaneApiToken: '',
  publicUrl: '',
  repoStatsUrl: '',
};

function makeFetchResponse(status: number, body: unknown = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}

const fetchSpy = vi.fn();

function firstCallUrl(): string {
  const call = fetchSpy.mock.calls[0];
  if (!call) return '';
  return String(call[0]);
}

function firstCallInit(): RequestInit & { dispatcher?: unknown } {
  const call = fetchSpy.mock.calls[0];
  if (!call || call.length < 2) return {};
  return (call[1] ?? {}) as RequestInit & { dispatcher?: unknown };
}

describe('PrometheusClient', () => {
  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal('fetch', fetchSpy);
  });

  describe('no auth / no tenancy configured', () => {
    it('sends no Authorization header and no namespace param on queries', async () => {
      const client = new PrometheusClient(baseConfig);
      fetchSpy.mockResolvedValue(makeFetchResponse(200, { data: 'ok' }));

      await client.queryInstant('up');

      expect(firstCallUrl()).toBe('http://prom.test/api/v1/query?query=up');
      expect(firstCallInit().headers).toEqual({});
    });

    it('adds the time param when provided', async () => {
      const client = new PrometheusClient(baseConfig);
      fetchSpy.mockResolvedValue(makeFetchResponse(200, { data: 'ok' }));

      await client.queryInstant('up', '2026-01-01T01:00:00Z');

      expect(firstCallUrl()).toBe(
        `http://prom.test/api/v1/query?query=up&time=${encodeURIComponent('2026-01-01T01:00:00Z')}`,
      );
    });

    it('omits the time param when not provided', async () => {
      const client = new PrometheusClient(baseConfig);
      fetchSpy.mockResolvedValue(makeFetchResponse(200, { data: 'ok' }));

      await client.queryInstant('up');

      expect(firstCallUrl()).not.toContain('time=');
    });

    it('uses /-/healthy for the health probe', async () => {
      const client = new PrometheusClient(baseConfig);
      fetchSpy.mockResolvedValue({ ok: true });

      const healthy = await client.isHealthy();

      expect(healthy).toBe(true);
      expect(firstCallUrl()).toBe('http://prom.test/-/healthy');
    });
  });

  describe('bearer token configured', () => {
    let tokenDir: string;
    let tokenPath: string;

    beforeEach(async () => {
      tokenDir = await mkdtemp(join(tmpdir(), 'prom-token-'));
      tokenPath = join(tokenDir, 'token');
      await writeFile(tokenPath, 'token-v1\n');
    });

    afterEach(async () => {
      await rm(tokenDir, { recursive: true, force: true });
    });

    it('sends the Authorization header on queries', async () => {
      const client = new PrometheusClient({ ...baseConfig, prometheusBearerTokenPath: tokenPath });
      fetchSpy.mockResolvedValue(makeFetchResponse(200));

      await client.queryInstant('up');

      expect(firstCallInit().headers).toEqual({ Authorization: 'Bearer token-v1' });
    });

    it('re-reads the token file on every request', async () => {
      const client = new PrometheusClient({ ...baseConfig, prometheusBearerTokenPath: tokenPath });
      fetchSpy.mockResolvedValue(makeFetchResponse(200));

      await client.queryInstant('up');
      expect(firstCallInit().headers).toEqual({ Authorization: 'Bearer token-v1' });

      await writeFile(tokenPath, 'token-v2\n');
      fetchSpy.mockClear();
      await client.queryInstant('up');

      expect(firstCallInit().headers).toEqual({ Authorization: 'Bearer token-v2' });
    });

    it('throws BffError 502 PROMETHEUS_ERROR when the token file is missing', async () => {
      const client = new PrometheusClient({
        ...baseConfig,
        prometheusBearerTokenPath: join(tokenDir, 'does-not-exist'),
      });

      await expect(client.queryInstant('up')).rejects.toMatchObject({
        statusCode: 502,
        code: 'PROMETHEUS_ERROR',
      });
      await expect(client.queryInstant('up')).rejects.toBeInstanceOf(BffError);
    });

    it('throws BffError 502 PROMETHEUS_ERROR when the token file is empty', async () => {
      await writeFile(tokenPath, '   \n');
      const client = new PrometheusClient({ ...baseConfig, prometheusBearerTokenPath: tokenPath });

      await expect(client.queryInstant('up')).rejects.toMatchObject({
        statusCode: 502,
        code: 'PROMETHEUS_ERROR',
      });
    });
  });

  describe('tenant namespace configured', () => {
    const configWithTenant: Config = {
      ...baseConfig,
      prometheusTenantNamespace: 'sardeenz',
    };

    it('adds the namespace param on queryRange', async () => {
      const client = new PrometheusClient(configWithTenant);
      fetchSpy.mockResolvedValue(makeFetchResponse(200));

      await client.queryRange('up', '0', '100', '15s');

      expect(firstCallUrl()).toContain('namespace=sardeenz');
      expect(firstCallUrl()).toContain('/api/v1/query_range');
    });

    it('adds the namespace param on queryInstant', async () => {
      const client = new PrometheusClient(configWithTenant);
      fetchSpy.mockResolvedValue(makeFetchResponse(200));

      await client.queryInstant('up');

      expect(firstCallUrl()).toContain('namespace=sardeenz');
    });

    it('uses the vector(1) query API endpoint for the health probe, with namespace', async () => {
      const client = new PrometheusClient(configWithTenant);
      fetchSpy.mockResolvedValue(makeFetchResponse(200));

      const healthy = await client.isHealthy();

      expect(healthy).toBe(true);
      expect(firstCallUrl()).toContain('/api/v1/query?');
      expect(firstCallUrl()).toContain('query=vector%281%29');
      expect(firstCallUrl()).toContain('namespace=sardeenz');
    });
  });

  describe('CA path configured', () => {
    let caDir: string;
    let caPath: string;

    beforeEach(async () => {
      caDir = await mkdtemp(join(tmpdir(), 'prom-ca-'));
      caPath = join(caDir, 'ca.crt');
      await writeFile(caPath, '-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n');
    });

    afterEach(async () => {
      await rm(caDir, { recursive: true, force: true });
    });

    it('passes a dispatcher on fetch calls', async () => {
      const client = new PrometheusClient({ ...baseConfig, prometheusCaPath: caPath });
      fetchSpy.mockResolvedValue(makeFetchResponse(200));

      await client.queryInstant('up');

      expect(firstCallInit().dispatcher).toBeDefined();
    });

    it('throws at construction when the CA file cannot be read', () => {
      expect(
        () => new PrometheusClient({ ...baseConfig, prometheusCaPath: join(caDir, 'missing.crt') }),
      ).toThrow();
    });
  });

  describe('non-OK responses', () => {
    it('throws a descriptive BffError including the status code', async () => {
      const client = new PrometheusClient(baseConfig);
      fetchSpy.mockResolvedValue(makeFetchResponse(503));

      await expect(client.queryInstant('up')).rejects.toMatchObject({
        statusCode: 502,
        code: 'PROMETHEUS_ERROR',
        message: 'Prometheus returned 503',
      });
    });
  });

  describe('upstream signal', () => {
    it('queryInstant passes the provided signal through to fetch', async () => {
      const client = new PrometheusClient(baseConfig);
      fetchSpy.mockResolvedValue(makeFetchResponse(200));
      const controller = new AbortController();

      await client.queryInstant('up', undefined, controller.signal);

      expect(firstCallInit().signal).toBe(controller.signal);
    });

    it('queryRange passes the provided signal through to fetch', async () => {
      const client = new PrometheusClient(baseConfig);
      fetchSpy.mockResolvedValue(makeFetchResponse(200));
      const controller = new AbortController();

      await client.queryRange('up', '0', '100', '15s', controller.signal);

      expect(firstCallInit().signal).toBe(controller.signal);
    });

    it('maps a TimeoutError abort to 504 UPSTREAM_TIMEOUT', async () => {
      const client = new PrometheusClient(baseConfig);
      fetchSpy.mockRejectedValue(
        new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
      );

      await expect(client.queryInstant('up')).rejects.toMatchObject({
        statusCode: 504,
        code: 'UPSTREAM_TIMEOUT',
        details: { service: 'prometheus' },
      });
    });

    it('rethrows ClientDisconnectedError untouched', async () => {
      const client = new PrometheusClient(baseConfig);
      const reason = new ClientDisconnectedError();
      fetchSpy.mockRejectedValue(reason);

      await expect(client.queryInstant('up')).rejects.toBe(reason);
    });

    it('maps a TimeoutError during the body read to 504 UPSTREAM_TIMEOUT', async () => {
      const client = new PrometheusClient(baseConfig);
      // The composed signal covers the body read: headers arrive, then the abort lands.
      fetchSpy.mockResolvedValue({
        ok: true,
        status: 200,
        json: () =>
          Promise.reject(
            new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
          ),
      });

      await expect(client.queryInstant('up')).rejects.toMatchObject({
        statusCode: 504,
        code: 'UPSTREAM_TIMEOUT',
        details: { service: 'prometheus' },
      });
    });

    it('rethrows a ClientDisconnectedError raised during the body read untouched', async () => {
      const client = new PrometheusClient(baseConfig);
      const reason = new ClientDisconnectedError();
      fetchSpy.mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.reject(reason),
      });

      await expect(client.queryInstant('up')).rejects.toBe(reason);
    });

    it('keeps a non-abort body-read fault a 502 PROMETHEUS_ERROR', async () => {
      const client = new PrometheusClient(baseConfig);
      fetchSpy.mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.reject(new SyntaxError('Unexpected token < in JSON')),
      });

      await expect(client.queryInstant('up')).rejects.toMatchObject({
        statusCode: 502,
        code: 'PROMETHEUS_ERROR',
        message: 'Prometheus returned a non-JSON response',
      });
    });

    it('isHealthy bare-fetch branch carries the timeout signal', async () => {
      // Emulate real fetch: a hung request rejects with the signal's abort reason.
      // (Promise.withResolvers is not in the ES2022 lib this project typechecks against.)
      fetchSpy.mockImplementation(
        (_url: string, init: RequestInit & { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener(
              'abort',
              () =>
                reject(
                  init.signal?.reason instanceof Error ? init.signal.reason : new Error('aborted'),
                ),
              { once: true },
            );
          }),
      );
      const client = new PrometheusClient({ ...baseConfig, upstreamTimeoutMs: 30 });

      await expect(client.isHealthy()).resolves.toBe(false);
      expect(firstCallInit().signal).toBeInstanceOf(AbortSignal);
    });
  });
});
