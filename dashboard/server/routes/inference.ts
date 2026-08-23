import { Readable } from 'node:stream';
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web';
import type { FastifyInstance } from 'fastify';
import type { RouteDeps } from './deps.js';

/**
 * Streams a chat completion request to the browser via the Rust proxy's OpenAI-compatible
 * `/v1/chat/completions`.
 *
 * This is the BFF's second streaming proxy, after `model-logs.ts` — same hijack-and-pipe shape,
 * with four deltas driven by this route being a POST with a body rather than a GET:
 *
 *   1. The request body is forwarded upstream as JSON (buffering the *request* is fine and
 *      unavoidable — the proxy buffers it too); only the *response* must stream unbuffered.
 *   2. The upstream Content-Type is copied through rather than hardcoded, since the proxy
 *      returns `text/event-stream` when the request body has `stream: true` and
 *      `application/json` otherwise.
 *   3. An `AbortController` is created for the upstream `fetch` and aborted from `cleanup`, so a
 *      client disconnect (Stop button, tab close) actually cancels the runner generation instead
 *      of leaving it running for nobody. The disconnect signal is `reply.raw`'s `close` event
 *      (the response socket), NOT `request.raw`'s — for a GET route like `model-logs.ts` the
 *      request has no body, so `request.raw`'s `close` happens to track the connection. Here the
 *      request carries a body; Node fires `request.raw`'s `close` as soon as that body has been
 *      fully read (i.e. almost immediately, well before the client goes away), which would abort
 *      the upstream generation right after it starts. `reply.raw`'s `close` fires when the
 *      underlying connection is actually torn down, which is the signal this route needs.
 *   4. Non-OK upstream responses (and an unreachable proxy) are surfaced as a normal JSON reply
 *      with the upstream status, before `reply.hijack()` — after hijacking, Fastify no longer
 *      manages the response and a structured error can no longer be sent.
 */
export function registerInferenceRoutes(app: FastifyInstance, deps: RouteDeps): void {
  app.post(
    '/api/inference/chat/completions',
    { preHandler: [app.authenticate, app.requireRole('admin')] },
    async (request, reply) => {
      const body = request.body;
      const controller = new AbortController();

      let upstream: Response;
      try {
        upstream = await deps.inference.chatCompletions(body, controller.signal);
      } catch (err) {
        app.log.error({ err }, 'Inference proxy unreachable');
        return reply.code(502).send({ error: 'Inference proxy unreachable', code: 'UPSTREAM_ERROR' });
      }

      // Surface a non-OK upstream response (e.g. 400 bad/missing model) as a normal JSON reply
      // BEFORE hijacking the socket, so the browser gets a proper HTTP error instead of a stream
      // that opens and immediately dies.
      if (!upstream.ok || !upstream.body) {
        let data: unknown;
        try {
          data = await upstream.json();
        } catch {
          data = { error: `Proxy returned ${upstream.status}`, code: 'UPSTREAM_ERROR' };
        }
        return reply.code(upstream.status).send(data);
      }

      reply.hijack();
      const upstreamCT = upstream.headers.get('content-type') ?? 'application/json';
      reply.raw.writeHead(200, {
        'Content-Type': upstreamCT,
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      reply.raw.flushHeaders();

      // See model-logs.ts for why the type cast is needed (lib.dom vs node:stream/web
      // ReadableStream types diverge; they're runtime-compatible).
      const upstreamStream = Readable.fromWeb(
        upstream.body as unknown as NodeWebReadableStream<Uint8Array>,
      );

      let cleanedUp = false;
      const cleanup = (): void => {
        if (cleanedUp) return;
        cleanedUp = true;
        controller.abort();
        upstreamStream.destroy();
        if (!reply.raw.writableEnded) {
          reply.raw.end();
        }
      };

      // Pipe with `end: false` so we control when the reply ends via `cleanup`, keeping the
      // end-of-stream and error/close paths identical.
      upstreamStream.pipe(reply.raw, { end: false });
      upstreamStream.on('end', cleanup);
      upstreamStream.on('error', cleanup);

      reply.raw.on('close', cleanup);
      reply.raw.on('error', cleanup);

      app.log.debug('Inference stream client connected');

      // Keep the handler alive until either side closes the stream.
      await new Promise<void>((resolve) => {
        reply.raw.on('close', resolve);
        reply.raw.on('error', resolve);
        upstreamStream.on('end', resolve);
        upstreamStream.on('error', resolve);
      });
    },
  );
}
