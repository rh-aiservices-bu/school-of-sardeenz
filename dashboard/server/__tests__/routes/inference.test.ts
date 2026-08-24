// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { request as httpRequest } from 'node:http';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import type { FastifyInstance } from 'fastify';
import { registerInferenceRoutes } from '../../routes/inference.js';
import { authPlugin } from '../../plugins/auth.js';
import { BffError } from '../../errors.js';
import type { RouteDeps } from '../../routes/deps.js';
import type { Config } from '../../config.js';

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    listenAddr: '0.0.0.0',
    listenPort: 4000,
    logLevel: 'silent',
    controlPlaneUrl: 'http://cp.test',
    redisUrl: 'redis://localhost:6379',
    redisKeyPrefix: 'sardeenz',
    prometheusUrl: 'http://prom.test',
    inferenceUrl: 'http://inference.test',
    authMode: 'none',
    adminUsername: 'admin',
    adminPassword: 'secret123',
    jwtSecret: 'test-jwt-secret-that-is-long-enough',
    jwtExpirationHours: 8,
    oauthClientId: 'sardeenz',
    oauthClientSecret: '',
    oauthIssuerUrl: '',
    k8sApiUrl: '',
    namespace: 'sardeenz',
    controlPlaneApiToken: '',
    publicUrl: '',
    ...overrides,
  };
}

const chatCompletionsFn = vi.fn();

function buildDeps(config: Config): RouteDeps {
  return {
    config,
    controlPlane: {} as unknown as RouteDeps['controlPlane'],
    redis: {} as unknown as RouteDeps['redis'],
    prometheus: {} as unknown as RouteDeps['prometheus'],
    inference: {
      chatCompletions: chatCompletionsFn,
      isHealthy: vi.fn(),
    } as unknown as RouteDeps['inference'],
  };
}

async function buildApp(config: Config): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof BffError) {
      return reply.code(error.statusCode).send(error.toResponse());
    }
    return reply.code(500).send({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });

  await app.register(fastifyCookie);
  await app.register(authPlugin, { config });
  registerInferenceRoutes(app, buildDeps(config));
  await app.ready();
  return app;
}

/** Builds a fake upstream `Response` whose body streams the given SSE-frame strings. */
function makeUpstreamResponse(
  chunks: string[],
  status = 200,
  contentType = 'text/event-stream',
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, { status, headers: { 'Content-Type': contentType } });
}

/** Same as `makeUpstreamResponse`, but enqueues each chunk `delayMs` apart to test incremental delivery. */
function makeDelayedUpstreamResponse(
  chunks: string[],
  delayMs: number,
  contentType = 'text/event-stream',
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': contentType } });
}

async function listen(app: FastifyInstance): Promise<{ port: number; url: string }> {
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { port, url: `http://127.0.0.1:${port}/api/inference/chat/completions` };
}

