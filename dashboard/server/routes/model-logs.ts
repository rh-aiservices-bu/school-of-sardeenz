import { Readable } from 'node:stream';
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web';
import type { FastifyInstance } from 'fastify';
import type { RouteDeps } from './deps.js';

/**
 * Streams a model's runner logs to the browser.
 *
 * This is the BFF's first *streaming* proxy — every other route buffers the
 * control plane response via `.json()`. Here we take the raw upstream
 * `Response` from `ControlPlaneClient.proxyRequest` and pipe its body
 * straight through to the client, byte-for-byte, so the `log`/`end` SSE
 * frames documented on `GET /api/v1/models/{modelName}/logs` reach the
 * browser `EventSource` unmodified.
 *
 * The control plane already emits `: ping` keepalive comments on this stream
 * while it waits for the runner to be placed (see the OpenAPI description on
 * this operation), so those flow through the pipe automatically — this route
 * does not need a separate ping timer like `events.ts`'s Redis-backed SSE
 * route does.
 */
export function registerModelLogRoutes(app: FastifyInstance, deps: RouteDeps): void {
  app.get<{ Params: { name: string } }>(
    '/api/models/:name/logs',
    { preHandler: [app.authenticate, app.requireRole('admin-readonly')] },
    async (request, reply) => {
      const { name } = request.params;

      let upstream: Response;
      try {
        upstream = await deps.controlPlane.proxyRequest(
          'GET',
          `/api/v1/models/${encodeURIComponent(name)}/logs`,
        );
      } catch (err) {
        app.log.error({ err, modelName: name }, 'Control plane unreachable for model logs stream');
        return reply.code(502).send({ error: 'Control plane unreachable', code: 'UPSTREAM_ERROR' });
      }

      // Surface upstream errors (e.g. 404 unknown model) as a normal JSON response BEFORE
      // hijacking the socket, so the browser EventSource gets a proper HTTP error instead of
      // a stream that opens and immediately dies.
      if (!upstream.ok || !upstream.body) {
        let data: unknown;
        try {
          data = await upstream.json();
        } catch {
          data = { error: `Control plane returned ${upstream.status}`, code: 'UPSTREAM_ERROR' };
        }
        return reply.code(upstream.status).send(data);
      }

      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      reply.raw.flushHeaders();

      // The global `fetch` Response body is typed against the lib.dom ReadableStream, which
      // structurally diverges from Node's own `stream/web` ReadableStream that
      // `Readable.fromWeb` expects (BYOB reader details). They're runtime-compatible; only
      // the type shapes differ.
      const upstreamStream = Readable.fromWeb(
        upstream.body as unknown as NodeWebReadableStream<Uint8Array>,
      );

      let cleanedUp = false;
      const cleanup = (): void => {
        if (cleanedUp) return;
        cleanedUp = true;
        upstreamStream.destroy();
        if (!reply.raw.writableEnded) {
          reply.raw.end();
        }
      };

      // Pipe with `end: false` so we control when the reply ends via `cleanup`, keeping
      // the end-of-stream and error/close paths identical.
      upstreamStream.pipe(reply.raw, { end: false });
      upstreamStream.on('end', cleanup);
      upstreamStream.on('error', cleanup);

      request.raw.on('close', cleanup);
      request.raw.on('error', cleanup);

      app.log.debug({ modelName: name }, 'Model log stream client connected');

      // Keep the handler alive until either side closes the stream.
      await new Promise<void>((resolve) => {
        request.raw.on('close', resolve);
        request.raw.on('error', resolve);
        upstreamStream.on('end', resolve);
        upstreamStream.on('error', resolve);
      });
    },
  );
}
