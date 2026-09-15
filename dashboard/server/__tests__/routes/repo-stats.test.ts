// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import type { FastifyInstance } from 'fastify';
import { registerRepoStatsRoutes } from '../../routes/repo-stats.js';
import { authPlugin } from '../../plugins/auth.js';
import { BffError } from '../../errors.js';
import { GithubRepoStatsClient } from '../../clients/github.js';
import type { RouteDeps } from '../../routes/deps.js';
import type { Config } from '../../config.js';

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    listenAddr: '0.0.0.0',
    listenPort: 4000,
    logLevel: 'silent',
    controlPlaneUrl: 'http://cp.test',
    redisUrl: 'redis://localhost:6379',
    redisKeyPrefix: 'sardeenz',
    prometheusUrl: 'http://prom.test',
    prometheusBearerTokenPath: '',
    prometheusCaPath: '',
    prometheusTenantNamespace: '',
    inferenceUrl: 'http://inference.test:8080',
    repoStatsUrl: 'https://api.github.com/repos/rh-aiservices-bu/school-of-sardeenz',
    maxConcurrentInferenceRequestsPerUser: 4,
    authMode: 'none',
    adminUsername: 'admin',
    adminPassword: 'admin-secret-should-never-leak',
    jwtSecret: 'test-jwt-secret-that-is-long-enough',
    jwtExpirationHours: 8,
    oauthClientId: 'sardeenz',
    oauthClientSecret: 'oauth-secret-should-never-leak',
    oauthIssuerUrl: '',
    k8sApiUrl: '',
    namespace: 'sardeenz',
    controlPlaneApiToken: 'api-token-should-never-leak',
    publicUrl: '',
    ...overrides,
  };
}

function buildDeps(config: Config, githubRepoStats: GithubRepoStatsClient): RouteDeps {
  return {
    config,
    controlPlane: {} as unknown as RouteDeps['controlPlane'],
    redis: {} as unknown as RouteDeps['redis'],
    prometheus: {} as unknown as RouteDeps['prometheus'],
    inference: {} as unknown as RouteDeps['inference'],
    githubRepoStats,
  };
}

async function buildApp(
  config: Config,
  githubRepoStats: GithubRepoStatsClient,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof BffError) {
      return reply.code(error.statusCode).send(error.toResponse());
    }
    return reply.code(500).send({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });

  await app.register(fastifyCookie);
  await app.register(authPlugin, { config });
  registerRepoStatsRoutes(app, buildDeps(config, githubRepoStats));
  await app.ready();
  return app;
}

