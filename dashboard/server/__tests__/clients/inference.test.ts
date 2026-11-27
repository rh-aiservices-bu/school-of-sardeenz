// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InferenceClient } from '../../clients/inference.js';
import type { Config } from '../../config.js';

// `inferenceApiKey` is optional on Config, so the base literal omits it and
// each case opts in through the override.
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

function makeConfig(overrides: Partial<Config> = {}): Config {
  return { ...baseConfig, ...overrides };
}

function makeFetchResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}

const fetchSpy = vi.fn();

function firstCallUrl(): string {
  const firstCall = fetchSpy.mock.calls[0];
  if (!firstCall) return '';
  return String(firstCall[0]);
}

function firstCallInit(): RequestInit {
  const firstCall = fetchSpy.mock.calls[0];
  if (!firstCall || firstCall.length < 2) return {};
  return (firstCall[1] ?? {}) as RequestInit;
}

function firstCallHeaders(): Record<string, string> {
  return (firstCallInit().headers ?? {}) as Record<string, string>;
}

const KEY = 'test-shared-inference-key';

describe('InferenceClient', () => {
  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('chatCompletions', () => {
    it('attaches the Bearer key when the proxy key is configured', async () => {
      fetchSpy.mockResolvedValue(makeFetchResponse(200, {}));
      const client = new InferenceClient(makeConfig({ inferenceApiKey: KEY }));

      await client.chatCompletions({ model: 'm' }, new AbortController().signal);

      expect(firstCallUrl()).toBe('http://inference.test/openai/v1/chat/completions');
      expect(firstCallHeaders()).toEqual({
        'Content-Type': 'application/json',
        Authorization: `Bearer ${KEY}`,
      });
    });

    it('omits the Authorization header when the key is unset', async () => {
      fetchSpy.mockResolvedValue(makeFetchResponse(200, {}));
      const client = new InferenceClient(makeConfig());

      await client.chatCompletions({ model: 'm' }, new AbortController().signal);

      expect(firstCallHeaders()).toEqual({ 'Content-Type': 'application/json' });
    });

    it('omits the Authorization header when the key is empty', async () => {
      fetchSpy.mockResolvedValue(makeFetchResponse(200, {}));
      const client = new InferenceClient(makeConfig({ inferenceApiKey: '' }));

      await client.chatCompletions({ model: 'm' }, new AbortController().signal);

      expect(firstCallHeaders()['Authorization']).toBeUndefined();
    });
  });

  describe('isHealthy', () => {
    it('probes the inference-port model listing with the key when configured', async () => {
      fetchSpy.mockResolvedValue(makeFetchResponse(200, { data: [] }));
      const client = new InferenceClient(makeConfig({ inferenceApiKey: KEY }));

      await expect(client.isHealthy()).resolves.toBe(true);

      expect(firstCallUrl()).toBe('http://inference.test/openai/v1/models');
      expect(firstCallHeaders()['Authorization']).toBe(`Bearer ${KEY}`);
    });

    it('probes without a header when the key is unset', async () => {
      fetchSpy.mockResolvedValue(makeFetchResponse(200, { data: [] }));
      const client = new InferenceClient(makeConfig());

      await expect(client.isHealthy()).resolves.toBe(true);

      expect(firstCallHeaders()['Authorization']).toBeUndefined();
    });

    it('reports unhealthy on an upstream 401 without leaking the key', async () => {
      fetchSpy.mockResolvedValue(
        makeFetchResponse(401, { error: { type: 'authentication_error' } }),
      );
      const client = new InferenceClient(makeConfig({ inferenceApiKey: KEY }));

      await expect(client.isHealthy()).resolves.toBe(false);
    });
  });

  describe('rotation list', () => {
    it('presents only the first key of a two-key list on chatCompletions', async () => {
      fetchSpy.mockResolvedValue(makeFetchResponse(200, {}));
      const client = new InferenceClient(makeConfig({ inferenceApiKey: `${KEY},next-key` }));

      await client.chatCompletions({ model: 'm' }, new AbortController().signal);

      // Exactly one key — never the joined list, which matches no configured key.
      expect(firstCallHeaders()).toEqual({
        'Content-Type': 'application/json',
        Authorization: `Bearer ${KEY}`,
      });
    });

    it('presents only the first key of a two-key list on isHealthy', async () => {
      fetchSpy.mockResolvedValue(makeFetchResponse(200, { data: [] }));
      const client = new InferenceClient(makeConfig({ inferenceApiKey: `${KEY},next-key` }));

      await expect(client.isHealthy()).resolves.toBe(true);

      expect(firstCallHeaders()['Authorization']).toBe(`Bearer ${KEY}`);
    });

    it('trims whitespace around the chosen key', async () => {
      fetchSpy.mockResolvedValue(makeFetchResponse(200, { data: [] }));
      const client = new InferenceClient(makeConfig({ inferenceApiKey: `  ${KEY} , next-key  ` }));

      await client.isHealthy();

      expect(firstCallHeaders()['Authorization']).toBe(`Bearer ${KEY}`);
    });
  });

  describe('key confinement', () => {
    it('propagates a fetch failure without putting the key in the error message', async () => {
      fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'));
      const client = new InferenceClient(makeConfig({ inferenceApiKey: KEY }));

      try {
        await client.chatCompletions({ model: 'm' }, new AbortController().signal);
        expect.fail('should have thrown');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        expect(message).not.toContain(KEY);
      }

      // The header was sent (server-side) even though the call failed.
      expect(firstCallHeaders()['Authorization']).toBe(`Bearer ${KEY}`);
    });

    it('passes the proxy 401 envelope through untouched', async () => {
      const upstreamBody = {
        error: { message: 'missing or invalid inference API key', type: 'authentication_error' },
      };
      fetchSpy.mockResolvedValue(makeFetchResponse(401, upstreamBody));
      const client = new InferenceClient(makeConfig({ inferenceApiKey: KEY }));

      const res = await client.chatCompletions({ model: 'm' }, new AbortController().signal);

      expect(res.status).toBe(401);
      expect(JSON.stringify(await res.json())).not.toContain(KEY);
    });
  });
});
