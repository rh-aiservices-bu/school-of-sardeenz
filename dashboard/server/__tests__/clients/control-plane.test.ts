// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ControlPlaneClient } from '../../clients/control-plane.js';
import { ClientDisconnectedError } from '../../clients/upstream-signal.js';
import { BffError } from '../../errors.js';
import type { Config } from '../../config.js';

const mockConfig: Config = {
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

function makeFetchResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}

// Helpers to extract typed call args from fetch spy
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

describe('ControlPlaneClient', () => {
  let client: ControlPlaneClient;

  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal('fetch', fetchSpy);
    client = new ControlPlaneClient(mockConfig);
  });

  describe('listModels', () => {
    it('returns status and data on success', async () => {
      const payload = { models: [{ modelName: 'test-model', state: 'ACTIVE' }] };
      fetchSpy.mockResolvedValue(makeFetchResponse(200, payload));

      const result = await client.listModels();

      expect(result.status).toBe(200);
      expect(result.data).toEqual(payload);
    });

    it('includes state query param when provided', async () => {
      fetchSpy.mockResolvedValue(makeFetchResponse(200, { models: [] }));

      await client.listModels('ACTIVE');

      expect(firstCallUrl()).toContain('state=ACTIVE');
    });

    it('throws BffError when network fails', async () => {
      fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(client.listModels()).rejects.toBeInstanceOf(BffError);
    });

    it('thrown BffError has UPSTREAM_ERROR code and 502 status', async () => {
      fetchSpy.mockRejectedValue(new Error('network timeout'));

      try {
        await client.listModels();
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(BffError);
        const bffErr = err as BffError;
        expect(bffErr.code).toBe('UPSTREAM_ERROR');
        expect(bffErr.statusCode).toBe(502);
      }
    });
  });

  describe('getModel', () => {
    it('proxies to the correct path', async () => {
      fetchSpy.mockResolvedValue(makeFetchResponse(200, { modelName: 'llama', state: 'ACTIVE' }));

      await client.getModel('llama');

      expect(firstCallUrl()).toBe('http://cp.test/api/v1/models/llama');
    });

    it('URL-encodes model names with special characters', async () => {
      fetchSpy.mockResolvedValue(makeFetchResponse(200, {}));

      await client.getModel('meta-llama/Llama-3.1-8B');

      expect(firstCallUrl()).toContain(encodeURIComponent('meta-llama/Llama-3.1-8B'));
    });
  });

  describe('moveInstance', () => {
    it('encodes both path segments and sends the explicit target body', async () => {
      fetchSpy.mockResolvedValue(makeFetchResponse(202, {}));
      await client.moveInstance('org/model', 'inst/a', {
        targetWorkerId: 'worker-2',
        targetDeviceIndices: [1],
      });
      expect(firstCallUrl()).toBe(
        'http://cp.test/api/v1/models/org%2Fmodel/instances/inst%2Fa/move',
      );
      expect(firstCallInit().method).toBe('POST');
      expect(firstCallInit().body).toBe(
        JSON.stringify({ targetWorkerId: 'worker-2', targetDeviceIndices: [1] }),
      );
    });
  });

  describe('browseWeights', () => {
    it('lists the weights root with no path query', async () => {
      fetchSpy.mockResolvedValue(makeFetchResponse(200, { root: '/weights', entries: [] }));

      await client.browseWeights();

      expect(firstCallUrl()).toBe('http://cp.test/api/v1/weights');
      expect(firstCallInit().method).toBe('GET');
    });

    it('URL-encodes the relative path query', async () => {
      fetchSpy.mockResolvedValue(makeFetchResponse(200, { entries: [] }));

      await client.browseWeights('org-a/model x');

      expect(firstCallUrl()).toBe(
        `http://cp.test/api/v1/weights?path=${encodeURIComponent('org-a/model x')}`,
      );
    });
  });

  describe('deployModel', () => {
    it('sends POST with body', async () => {
      fetchSpy.mockResolvedValue(makeFetchResponse(202, { modelName: 'test', state: 'PENDING' }));

      const body = {
        modelName: 'test',
        runnerType: 'vllm',
        modelPath: '/models/test',
        requiredMemory: 8192,
        tensorParallel: 1,
        pinned: false,
      };
      await client.deployModel(body);

      expect(firstCallInit().method).toBe('POST');
      expect(firstCallInit().body).toBe(JSON.stringify(body));
    });

    it('sets JSON content-type on bodied requests', async () => {
      fetchSpy.mockResolvedValue(makeFetchResponse(202, {}));

      await client.deployModel({ modelName: 'test' });

      expect(firstCallInit().headers).toEqual({ 'Content-Type': 'application/json' });
    });
  });

  describe('deleteModel', () => {
    it('sends DELETE without a body or JSON content-type', async () => {
      // Regression: a JSON content-type on a bodyless request trips Fastify's
      // default parser (FST_ERR_CTP_EMPTY_JSON_BODY) on the control plane.
      fetchSpy.mockResolvedValue(makeFetchResponse(200, {}));

      await client.deleteModel('meta-llama/Llama-3.1-8B');

      expect(firstCallUrl()).toContain(encodeURIComponent('meta-llama/Llama-3.1-8B'));
      expect(firstCallInit().method).toBe('DELETE');
      expect(firstCallInit().body).toBeUndefined();
      expect(firstCallInit().headers).toBeUndefined();
    });

    it('adds the explicit force query without adding a request body', async () => {
      fetchSpy.mockResolvedValue(makeFetchResponse(202, {}));

      await client.deleteModel('stalled/model', true);

      expect(firstCallUrl()).toContain(`${encodeURIComponent('stalled/model')}?force=true`);
      expect(firstCallInit().method).toBe('DELETE');
      expect(firstCallInit().body).toBeUndefined();
    });
  });

  describe('updateModel', () => {
    it('sends the replacement configuration with PUT', async () => {
      fetchSpy.mockResolvedValue(makeFetchResponse(200, {}));
      const body = { runnerType: 'vllm', modelPath: '/weights/m', requiredMemory: 1 };

      await client.updateModel('org/model', body);

      expect(firstCallUrl()).toContain(encodeURIComponent('org/model'));
      expect(firstCallInit().method).toBe('PUT');
      expect(firstCallInit().body).toBe(JSON.stringify(body));
    });
  });

  describe('stopModel', () => {
    it('adds the force query for a failed-runtime reset', async () => {
      fetchSpy.mockResolvedValue(makeFetchResponse(202, {}));

      await client.stopModel('org/model', true);

      expect(firstCallUrl()).toContain(`${encodeURIComponent('org/model')}/stop?force=true`);
      expect(firstCallInit().method).toBe('POST');
    });
  });

  describe('uninstallRunner', () => {
    it('accepts a successful 204 response without trying to parse JSON', async () => {
      const json = vi.fn(() => Promise.reject(new SyntaxError('Unexpected end of JSON input')));
      fetchSpy.mockResolvedValue({ ok: true, status: 204, json });

      await expect(client.uninstallRunner('vllm-0.21')).resolves.toEqual({
        status: 204,
        data: undefined,
      });
      expect(json).not.toHaveBeenCalled();
    });
  });

  describe('isHealthy', () => {
    it('returns true when /healthz responds ok', async () => {
      fetchSpy.mockResolvedValue({ ok: true });

      const result = await client.isHealthy();

      expect(result).toBe(true);
    });

    it('returns false when /healthz responds with error status', async () => {
      fetchSpy.mockResolvedValue({ ok: false });

      const result = await client.isHealthy();

      expect(result).toBe(false);
    });

    it('returns false on network error', async () => {
      fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'));

      const result = await client.isHealthy();

      expect(result).toBe(false);
    });

    it('passes a timeout signal and reports unhealthy when the probe hangs', async () => {
      // Emulate real fetch: a hung request rejects with the signal's abort reason.
      // (Promise.withResolvers is not in the ES2022 lib this project typechecks against.)
      fetchSpy.mockImplementation(
        (_url: string, init: RequestInit) =>
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
      const slowClient = new ControlPlaneClient({ ...mockConfig, upstreamTimeoutMs: 30 });

      await expect(slowClient.isHealthy()).resolves.toBe(false);
      expect(firstCallInit().signal).toBeInstanceOf(AbortSignal);
    });
  });

  describe('upstream signal', () => {
    it('request() passes the provided signal to fetch', async () => {
      fetchSpy.mockResolvedValue(makeFetchResponse(200, { models: [] }));
      const controller = new AbortController();

      await client.request('GET', '/api/v1/models', undefined, controller.signal);

      expect(firstCallInit().signal).toBe(controller.signal);
    });

    it('request() with no signal does not set one', async () => {
      // The model-logs route streams through proxyRequest without a signal; the optional
      // parameter must not leak a default timeout onto that path.
      fetchSpy.mockResolvedValue(makeFetchResponse(200, { models: [] }));

      await client.listModels();

      expect(firstCallInit().signal).toBeUndefined();
    });

    it('proxyRequest() with a signal passes it through', async () => {
      fetchSpy.mockResolvedValue(makeFetchResponse(200, {}));
      const controller = new AbortController();

      await client.proxyRequest('GET', '/api/v1/models', undefined, controller.signal);

      expect(firstCallInit().signal).toBe(controller.signal);
    });

    it('request() maps a TimeoutError abort to 504 UPSTREAM_TIMEOUT', async () => {
      fetchSpy.mockRejectedValue(
        new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
      );

      await expect(client.request('GET', '/api/v1/models')).rejects.toMatchObject({
        statusCode: 504,
        code: 'UPSTREAM_TIMEOUT',
        details: { service: 'control-plane' },
      });
    });

    it('request() rethrows ClientDisconnectedError untouched', async () => {
      const reason = new ClientDisconnectedError();
      fetchSpy.mockRejectedValue(reason);

      await expect(client.request('GET', '/api/v1/models')).rejects.toBe(reason);
    });
  });
});
