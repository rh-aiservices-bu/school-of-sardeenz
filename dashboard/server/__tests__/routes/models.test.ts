// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { request as httpRequest } from 'node:http';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { registerModelRoutes } from '../../routes/models.js';
import { authPlugin } from '../../plugins/auth.js';
import { ClientDisconnectedError } from '../../clients/upstream-signal.js';
import { BffError } from '../../errors.js';
import type { RouteDeps } from '../../routes/deps.js';
import type { Config } from '../../config.js';
import { ModelLifecycleState } from '@sardeenz/types';
import type { ControlPlaneComponents } from '@sardeenz/types';

type ModelInfo = ControlPlaneComponents['schemas']['ModelInfo'];

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

const sampleModel: ModelInfo = {
  modelName: 'llama-3',
  state: ModelLifecycleState.ACTIVE,
  runnerType: 'vllm',
  instanceCount: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
};

// Named mock functions kept at module scope to avoid unbound-method issues.
const listModelsFn = vi.fn();
const getModelFn = vi.fn();
const deployModelFn = vi.fn();
const moveInstanceFn = vi.fn();
const listRedisModelsFn = vi.fn();
const getRedisModelFn = vi.fn();

function buildDeps(): RouteDeps {
  return {
    config: mockConfig,
    controlPlane: {
      proxyRequest: vi.fn(),
      listModels: listModelsFn,
      getModel: getModelFn,
      deployModel: deployModelFn,
      moveInstance: moveInstanceFn,
      deleteModel: vi.fn(),
      sleepModel: vi.fn(),
      wakeModel: vi.fn(),
      listWorkers: vi.fn(),
      getWorker: vi.fn(),
      getClusterStatus: vi.fn(),
      getClusterMemory: vi.fn(),
      isHealthy: vi.fn(),
    } as unknown as RouteDeps['controlPlane'],
    redis: {
      listModels: listRedisModelsFn,
      getModel: getRedisModelFn,
      getModelNames: vi.fn(),
      listWorkers: vi.fn(),
      getClusterStatus: vi.fn(),
      createSubscriber: vi.fn(),
      isHealthy: vi.fn(),
      keyPrefix: 'sardeenz',
      close: vi.fn(),
    } as unknown as RouteDeps['redis'],
    prometheus: {
      queryRange: vi.fn(),
      queryInstant: vi.fn(),
      isHealthy: vi.fn(),
    } as unknown as RouteDeps['prometheus'],
    inference: {
      chatCompletions: vi.fn(),
      isHealthy: vi.fn(),
    } as unknown as RouteDeps['inference'],
    githubRepoStats: {
      getStats: () => Promise.resolve({ stars: null, forks: null, fetchedAt: null }),
      setLogger: () => {},
    } as unknown as RouteDeps['githubRepoStats'],
  };
}

async function buildApp(deps: RouteDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof BffError) {
      return reply.code(error.statusCode).send(error.toResponse());
    }
    return reply.code(500).send({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });
  await app.register(authPlugin, { config: mockConfig });
  registerModelRoutes(app, deps);
  await app.ready();
  return app;
}

describe('GET /api/models', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('proxies to control plane and returns the response on success', async () => {
    listModelsFn.mockResolvedValue({ status: 200, data: { models: [sampleModel] } });

    const app = await buildApp(buildDeps());
    const res = await app.inject({ method: 'GET', url: '/api/models' });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ models: [{ modelName: 'llama-3' }] });
    expect(listRedisModelsFn).not.toHaveBeenCalled();
  });

  it('passes state query parameter to control plane', async () => {
    listModelsFn.mockResolvedValue({ status: 200, data: { models: [] } });

    const app = await buildApp(buildDeps());
    await app.inject({ method: 'GET', url: '/api/models?state=ACTIVE' });
    await app.close();

    expect(listModelsFn).toHaveBeenCalledWith('ACTIVE', expect.any(AbortSignal));
  });

  it('falls back to Redis when control plane throws', async () => {
    listModelsFn.mockRejectedValue(BffError.upstreamError('Control plane down'));
    listRedisModelsFn.mockResolvedValue([sampleModel]);

    const app = await buildApp(buildDeps());
    const res = await app.inject({ method: 'GET', url: '/api/models' });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      source: 'redis-fallback',
      models: [{ modelName: 'llama-3' }],
    });
  });
});

