import type { FastifyInstance } from 'fastify';
import type { Redis } from '../clients/redis.js';
import { redisKey } from '../clients/redis.js';

export function registerEventRoutes(
  app: FastifyInstance,
  subscriber: Redis,
  keyPrefix: string,
): void {
  const routingChannel = redisKey(keyPrefix, 'routing-updates');
  const clusterChannel = redisKey(keyPrefix, 'cluster-events');

  app.get('/api/v1/events', async (request, reply) => {
    await reply.hijack();

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const write = (event: string, data: string): void => {
      reply.raw.write(`event: ${event}\ndata: ${data}\n\n`);
    };

    const clientSubscriber = subscriber.duplicate();
    await clientSubscriber.subscribe(routingChannel, clusterChannel);

    const onMessage = (_ch: string, message: string): void => {
      write('message', message);
    };
    clientSubscriber.on('message', onMessage);

    const pingInterval = setInterval(() => {
      write('ping', new Date().toISOString());
    }, 30_000);

    write('ping', new Date().toISOString());

    request.raw.on('close', () => {
      clearInterval(pingInterval);
      clientSubscriber.off('message', onMessage);
      clientSubscriber.unsubscribe(routingChannel, clusterChannel).catch(() => {});
      clientSubscriber.disconnect();
    });
  });
}
