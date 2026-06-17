import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';

import { registerProbes } from '../probes.js';
import type { ProbesDeps } from '../probes.js';

function makeHealthyDeps(overrides: Partial<ProbesDeps> = {}): ProbesDeps {
  return {
    redis: {
      ping: vi.fn().mockResolvedValue('PONG'),
    } as unknown as ProbesDeps['redis'],
    db: {
      query: vi.fn().mockResolvedValue({ rowCount: 1 }),
    } as unknown as ProbesDeps['db'],
    ...overrides,
  };
}

async function buildApp(deps: ProbesDeps) {
  const app = Fastify({ logger: false });
  registerProbes(app, deps);
  await app.ready();
  return app;
}

describe('/healthz', () => {
  it('returns 200 for the leader', async () => {
    const app = await buildApp(makeHealthyDeps({ leaderElection: { isLeader: true } }));
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('returns 200 for a follower — liveness is independent of leadership', async () => {
    const app = await buildApp(makeHealthyDeps({ leaderElection: { isLeader: false } }));
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});

describe('/readyz', () => {
  it('returns 200 when standalone (no leader election) and infra is healthy', async () => {
    const app = await buildApp(makeHealthyDeps());
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { status: string; checks: Record<string, string> };
    expect(body.status).toBe('ready');
    expect(body.checks['redis']).toBe('ok');
    expect(body.checks['postgres']).toBe('ok');
    await app.close();
  });

  it('returns 200 when leader and infra is healthy', async () => {
    const app = await buildApp(makeHealthyDeps({ leaderElection: { isLeader: true } }));
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { status: string; checks: Record<string, string> };
    expect(body.status).toBe('ready');
    expect(body.checks['leader']).toBe('leader');
    await app.close();
  });

  it('returns 503 for a follower even when infra is healthy (regression for #36)', async () => {
    const app = await buildApp(makeHealthyDeps({ leaderElection: { isLeader: false } }));
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.body) as { status: string; checks: Record<string, string> };
    expect(body.status).toBe('not_ready');
    expect(body.checks['leader']).toBe('follower');
    // Infra is still healthy — only leadership failed
    expect(body.checks['redis']).toBe('ok');
    expect(body.checks['postgres']).toBe('ok');
    await app.close();
  });

  it('returns 503 when Redis is down', async () => {
    const deps = makeHealthyDeps();
    (deps.redis.ping as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('ECONNREFUSED'));
    const app = await buildApp(deps);
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.body) as { status: string; checks: Record<string, string> };
    expect(body.status).toBe('not_ready');
    expect(body.checks['redis']).toBe('error');
    await app.close();
  });

  it('returns 503 when Postgres is down', async () => {
    const deps = makeHealthyDeps();
    (deps.db.query as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('ECONNREFUSED'));
    const app = await buildApp(deps);
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.body) as { status: string; checks: Record<string, string> };
    expect(body.status).toBe('not_ready');
    expect(body.checks['postgres']).toBe('error');
    await app.close();
  });

  it('omits the leader check key when leader election is disabled', async () => {
    const app = await buildApp(makeHealthyDeps());
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    const body = JSON.parse(res.body) as { checks: Record<string, string> };
    expect(body.checks['leader']).toBeUndefined();
    await app.close();
  });
});
