import type { ControlPlaneComponents } from '@sardeenz/types';
import type { Redis } from '../clients/redis.js';
import { redisKey } from '../clients/redis.js';

export type ClusterEvent = ControlPlaneComponents['schemas']['ClusterEvent'];

/** Narrow logger seam so services can log without depending on Fastify/pino. */
export interface ClusterEventLogger {
  error(obj: Record<string, unknown>, msg: string): void;
}

/**
 * Anything that can publish a `ClusterEvent`. Structural interface so `ModelLifecycleService` can be
 * unit-tested with a spy and never needs a Redis connection of its own.
 */
export interface ClusterEventSink {
  publish(event: ClusterEvent): void | Promise<void>;
}

/**
 * The control plane's shared publisher for the `{prefix}:cluster-events` channel — the one the BFF
 * relays verbatim to the dashboard's SSE stream (`dashboard/server/routes/events.ts`).
 *
 * Publishing is audit-only everywhere it is used: `publish` never throws and never rejects, because
 * its callers are teardown paths whose correctness must not depend on the event channel.
 */
export class ClusterEventPublisher implements ClusterEventSink {
  private readonly channel: string;

  constructor(
    private readonly redis: Redis,
    keyPrefix: string,
    private readonly logger?: ClusterEventLogger,
  ) {
    this.channel = redisKey(keyPrefix, 'cluster-events');
  }

  publish(event: ClusterEvent): void {
    void this.redis.publish(this.channel, JSON.stringify(event)).catch((err: unknown) => {
      this.logger?.error(
        { eventType: event.type, err: err instanceof Error ? err.message : String(err) },
        'Failed to publish cluster event',
      );
    });
  }
}
