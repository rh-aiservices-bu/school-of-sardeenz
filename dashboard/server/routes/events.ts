import type { FastifyInstance } from 'fastify';
import type { RouteDeps } from './deps.js';

const PING_INTERVAL_MS = 30_000;

export function registerEventRoutes(app: FastifyInstance, deps: RouteDeps): void {
  app.get('/api/events', async (request, reply) => {
    // Take over the raw socket — Fastify's reply lifecycle does not apply here
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.flushHeaders();

    const channel = `${deps.redis.keyPrefix}:events`;
    const subscriber = deps.redis.createSubscriber();

    // Send a comment ping every 30 s to keep the connection alive
    const pingTimer = setInterval(() => {
      try {
        reply.raw.write(': ping\n\n');
      } catch {
        // Client already disconnected — cleanup will run on the 'close' event
      }
    }, PING_INTERVAL_MS);

    const onMessage = (_chan: string, message: string): void => {
      try {
        // Validate the message is JSON before forwarding
        JSON.parse(message);
        reply.raw.write(`data: ${message}\n\n`);
      } catch {
        app.log.warn({ message }, 'Received non-JSON event from Redis pub/sub — skipping');
      }
    };

    subscriber.on('message', onMessage);

    await subscriber.subscribe(channel);
    app.log.debug({ channel }, 'SSE client connected — subscribed to Redis channel');

    const cleanup = (): void => {
      clearInterval(pingTimer);
      subscriber.unsubscribe(channel).catch(() => undefined);
      subscriber.disconnect();
      app.log.debug({ channel }, 'SSE client disconnected — Redis subscriber cleaned up');
    };

    request.raw.on('close', cleanup);
    request.raw.on('error', cleanup);

    // Keep the handler alive until the client disconnects (the raw stream owns the socket)
    await new Promise<void>((resolve) => {
      request.raw.on('close', resolve);
      request.raw.on('error', resolve);
    });
  });
}
