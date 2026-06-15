import type { FastifyInstance } from 'fastify';
import type { RouteDeps } from './deps.js';

const PING_INTERVAL_MS = 30_000;

export function registerEventRoutes(app: FastifyInstance, deps: RouteDeps): void {
  app.get('/api/events', async (request, reply) => {
    const channel = `${deps.redis.keyPrefix}:events`;
    const subscriber = deps.redis.createSubscriber();

    // Subscribe to Redis BEFORE writing SSE headers so failures return a proper error
    try {
      subscriber.on('message', (_chan: string, message: string): void => {
        try {
          JSON.parse(message);
          reply.raw.write(`data: ${message}\n\n`);
        } catch {
          app.log.warn({ message }, 'Received non-JSON event from Redis pub/sub — skipping');
        }
      });

      await subscriber.subscribe(channel);
    } catch (err) {
      subscriber.disconnect();
      app.log.error({ err }, 'Failed to subscribe to Redis pub/sub for SSE');
      return reply.code(502).send({ error: 'Event stream unavailable', code: 'UPSTREAM_ERROR' });
    }

    // Redis subscription succeeded — now take over the raw socket
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.flushHeaders();

    app.log.debug({ channel }, 'SSE client connected — subscribed to Redis channel');

    const pingTimer = setInterval(() => {
      try {
        reply.raw.write(': ping\n\n');
      } catch {
        // Client already disconnected — cleanup will run on the 'close' event
      }
    }, PING_INTERVAL_MS);

    let cleanedUp = false;
    const cleanup = (): void => {
      if (cleanedUp) return;
      cleanedUp = true;
      clearInterval(pingTimer);
      subscriber.unsubscribe(channel).catch(() => undefined);
      subscriber.disconnect();
      reply.raw.end();
      app.log.debug({ channel }, 'SSE client disconnected — Redis subscriber cleaned up');
    };

    request.raw.on('close', cleanup);
    request.raw.on('error', cleanup);

    // Keep the handler alive until the client disconnects
    await new Promise<void>((resolve) => {
      request.raw.on('close', resolve);
      request.raw.on('error', resolve);
    });
  });
}
