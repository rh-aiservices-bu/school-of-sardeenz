import type { FastifyInstance } from 'fastify';
import { ClusterEventType, RoutingMapUpdateType, type ModelLifecycleState } from '@sardeenz/types';
import type { ControlPlaneComponents, ProxyControlPlaneComponents } from '@sardeenz/types';
import type { RouteDeps } from './deps.js';

type RoutingMapUpdate = ProxyControlPlaneComponents['schemas']['RoutingMapUpdate'];
type ClusterEvent = ControlPlaneComponents['schemas']['ClusterEvent'];

const PING_INTERVAL_MS = 30_000;

/**
 * The control plane publishes `RoutingMapUpdate` payloads on the
 * `routing-updates` Redis channel.  The dashboard frontend expects
 * `ClusterEvent` objects.  This function bridges the two schemas.
 */
export function toClusterEvent(update: RoutingMapUpdate): ClusterEvent {
  const base: Pick<ClusterEvent, 'timestamp' | 'modelName'> = {
    timestamp: update.timestamp,
    modelName: update.modelName,
  };

  // ModelState is a strict subset of ModelLifecycleState (same string values)
  // so this cast is safe at runtime.
  const state = update.state as ModelLifecycleState | undefined;

  switch (update.type) {
    case RoutingMapUpdateType.MODEL_STATE_CHANGED:
      return { ...base, type: ClusterEventType.MODEL_STATE_CHANGED, state };
    case RoutingMapUpdateType.MODEL_ADDED:
      return { ...base, type: ClusterEventType.MODEL_DEPLOYED, state };
    case RoutingMapUpdateType.MODEL_REMOVED:
      return { ...base, type: ClusterEventType.MODEL_REMOVED };
    case RoutingMapUpdateType.ENDPOINT_ADDED:
      return {
        ...base,
        type: ClusterEventType.MODEL_STATE_CHANGED,
        message: `Endpoint added: ${update.endpoint?.host}:${update.endpoint?.port}`,
        data: update.endpoint ? { endpoint: update.endpoint } : undefined,
      };
    case RoutingMapUpdateType.ENDPOINT_REMOVED:
      return {
        ...base,
        type: ClusterEventType.MODEL_STATE_CHANGED,
        message: `Endpoint removed: ${update.endpoint?.host}:${update.endpoint?.port}`,
        data: update.endpoint ? { endpoint: update.endpoint } : undefined,
      };
    case RoutingMapUpdateType.ENDPOINT_UPDATED:
      return {
        ...base,
        type: ClusterEventType.MODEL_STATE_CHANGED,
        message: `Endpoint updated: ${update.endpoint?.host}:${update.endpoint?.port}`,
        data: update.endpoint ? { endpoint: update.endpoint } : undefined,
      };
    default:
      return { ...base, type: ClusterEventType.MODEL_STATE_CHANGED };
  }
}

export function registerEventRoutes(app: FastifyInstance, deps: RouteDeps): void {
  app.get('/api/events', async (request, reply) => {
    const channel = `${deps.redis.keyPrefix}:routing-updates`;
    const subscriber = deps.redis.createSubscriber();

    // Subscribe to Redis BEFORE writing SSE headers so failures return a proper error
    try {
      subscriber.on('message', (_chan: string, message: string): void => {
        try {
          const update = JSON.parse(message) as RoutingMapUpdate;
          const event = toClusterEvent(update);
          reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
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
