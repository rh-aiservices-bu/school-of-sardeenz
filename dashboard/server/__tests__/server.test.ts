// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { request as httpRequest } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../server.js';
import { ClientDisconnectedError } from '../clients/upstream-signal.js';
import type { RouteDeps } from '../routes/deps.js';
import type { Config } from '../config.js';

const mockConfig: Config = {
  listenAddr: '0.0.0.0',
  listenPort: 4000,
  logLevel: 'info',
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

function buildDeps(): RouteDeps {
  return {
    config: mockConfig,
    controlPlane: {
      proxyRequest: vi.fn(),
      listModels: vi.fn(),
      getModel: vi.fn(),
      deployModel: vi.fn(),
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
      listModels: vi.fn(),
      getModel: vi.fn(),
      getModelNames: vi.fn(),
      listWorkers: vi.fn(),
      getClusterStatus: vi.fn(),
      getClusterMemory: vi.fn(),
      getWorkerDetail: vi.fn(),
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
  const app = await buildServer({ config: mockConfig, routes: deps });
  await app.ready();
  return app;
}

/**
 * Spies on the app logger's channels. Pino assigns the level methods as own properties of the
 * instance and child loggers (e.g. `request.log`) inherit them through the prototype chain, so
 * a spy on `app.log` also captures the records Fastify and the routes emit. The spies swallow
 * the records instead of calling through, keeping the test output clean.
 */
function spyLogs(app: FastifyInstance) {
  const silence = () => undefined;
  return {
    info: vi.spyOn(app.log, 'info').mockImplementation(silence),
    warn: vi.spyOn(app.log, 'warn').mockImplementation(silence),
    error: vi.spyOn(app.log, 'error').mockImplementation(silence),
  };
}

describe('global error handler — client disconnect', () => {
  it('logs a browser disconnect at info, never as an unhandled error, and keeps the server intact', async () => {
    const deps = buildDeps();
    let capturedSignal: AbortSignal | undefined;
    // Upstream call that only rejects once the composed signal aborts, i.e. exactly how the
    // control-plane/prometheus clients behave when the browser goes away mid-call.
    Object.assign(deps.controlPlane, {
      listModels: (_state: string | undefined, signal: AbortSignal) => {
        capturedSignal = signal;
        return new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new ClientDisconnectedError()), {
            once: true,
          });
        });
      },
    });

    const app = await buildApp(deps);
    const logs = spyLogs(app);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const req = httpRequest({ host: '127.0.0.1', port, path: '/api/models', method: 'GET' });
    const clientEvents: string[] = [];
    req.on('close', () => clientEvents.push('close'));
    req.on('error', (error: NodeJS.ErrnoException) => {
      clientEvents.push(`error:${error.code ?? ''}`);
    });
    req.end();
    await vi.waitFor(() => expect(capturedSignal).toBeDefined());

    req.destroy();
    await vi.waitFor(() => expect(capturedSignal?.aborted).toBe(true), {
      timeout: 2000,
      interval: 10,
    });
    // The info record marks the point where the rejection has travelled through Fastify's
    // error chain and the handler has finished. Search the recorded calls by message rather
    // than using `toHaveBeenCalledWith`: the spy also records Fastify's own request log lines,
    // whose raw request/socket objects are circular and enormous, so a per-retry failure diff
    // stalls the polling loop.
    const disconnectMessage = 'Client disconnected before the upstream call completed';
    // Wait until the handler has classified the failure either way — the info record or the
    // error-level 'Unhandled error' one — then assert which it was.
    await vi.waitFor(() =>
      expect(
        [...logs.info.mock.calls, ...logs.error.mock.calls].some(
          (call) => call[1] === disconnectMessage || call[1] === 'Unhandled error',
        ),
      ).toBe(true),
    );

    expect(capturedSignal?.aborted).toBe(true);
    // (a) No error-level record for a routine browser walkaway: the handler logged it at info,
    // naming the cause.
    expect(logs.error.mock.calls).toEqual([]);
    const disconnectRecord = logs.info.mock.calls.find(
      (call) => call[1] === disconnectMessage,
    )?.[0] as { err?: unknown } | undefined;
    expect(disconnectRecord?.err).toBeInstanceOf(ClientDisconnectedError);
    // No reply write was attempted on the dead socket (Fastify warns on a double send).
    expect(logs.warn.mock.calls).toEqual([]);
    // (b) No crash and no unhandled rejection from the never-replied request.
    expect(unhandled).toEqual([]);
    // (c) The client side of the connection closed, and the server still serves requests.
    expect(clientEvents).toContain('close');
    const followUp = await app.inject({ method: 'GET', url: '/healthz' });
    await app.close();
    expect(followUp.statusCode).toBe(200);

    process.removeListener('unhandledRejection', onUnhandled);
  });
});

describe('graceful shutdown — open SSE streams', () => {
  /**
   * Regression for the #256 e2e teardown hang: a hijacked SSE response is invisible to Fastify's
   * request lifecycle, so `server.close()` waited for the browser to hang up. Every e2e fixture
   * starts a BFF pointing at a mock control plane and tears the BFF down with SIGTERM; a BFF that
   * never exited kept its upstream sockets open, and the mock's `app.close()` then blocked on a
   * connection it could not reap until the Playwright test deadline expired.
   */
  it('ends open streams so app.close() resolves without the client hanging up', async () => {
    const deps = buildDeps();
    const subscriber = {
      on: vi.fn(),
      subscribe: vi.fn(() => Promise.resolve()),
      unsubscribe: vi.fn(() => Promise.resolve()),
      disconnect: vi.fn(),
    };
    Object.assign(deps.redis, { createSubscriber: () => subscriber });

    const app = await buildApp(deps);
    spyLogs(app);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    // A real HTTP client that keeps the stream open, like a dashboard tab: nothing in the test
    // ever closes it, so only the server can release the connection.
    const req = httpRequest({ host: '127.0.0.1', port, path: '/api/events', method: 'GET' });
    const clientEvents: string[] = [];
    req.on('response', (res) => {
      clientEvents.push(`response:${String(res.statusCode)}`);
      res.on('end', () => clientEvents.push('stream-end'));
      res.resume();
    });
    req.on('error', (error: NodeJS.ErrnoException) => {
      clientEvents.push(`error:${error.code ?? ''}`);
    });
    req.end();
    await vi.waitFor(() => expect(clientEvents).toContain('response:200'));

    const closed = await Promise.race([
      app.close().then(() => 'closed' as const),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 2000)),
    ]);

    expect(closed).toBe('closed');
    expect(subscriber.disconnect).toHaveBeenCalled();
    await vi.waitFor(() => expect(clientEvents).toContain('stream-end'));
    req.destroy();
  });
});
