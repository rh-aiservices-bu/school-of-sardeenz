// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { request as httpRequest, type ClientRequest } from 'node:http';
import { PassThrough, Readable } from 'node:stream';
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

describe('graceful shutdown — hijacked streams', () => {
  /**
   * Regression for the #256 e2e teardown hang: a hijacked response is invisible to Fastify's
   * request lifecycle, so `server.close()` waited for the browser to hang up. Every e2e fixture
   * starts a BFF pointing at a mock control plane and tears the BFF down with SIGTERM; a BFF that
   * never exited kept its upstream sockets open, and the mock's `app.close()` then blocked on a
   * connection it could not reap until the Playwright test deadline expired.
   *
   * The three hijacked routes — `/api/events`, the model-log tail and the streaming chat proxy —
   * all register in the same closers set, so this covers the class rather than one route.
   */
  interface HeldStream {
    req: ClientRequest;
    events: string[];
  }

  function openHeldStream(
    port: number,
    path: string,
    options: { method?: string; body?: string } = {},
  ): HeldStream {
    const events: string[] = [];
    const req = httpRequest({
      host: '127.0.0.1',
      port,
      path,
      method: options.method ?? 'GET',
      ...(options.body ? { headers: { 'content-type': 'application/json' } } : {}),
    });
    req.on('response', (res) => {
      events.push(`response:${String(res.statusCode)}`);
      res.on('data', (chunk: Buffer) => events.push(`data:${String(chunk.length)}`));
      res.on('end', () => events.push('stream-end'));
    });
    req.on('error', (error: NodeJS.ErrnoException) => {
      events.push(`error:${error.code ?? ''}`);
    });
    if (options.body) req.write(options.body);
    req.end();
    return { req, events };
  }

  /** Upstream body that emits one frame and stays open, like a live log/chat backend. */
  function heldUpstreamBody(frame: string): { response: Response; finish: () => void } {
    const pass = new PassThrough();
    pass.write(frame);
    const response = new Response(Readable.toWeb(pass) as unknown as ReadableStream<Uint8Array>, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
    return { response, finish: () => pass.end() };
  }

  async function listen(app: FastifyInstance): Promise<number> {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    return typeof address === 'object' && address ? address.port : 0;
  }

  async function closeBounded(app: FastifyInstance): Promise<'closed' | 'timeout'> {
    return Promise.race([
      app.close().then(() => 'closed' as const),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 2000)),
    ]);
  }

  it('ends an open SSE stream so app.close() resolves without the client hanging up', async () => {
    const deps = buildDeps();
    const subscriber = {
      on: vi.fn(),
      subscribe: vi.fn(() => Promise.resolve()),
      unsubscribe: vi.fn(() => Promise.resolve()),
      disconnect: vi.fn(),
    };
    Object.assign(deps.redis, { createSubscriber: () => subscriber });

    const app = await buildApp(deps);
    const logs = spyLogs(app);
    const port = await listen(app);

    // A real HTTP client that keeps the stream open, like a dashboard tab: nothing in the test
    // ever closes it, so only the server can release the connection.
    const client = openHeldStream(port, '/api/events');
    await vi.waitFor(() => expect(client.events).toContain('response:200'));

    // Still a live relay while serving: the Redis message the route subscribed to reaches the
    // browser as an SSE frame.
    const onMessage = subscriber.on.mock.calls.find((call) => call[0] === 'message')?.[1] as
      ((channel: string, message: string) => void) | undefined;
    expect(onMessage).toBeDefined();
    onMessage?.(
      'sardeenz:routing-updates',
      JSON.stringify({
        type: 'MODEL_ADDED',
        modelName: 'llama-3',
        state: 'ACTIVE',
        timestamp: new Date().toISOString(),
      }),
    );
    await vi.waitFor(() => expect(client.events.some((e) => e.startsWith('data:'))).toBe(true));

    expect(await closeBounded(app)).toBe('closed');
    expect(subscriber.unsubscribe).toHaveBeenCalledWith(
      'sardeenz:routing-updates',
      'sardeenz:cluster-events',
      'sardeenz:notifications',
    );
    expect(subscriber.disconnect).toHaveBeenCalled();
    await vi.waitFor(() => expect(client.events).toContain('stream-end'));
    // No closer failed: the warn channel stays empty (one throwing closer must not block the rest).
    expect(logs.warn.mock.calls).toEqual([]);
    client.req.destroy();
  });

  it('ends an open model-log tail and an open chat stream, not just the SSE relay', async () => {
    const deps = buildDeps();
    const modelLog = heldUpstreamBody('log: warmup starting\n\n');
    const chat = heldUpstreamBody('data: {"choices":[]}\n\n');
    Object.assign(deps.controlPlane, {
      proxyRequest: vi.fn(() => Promise.resolve(modelLog.response)),
    });
    Object.assign(deps.inference, { chatCompletions: vi.fn(() => Promise.resolve(chat.response)) });

    const app = await buildApp(deps);
    const logs = spyLogs(app);
    const port = await listen(app);

    const logClient = openHeldStream(port, '/api/models/llama-3/logs');
    const chatClient = openHeldStream(port, '/api/inference/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'llama-3', messages: [], stream: true }),
    });
    await vi.waitFor(() => expect(logClient.events).toContain('response:200'));
    await vi.waitFor(() => expect(chatClient.events).toContain('response:200'));
    // Both are streaming while serving — the shutdown path is the only thing being changed.
    await vi.waitFor(() => expect(logClient.events.some((e) => e.startsWith('data:'))).toBe(true));
    await vi.waitFor(() => expect(chatClient.events.some((e) => e.startsWith('data:'))).toBe(true));

    expect(await closeBounded(app)).toBe('closed');
    await vi.waitFor(() => expect(logClient.events).toContain('stream-end'));
    await vi.waitFor(() => expect(chatClient.events).toContain('stream-end'));
    expect(logs.warn.mock.calls).toEqual([]);

    modelLog.finish();
    chat.finish();
    logClient.req.destroy();
    chatClient.req.destroy();
  });
});
