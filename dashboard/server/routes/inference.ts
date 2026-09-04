import { Readable } from 'node:stream';
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { JwtPayload } from '../plugins/auth.js';
import { InferenceConcurrencyLimiter } from '../inference-concurrency-limiter.js';
import type { RouteDeps } from './deps.js';

function inferenceUsername(
  request: FastifyRequest,
  authMode: RouteDeps['config']['authMode'],
): string {
  // In authenticated modes, this value is set only by successful jwtVerify(). Do not derive
  // identity from a request body, arbitrary header, or client address.
  return authMode === 'none' ? 'anonymous' : (request.user as JwtPayload).username;
}

/** Registers the BFF's authenticated, streaming OpenAI chat-completions proxy. */
export function registerInferenceRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const limiter = new InferenceConcurrencyLimiter(
    deps.config.maxConcurrentInferenceRequestsPerUser,
  );

  app.post(
    '/api/inference/chat/completions',
    { preHandler: [app.authenticate, app.requireRole('admin')] },
    async (request, reply) => {
      const username = inferenceUsername(request, deps.config.authMode);
      const release = limiter.tryAcquire(username);
      if (!release) {
        app.log.warn(
          { username, cap: deps.config.maxConcurrentInferenceRequestsPerUser },
          'Inference concurrency limit reached',
        );
        return reply.code(429).send({
          error: 'Too many concurrent inference requests',
          code: 'RATE_LIMITED',
        });
      }

      const controller = new AbortController();
      let upstreamStream: Readable | undefined;
      let hijacked = false;
      let clientDisconnected = false;
      let cleanedUp = false;
      let resolveCompletion: (() => void) | undefined;
      const completion = new Promise<void>((resolve) => {
        resolveCompletion = resolve;
      });

      // This must be established before fetch: a model may be waking while the client leaves.
      const cleanup = (): void => {
        if (cleanedUp) return;
        cleanedUp = true;
        controller.abort();
        upstreamStream?.destroy();
        release();
        if (hijacked && !reply.raw.writableEnded && !reply.raw.destroyed) {
          reply.raw.end();
        }
        resolveCompletion?.();
      };
      reply.raw.on('close', () => {
        clientDisconnected = true;
        cleanup();
      });
      reply.raw.on('error', () => {
        clientDisconnected = true;
        cleanup();
      });
      reply.raw.on('finish', cleanup);

      const sendBeforeHijack = async (status: number, data: unknown): Promise<void> => {
        if (clientDisconnected || reply.raw.destroyed) return;
        reply.code(status).send(data);
        await completion;
      };

      try {
        let upstream: Response;
        try {
          upstream = await deps.inference.chatCompletions(request.body, controller.signal);
        } catch (err) {
          if (!clientDisconnected && !controller.signal.aborted) {
            app.log.error({ err }, 'Inference proxy unreachable');
            await sendBeforeHijack(502, {
              error: 'Inference proxy unreachable',
              code: 'UPSTREAM_ERROR',
            });
          }
          return;
        }

        if (clientDisconnected) return;

        // Non-OK responses stay under Fastify's normal JSON reply handling. A successful
        // response without a body is treated the same way so it cannot leak a slot.
        if (!upstream.ok || !upstream.body) {
          let data: unknown;
          try {
            data = await upstream.json();
          } catch {
            data = { error: `Proxy returned ${upstream.status}`, code: 'UPSTREAM_ERROR' };
          }
          await sendBeforeHijack(upstream.status, data);
          return;
        }

        reply.hijack();
        hijacked = true;
        reply.raw.writeHead(200, {
          'Content-Type': upstream.headers.get('content-type') ?? 'application/json',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        reply.raw.flushHeaders();

        upstreamStream = Readable.fromWeb(
          upstream.body as unknown as NodeWebReadableStream<Uint8Array>,
        );
        // Attach completion handlers before piping; a synchronously-ending source must not race
        // past cleanup and leave its user's slot held.
        upstreamStream.on('end', cleanup);
        upstreamStream.on('error', cleanup);
        upstreamStream.pipe(reply.raw, { end: false });

        app.log.debug({ username }, 'Inference stream client connected');
        await completion;
      } finally {
        cleanup();
      }
    },
  );
}
