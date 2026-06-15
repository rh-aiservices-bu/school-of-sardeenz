import type { FastifyInstance } from 'fastify';

import type { Redis } from '../clients/redis.js';
import type { DatabasePool } from '../clients/database.js';

export interface ProbesDeps {
  redis: Redis;
  db: DatabasePool;
  leaderElection?: { readonly isLeader: boolean };
}

export function registerProbes(app: FastifyInstance, deps: ProbesDeps): void {
  app.get('/healthz', async (_req, reply) => {
    return reply.code(200).send({ status: 'ok' });
  });

  app.get('/readyz', async (_req, reply) => {
    const checks: Record<string, string> = {};
    let ready = true;

    try {
      const pong = await deps.redis.ping();
      checks['redis'] = pong === 'PONG' ? 'ok' : 'error';
      if (pong !== 'PONG') ready = false;
    } catch {
      checks['redis'] = 'error';
      ready = false;
    }

    try {
      const result = await deps.db.query('SELECT 1');
      checks['postgres'] = result.rowCount === 1 ? 'ok' : 'error';
      if (result.rowCount !== 1) ready = false;
    } catch {
      checks['postgres'] = 'error';
      ready = false;
    }

    if (deps.leaderElection) {
      const leading = deps.leaderElection.isLeader;
      checks['leader'] = leading ? 'leader' : 'follower';
      if (!leading) ready = false;
    }

    return reply.code(ready ? 200 : 503).send({ status: ready ? 'ready' : 'not_ready', checks });
  });
}