describe('GET /api/models/:name', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('proxies to control plane and returns the model on success', async () => {
    getModelFn.mockResolvedValue({ status: 200, data: sampleModel });

    const app = await buildApp(buildDeps());
    const res = await app.inject({ method: 'GET', url: '/api/models/llama-3' });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ modelName: 'llama-3' });
  });

  it('falls back to Redis when control plane throws', async () => {
    getModelFn.mockRejectedValue(BffError.upstreamError('Control plane down'));
    getRedisModelFn.mockResolvedValue(sampleModel);

    const app = await buildApp(buildDeps());
    const res = await app.inject({ method: 'GET', url: '/api/models/llama-3' });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ source: 'redis-fallback', modelName: 'llama-3' });
  });

  it('returns 404 when Redis also has no model', async () => {
    getModelFn.mockRejectedValue(BffError.upstreamError('Control plane down'));
    getRedisModelFn.mockResolvedValue(null);

    const app = await buildApp(buildDeps());
    const res = await app.inject({ method: 'GET', url: '/api/models/unknown-model' });
    await app.close();

    expect(res.statusCode).toBe(404);
  });
});

describe('POST /api/models', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('proxies deploy request to control plane without Redis fallback', async () => {
    deployModelFn.mockResolvedValue({
      status: 202,
      data: { modelName: 'llama-3', state: ModelLifecycleState.PENDING },
    });

    const app = await buildApp(buildDeps());
    const payload = {
      modelName: 'llama-3',
      runnerType: 'vllm',
      modelPath: '/models/llama',
      requiredMemory: 8589934592,
      tensorParallel: 1,
      pinned: false,
    };
    const res = await app.inject({ method: 'POST', url: '/api/models', payload });
    await app.close();

    expect(res.statusCode).toBe(202);
    expect(listRedisModelsFn).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/models/:name', () => {
  beforeEach(() => vi.clearAllMocks());

  it('forwards the explicit force flag to the control plane', async () => {
    const deps = buildDeps();
    const deleteModel = vi.fn();
    Object.assign(deps.controlPlane, { deleteModel });
    deleteModel.mockResolvedValue({ status: 202, data: { modelName: 'stalled/model' } });
    const app = await buildApp(deps);

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/models/stalled%2Fmodel?force=true',
    });
    await app.close();

    expect(res.statusCode).toBe(202);
    expect(deleteModel).toHaveBeenCalledWith('stalled/model', true, expect.any(AbortSignal));
  });
});