describe('GET /api/repo-stats', () => {
  let now: number;

  beforeEach(() => {
    now = Date.parse('2026-09-15T00:00:00.000Z');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('maps stargazers_count/forks_count from a successful fetch', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ stargazers_count: 42, forks_count: 7 }),
    });
    const client = new GithubRepoStatsClient({
      url: 'https://api.github.com/repos/rh-aiservices-bu/school-of-sardeenz',
      fetchImpl: fetchImpl,
      now: () => now,
    });
    const config = makeConfig();
    const app = await buildApp(config, client);
    const res = await app.inject({ method: 'GET', url: '/api/repo-stats' });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      stars: 42,
      forks: 7,
      fetchedAt: new Date(now).toISOString(),
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('dedupes concurrent cold-cache calls into a single fetch', async () => {
    let resolveFetch: (value: unknown) => void = () => {};
    const fetchImpl = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );
    const client = new GithubRepoStatsClient({
      url: 'https://api.github.com/repos/rh-aiservices-bu/school-of-sardeenz',
      fetchImpl: fetchImpl,
      now: () => now,
    });

    const first = client.getStats();
    const second = client.getStats();
    resolveFetch({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ stargazers_count: 42, forks_count: 7 }),
    });

    expect(await first).toEqual(await second);
    expect((await first).stars).toBe(42);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not refetch a second call within the success TTL', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ stargazers_count: 1, forks_count: 2 }),
    });
    const client = new GithubRepoStatsClient({
      url: 'https://api.github.com/repos/rh-aiservices-bu/school-of-sardeenz',
      fetchImpl: fetchImpl,
      now: () => now,
    });
    const config = makeConfig();

    let app = await buildApp(config, client);
    await app.inject({ method: 'GET', url: '/api/repo-stats' });
    await app.close();

    now += 30 * 60 * 1000; // 30 minutes later, still within the 1h success TTL
    app = await buildApp(config, client);
    const res = await app.inject({ method: 'GET', url: '/api/repo-stats' });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('refetches after the success TTL expires', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ stargazers_count: 1, forks_count: 2 }),
    });
    const client = new GithubRepoStatsClient({
      url: 'https://api.github.com/repos/rh-aiservices-bu/school-of-sardeenz',
      fetchImpl: fetchImpl,
      now: () => now,
    });
    const config = makeConfig();

    let app = await buildApp(config, client);
    await app.inject({ method: 'GET', url: '/api/repo-stats' });
    await app.close();

    now += 61 * 60 * 1000; // past the 1h TTL
    app = await buildApp(config, client);
    await app.inject({ method: 'GET', url: '/api/repo-stats' });
    await app.close();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('returns nulls and caches for the shorter TTL on a non-2xx response, then refetches after it', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: () => Promise.resolve({}),
    });
    const client = new GithubRepoStatsClient({
      url: 'https://api.github.com/repos/rh-aiservices-bu/school-of-sardeenz',
      fetchImpl: fetchImpl,
      now: () => now,
    });
    const config = makeConfig();

    let app = await buildApp(config, client);
    let res = await app.inject({ method: 'GET', url: '/api/repo-stats' });
    await app.close();
    expect(res.json()).toEqual({ stars: null, forks: null, fetchedAt: null });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    now += 2 * 60 * 1000; // within the 5 minute failure TTL
    app = await buildApp(config, client);
    res = await app.inject({ method: 'GET', url: '/api/repo-stats' });
    await app.close();
    expect(res.json()).toEqual({ stars: null, forks: null, fetchedAt: null });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    now += 4 * 60 * 1000; // past the 5 minute failure TTL
    app = await buildApp(config, client);
    res = await app.inject({ method: 'GET', url: '/api/repo-stats' });
    await app.close();
    expect(res.json()).toEqual({ stars: null, forks: null, fetchedAt: null });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('returns nulls on a network error without throwing', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network unreachable'));
    const client = new GithubRepoStatsClient({
      url: 'https://api.github.com/repos/rh-aiservices-bu/school-of-sardeenz',
      fetchImpl: fetchImpl,
      now: () => now,
    });
    const config = makeConfig();
    const app = await buildApp(config, client);
    const res = await app.inject({ method: 'GET', url: '/api/repo-stats' });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ stars: null, forks: null, fetchedAt: null });
  });

  it('returns nulls on a malformed body without throwing', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ unexpected: 'shape' }),
    });
    const client = new GithubRepoStatsClient({
      url: 'https://api.github.com/repos/rh-aiservices-bu/school-of-sardeenz',
      fetchImpl: fetchImpl,
      now: () => now,
    });
    const config = makeConfig();
    const app = await buildApp(config, client);
    const res = await app.inject({ method: 'GET', url: '/api/repo-stats' });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ stars: null, forks: null, fetchedAt: null });
  });

  it('does not fetch when the repo stats URL is empty (disabled)', async () => {
    const fetchImpl = vi.fn();
    const client = new GithubRepoStatsClient({
      url: '',
      fetchImpl: fetchImpl,
      now: () => now,
    });
    const config = makeConfig({ repoStatsUrl: '' });
    const app = await buildApp(config, client);
    const res = await app.inject({ method: 'GET', url: '/api/repo-stats' });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ stars: null, forks: null, fetchedAt: null });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns 401 without a JWT when AUTH_MODE=simple', async () => {
    const client = new GithubRepoStatsClient({ url: '', now: () => now });
    const app = await buildApp(makeConfig({ authMode: 'simple' }), client);
    const res = await app.inject({ method: 'GET', url: '/api/repo-stats' });
    await app.close();

    expect(res.statusCode).toBe(401);
  });

  it('passes for an admin-readonly token', async () => {
    const config = makeConfig({ authMode: 'simple', repoStatsUrl: '' });
    const client = new GithubRepoStatsClient({ url: '', now: () => now });
    const app = await buildApp(config, client);
    const token = app.jwt.sign(
      { username: 'viewer', roles: ['admin-readonly'], authMode: 'simple' },
      { expiresIn: 3600 },
    );

    const res = await app.inject({
      method: 'GET',
      url: '/api/repo-stats',
      headers: { authorization: `Bearer ${token}` },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ stars: null, forks: null, fetchedAt: null });
  });
});