describe('POST /api/inference/chat/completions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('auth enforcement', () => {
    it('returns 401 without a JWT when AUTH_MODE=simple', async () => {
      const app = await buildApp(makeConfig({ authMode: 'simple' }));
      const res = await app.inject({
        method: 'POST',
        url: '/api/inference/chat/completions',
        payload: { model: 'llama-3', messages: [] },
      });
      await app.close();

      expect(res.statusCode).toBe(401);
      expect(chatCompletionsFn).not.toHaveBeenCalled();
    });

    it('returns 403 for an admin-readonly token', async () => {
      const config = makeConfig({ authMode: 'simple' });
      const app = await buildApp(config);
      const token = app.jwt.sign(
        { username: 'viewer', roles: ['admin-readonly'], authMode: 'simple' },
        { expiresIn: 3600 },
      );

      const res = await app.inject({
        method: 'POST',
        url: '/api/inference/chat/completions',
        headers: { authorization: `Bearer ${token}` },
        payload: { model: 'llama-3', messages: [] },
      });
      await app.close();

      expect(res.statusCode).toBe(403);
      expect(chatCompletionsFn).not.toHaveBeenCalled();
    });

    it('passes for an admin token', async () => {
      chatCompletionsFn.mockResolvedValue(makeUpstreamResponse(['data: [DONE]\n\n']));
      const config = makeConfig({ authMode: 'simple' });
      const app = await buildApp(config);
      const token = app.jwt.sign(
        { username: 'admin', roles: ['admin'], authMode: 'simple' },
        { expiresIn: 3600 },
      );

      const res = await app.inject({
        method: 'POST',
        url: '/api/inference/chat/completions',
        headers: { authorization: `Bearer ${token}` },
        payload: { model: 'llama-3', messages: [] },
      });
      await app.close();

      expect(res.statusCode).toBe(200);
    });
  });

  it('surfaces an upstream 5xx as JSON before hijacking', async () => {
    chatCompletionsFn.mockResolvedValue(
      new Response(JSON.stringify({ error: 'Runner crashed', code: 'UPSTREAM_ERROR' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const app = await buildApp(makeConfig());
    const res = await app.inject({
      method: 'POST',
      url: '/api/inference/chat/completions',
      payload: { model: 'llama-3', messages: [] },
    });
    await app.close();

    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ error: 'Runner crashed' });
  });

  it('surfaces upstream 400 (bad/missing model) as JSON before hijack', async () => {
    chatCompletionsFn.mockResolvedValue(
      new Response(JSON.stringify({ error: 'model is required', code: 'INVALID_REQUEST' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const app = await buildApp(makeConfig());
    const res = await app.inject({
      method: 'POST',
      url: '/api/inference/chat/completions',
      payload: { messages: [] },
    });
    await app.close();

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('returns 502 when the proxy is unreachable', async () => {
    chatCompletionsFn.mockRejectedValue(new Error('ECONNREFUSED'));

    const app = await buildApp(makeConfig());
    const res = await app.inject({
      method: 'POST',
      url: '/api/inference/chat/completions',
      payload: { model: 'llama-3', messages: [] },
    });
    await app.close();

    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ code: 'UPSTREAM_ERROR' });
  });

  it('copies the upstream Content-Type through (text/event-stream for a streamed request)', async () => {
    chatCompletionsFn.mockResolvedValue(makeUpstreamResponse(['data: [DONE]\n\n']));

    const app = await buildApp(makeConfig());
    const res = await app.inject({
      method: 'POST',
      url: '/api/inference/chat/completions',
      payload: { model: 'llama-3', messages: [], stream: true },
    });
    await app.close();

    expect(res.headers['content-type']).toBe('text/event-stream');
  });

  it('copies the upstream Content-Type through (application/json for a non-streamed request)', async () => {
    chatCompletionsFn.mockResolvedValue(
      makeUpstreamResponse(['{"choices":[]}'], 200, 'application/json'),
    );

    const app = await buildApp(makeConfig());
    const res = await app.inject({
      method: 'POST',
      url: '/api/inference/chat/completions',
      payload: { model: 'llama-3', messages: [] },
    });
    await app.close();

    expect(res.headers['content-type']).toBe('application/json');
  });

  it('delivers the streamed body to the client in more than one chunk', async () => {
    chatCompletionsFn.mockResolvedValue(
      makeDelayedUpstreamResponse(
        ['data: {"choices":[{"delta":{"content":"a"}}]}\n\n', 'data: [DONE]\n\n'],
        150,
      ),
    );

    const app = await buildApp(makeConfig());
    const { url } = await listen(app);

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'llama-3', messages: [] }),
    });
    const reader = res.body!.getReader();
    const timestamps: number[] = [];
    let chunkCount = 0;
    while (true) {
      const { done } = await reader.read();
      if (done) break;
      timestamps.push(Date.now());
      chunkCount += 1;
    }
    await app.close();

    expect(chunkCount).toBeGreaterThanOrEqual(2);
    // A buffering regression would deliver both frames back-to-back; the injected 150ms delay
    // between upstream enqueues should be visible in the client's read timing.
    expect(timestamps[timestamps.length - 1] - timestamps[0]).toBeGreaterThanOrEqual(100);
  });

  it('client disconnect aborts the upstream request', async () => {
    let capturedSignal: AbortSignal | undefined;
    chatCompletionsFn.mockImplementation((_body: unknown, signal: AbortSignal) => {
      capturedSignal = signal;
      return Promise.resolve(
        makeDelayedUpstreamResponse(['data: a\n\n', 'data: b\n\n', 'data: c\n\n'], 200),
      );
    });

    const app = await buildApp(makeConfig());
    const { port } = await listen(app);

    // Use node:http directly (rather than fetch) so the test can destroy the client socket
    // outright — the most unambiguous way to simulate "user closes the tab / hits Stop".
    await new Promise<void>((resolve) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path: '/api/inference/chat/completions',
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        },
        (res) => {
          res.once('data', () => {
            req.destroy(); // client disconnect — destroys the underlying TCP connection
            setTimeout(resolve, 300); // give the server a moment to observe the close
          });
        },
      );
      req.on('error', () => {
        /* expected once we destroy() the request */
      });
      req.end(JSON.stringify({ model: 'llama-3', messages: [] }));
    });

    await app.close();

    expect(capturedSignal?.aborted).toBe(true);
  });
});