describe('PUT /api/models/:name', () => {
  beforeEach(() => vi.clearAllMocks());

  it('proxies a configuration replacement to the control plane', async () => {
    const deps = buildDeps();
    const updateModel = vi
      .fn()
      .mockResolvedValue({ status: 200, data: { modelName: 'org/model' } });
    Object.assign(deps.controlPlane, { updateModel });
    const app = await buildApp(deps);
    const payload = {
      runnerType: 'vllm',
      modelPath: '/weights/m',
      requiredMemory: 1024,
      tensorParallel: 1,
      pinned: false,
    };

    const res = await app.inject({
      method: 'PUT',
      url: '/api/models/org%2Fmodel',
      payload,
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(updateModel).toHaveBeenCalledWith('org/model', payload, expect.any(AbortSignal));
  });
});

describe('POST /api/models/:name/stop', () => {
  beforeEach(() => vi.clearAllMocks());

  it('forwards the force-reset flag to the control plane', async () => {
    const deps = buildDeps();
    const stopModel = vi.fn().mockResolvedValue({ status: 202, data: { state: 'STOPPED' } });
    Object.assign(deps.controlPlane, { stopModel });
    const app = await buildApp(deps);

    const res = await app.inject({
      method: 'POST',
      url: '/api/models/org%2Fmodel/stop?force=true',
    });
    await app.close();

    expect(res.statusCode).toBe(202);
    expect(stopModel).toHaveBeenCalledWith('org/model', true, expect.any(AbortSignal));
  });
});

describe('POST /api/models/:name/instances/:instanceId/move', () => {
  beforeEach(() => vi.clearAllMocks());

  it('proxies the encoded target and body without a Redis fallback', async () => {
    moveInstanceFn.mockResolvedValue({
      status: 202,
      data: { modelName: 'org/model', sourceInstanceId: 'inst/a', replacementInstanceId: 'inst-b' },
    });
    const app = await buildApp(buildDeps());
    const res = await app.inject({
      method: 'POST',
      url: '/api/models/org%2Fmodel/instances/inst%2Fa/move',
      payload: { targetWorkerId: 'worker-2', targetDeviceIndices: [1] },
    });
    await app.close();
    expect(res.statusCode).toBe(202);
    expect(moveInstanceFn).toHaveBeenCalledWith(
      'org/model',
      'inst/a',
      {
        targetWorkerId: 'worker-2',
        targetDeviceIndices: [1],
      },
      expect.any(AbortSignal),
    );
    expect(listRedisModelsFn).not.toHaveBeenCalled();
  });
});

describe('buffered upstream calls — timeout and client disconnect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** Real socket so the test can destroy the client connection (inject() cannot). */
  async function listen(app: FastifyInstance): Promise<number> {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    return typeof address === 'object' && address ? address.port : 0;
  }

  /** Mock control-plane call that hangs until the composed signal aborts, then rejects. */
  function hangUntilAbort(capture: (signal: AbortSignal) => void, onAbort: () => void) {
    return (_state: string | undefined, signal: AbortSignal) => {
      capture(signal);
      return new Promise<never>((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            onAbort();
            reject(new ClientDisconnectedError());
          },
          { once: true },
        );
      });
    };
  }

  it('client disconnect aborts the upstream control-plane call', async () => {
    let capturedSignal: AbortSignal | undefined;
    let resolveAbort: (() => void) | undefined;
    const aborted = new Promise<void>((resolve) => {
      resolveAbort = resolve;
    });
    listModelsFn.mockImplementation(
      hangUntilAbort(
        (signal) => {
          capturedSignal = signal;
        },
        () => resolveAbort?.(),
      ),
    );

    const app = await buildApp(buildDeps());
    const port = await listen(app);
    const req = httpRequest({ host: '127.0.0.1', port, path: '/api/models', method: 'GET' });
    req.on('error', () => {
      // Expected: the client socket is destroyed deliberately once the upstream call starts.
    });
    req.end();
    await vi.waitFor(() => expect(capturedSignal).toBeDefined());
    req.destroy();
    await aborted;

    listModelsFn.mockReset();
    listModelsFn.mockResolvedValue({ status: 200, data: { models: [sampleModel] } });
    const followUp = await app.inject({ method: 'GET', url: '/api/models' });
    await app.close();

    expect(capturedSignal?.aborted).toBe(true);
    expect(followUp.statusCode).toBe(200);
  });

  it('client disconnect does not produce a 500 for the next client', async () => {
    let resolveAbort: (() => void) | undefined;
    const aborted = new Promise<void>((resolve) => {
      resolveAbort = resolve;
    });
    listModelsFn.mockResolvedValue({ status: 200, data: { models: [sampleModel] } });
    listModelsFn.mockImplementationOnce(
      hangUntilAbort(
        () => {},
        () => resolveAbort?.(),
      ),
    );

    const app = await buildApp(buildDeps());
    const port = await listen(app);
    const req = httpRequest({ host: '127.0.0.1', port, path: '/api/models', method: 'GET' });
    req.on('error', () => {
      // Expected once the client socket is destroyed.
    });
    req.end();
    await vi.waitFor(() => expect(listModelsFn).toHaveBeenCalledTimes(1));
    req.destroy();
    await aborted;

    // The abandoned request's error path must not poison the server: the next client is served.
    const followUp = await app.inject({ method: 'GET', url: '/api/models' });
    await app.close();

    expect(followUp.statusCode).toBe(200);
    expect(followUp.json()).toMatchObject({ models: [{ modelName: 'llama-3' }] });
  });

  it('client disconnect after a POST body is consumed aborts the upstream control-plane call', async () => {
    // POST bodies are the reason the disconnect half hangs off `reply.raw`: on a body-carrying
    // request `request.raw` 'close' fires when the body finishes being consumed — at/just
    // before this handler starts — so a request.raw-based wiring either aborts immediately or
    // never sees the real disconnect. This case fails under that wiring; the GET cases cannot
    // tell the two apart.
    const deps = buildDeps();
    let capturedSignal: AbortSignal | undefined;
    deployModelFn.mockImplementation((_body: unknown, signal: AbortSignal) => {
      capturedSignal = signal;
      return new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new ClientDisconnectedError()), {
          once: true,
        });
      });
    });

    const app = await buildApp(deps);
    const port = await listen(app);
    const payload = JSON.stringify({
      modelName: 'llama-3',
      runnerType: 'vllm',
      requiredMemory: '10Gi',
    });
    const req = httpRequest({
      host: '127.0.0.1',
      port,
      path: '/api/models',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
    });
    req.on('error', () => {
      // Expected once the client socket is destroyed.
    });
    req.end(payload);
    await vi.waitFor(() => expect(capturedSignal).toBeDefined());

    // The body-phase close must not be mistaken for a client disconnect.
    expect(capturedSignal?.aborted).toBe(false);

    req.destroy();
    await vi.waitFor(() => expect(capturedSignal?.aborted).toBe(true), {
      timeout: 2000,
      interval: 10,
    });
    expect(deployModelFn).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('control-plane timeout falls back to Redis on the list route', async () => {
    listModelsFn.mockRejectedValue(BffError.upstreamTimeout('control-plane'));
    listRedisModelsFn.mockResolvedValue([sampleModel]);

    const app = await buildApp(buildDeps());
    const res = await app.inject({ method: 'GET', url: '/api/models' });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ source: 'redis-fallback' });
  });
});
