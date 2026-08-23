// @vitest-environment node
import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import type { FastifyInstance } from 'fastify';
import { registerConfigRoutes } from '../../routes/config.js';
import { authPlugin } from '../../plugins/auth.js';
import { BffError } from '../../errors.js';
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
    inferenceUrl: 'http://inference.test:8080',
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

function buildDeps(config: Config): RouteDeps {
  return {
    config,
    controlPlane: {} as unknown as RouteDeps['controlPlane'],
    redis: {} as unknown as RouteDeps['redis'],
    prometheus: {} as unknown as RouteDeps['prometheus'],
    inference: {} as unknown as RouteDeps['inference'],
  };
}

async function buildApp(config: Config): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof BffError) {
      return reply.code(error.statusCode).send(error.toResponse());
    }
    return reply.code(500).send({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });

  await app.register(fastifyCookie);
  await app.register(authPlugin, { config });
  registerConfigRoutes(app, buildDeps(config));
  await app.ready();
  return app;
}

describe('GET /api/config', () => {
  it('returns only { inferenceUrl }', async () => {
    const config = makeConfig();
    const app = await buildApp(config);
    const res = await app.inject({ method: 'GET', url: '/api/config' });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ inferenceUrl: config.inferenceUrl });
  });

  it('returns 401 without a JWT when AUTH_MODE=simple', async () => {
    const app = await buildApp(makeConfig({ authMode: 'simple' }));
    const res = await app.inject({ method: 'GET', url: '/api/config' });
    await app.close();

    expect(res.statusCode).toBe(401);
  });

  it('passes for an admin-readonly token', async () => {
    const config = makeConfig({ authMode: 'simple' });
    const app = await buildApp(config);
    const token = app.jwt.sign(
      { username: 'viewer', roles: ['admin-readonly'], authMode: 'simple' },
      { expiresIn: 3600 },
    );

    const res = await app.inject({
      method: 'GET',
      url: '/api/config',
      headers: { authorization: `Bearer ${token}` },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ inferenceUrl: config.inferenceUrl });
  });

  it('never leaks a secret-bearing config field', async () => {
    const config = makeConfig();
    const app = await buildApp(config);
    const res = await app.inject({ method: 'GET', url: '/api/config' });
    await app.close();

    const body = res.json<Record<string, unknown>>();
    expect(Object.keys(body)).toEqual(['inferenceUrl']);
    expect(body).not.toHaveProperty('adminPassword');
    expect(body).not.toHaveProperty('jwtSecret');
    expect(body).not.toHaveProperty('oauthClientSecret');
    expect(body).not.toHaveProperty('controlPlaneApiToken');
    expect(JSON.stringify(body)).not.toContain(config.adminPassword);
    expect(JSON.stringify(body)).not.toContain(config.jwtSecret);
    expect(JSON.stringify(body)).not.toContain(config.oauthClientSecret);
    expect(JSON.stringify(body)).not.toContain(config.controlPlaneApiToken);
  });
});
