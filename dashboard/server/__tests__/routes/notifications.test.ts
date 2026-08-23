// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { registerNotificationRoutes } from '../../routes/notifications.js';
import { authPlugin } from '../../plugins/auth.js';
import { BffError } from '../../errors.js';
import type { RouteDeps } from '../../routes/deps.js';
import type { Config } from '../../config.js';

const mockConfig: Config = {
  listenAddr: '0.0.0.0',
  listenPort: 4000,
  logLevel: 'silent',
  controlPlaneUrl: 'http://cp.test',
  redisUrl: 'redis://localhost:6379',
  redisKeyPrefix: 'sardeenz',
  prometheusUrl: 'http://prom.test',
  inferenceUrl: 'http://inference.test',
  authMode: 'none',
  adminUsername: 'admin',
  adminPassword: '',
  jwtSecret: '',
  jwtExpirationHours: 8,
  oauthClientId: 'sardeenz',
  oauthClientSecret: '',
  oauthIssuerUrl: '',
  k8sApiUrl: '',
  namespace: 'sardeenz',
  controlPlaneApiToken: '',
  publicUrl: '',
};

const listNotificationsFn = vi.fn();
const markNotificationReadFn = vi.fn();
const markAllNotificationsReadFn = vi.fn();
const removeNotificationFn = vi.fn();
const clearAllNotificationsFn = vi.fn();

function buildDeps(): RouteDeps {
  return {
    config: mockConfig,
    controlPlane: {
      proxyRequest: vi.fn(),
      listModels: vi.fn(),
      getModel: vi.fn(),
      deployModel: vi.fn(),
      deleteModel: vi.fn(),
      sleepModel: vi.fn(),
      wakeModel: vi.fn(),
      listWorkers: vi.fn(),
      getWorker: vi.fn(),
      getClusterStatus: vi.fn(),
      getClusterMemory: vi.fn(),
      listNotifications: listNotificationsFn,
      markNotificationRead: markNotificationReadFn,
      markAllNotificationsRead: markAllNotificationsReadFn,
      removeNotification: removeNotificationFn,
      clearAllNotifications: clearAllNotificationsFn,
      isHealthy: vi.fn(),
    } as unknown as RouteDeps['controlPlane'],
    redis: {
      listModels: vi.fn(),
      getModel: vi.fn(),
      getModelNames: vi.fn(),
      listWorkers: vi.fn(),
      getClusterStatus: vi.fn(),
      createSubscriber: vi.fn(),
      isHealthy: vi.fn(),
      keyPrefix: 'sardeenz',
      close: vi.fn(),
    } as unknown as RouteDeps['redis'],
    prometheus: {
      queryRange: vi.fn(),
      queryInstant: vi.fn(),
      isHealthy: vi.fn(),
    } as unknown as RouteDeps['prometheus'],
    inference: {
      chatCompletions: vi.fn(),
      isHealthy: vi.fn(),
    } as unknown as RouteDeps['inference'],
  };
}

async function buildApp(deps: RouteDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof BffError) {
      return reply.code(error.statusCode).send(error.toResponse());
    }
    return reply.code(500).send({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });
  await app.register(authPlugin, { config: mockConfig });
  registerNotificationRoutes(app, deps);
  await app.ready();
  return app;
}

async function buildAppWithConfig(config: Config, deps: RouteDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof BffError) {
      return reply.code(error.statusCode).send(error.toResponse());
    }
    return reply.code(500).send({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });
  await app.register(authPlugin, { config });
  registerNotificationRoutes(app, deps);
  await app.ready();
  return app;
}

describe('GET /api/notifications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('proxies to control plane and returns the response on success', async () => {
    const notifications = [
      {
        id: 'n1',
        title: 'Test notification',
        variant: 'info',
        timestamp: '2026-06-29T10:00:00.000Z',
        isRead: false,
      },
    ];
    listNotificationsFn.mockResolvedValue({
      status: 200,
      data: { notifications },
    });

    const app = await buildApp(buildDeps());
    const res = await app.inject({ method: 'GET', url: '/api/notifications' });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ notifications });
    expect(listNotificationsFn).toHaveBeenCalledWith(undefined, undefined);
  });

  it('passes limit and offset query parameters to control plane', async () => {
    listNotificationsFn.mockResolvedValue({ status: 200, data: { notifications: [] } });

    const app = await buildApp(buildDeps());
    await app.inject({ method: 'GET', url: '/api/notifications?limit=10&offset=5' });
    await app.close();

    expect(listNotificationsFn).toHaveBeenCalledWith(10, 5);
  });
});

describe('POST /api/notifications/:id/read', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('proxies to control plane and returns 204 on success', async () => {
    markNotificationReadFn.mockResolvedValue({ status: 204, data: undefined });

    const app = await buildApp(buildDeps());
    const res = await app.inject({
      method: 'POST',
      url: '/api/notifications/test-id-123/read',
    });
    await app.close();

    expect(res.statusCode).toBe(204);
    expect(markNotificationReadFn).toHaveBeenCalledWith('test-id-123');
  });
});

describe('POST /api/notifications/read-all', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('proxies to control plane and returns 204 on success', async () => {
    markAllNotificationsReadFn.mockResolvedValue({ status: 204, data: undefined });

    const app = await buildApp(buildDeps());
    const res = await app.inject({ method: 'POST', url: '/api/notifications/read-all' });
    await app.close();

    expect(res.statusCode).toBe(204);
    expect(markAllNotificationsReadFn).toHaveBeenCalled();
  });
});

describe('DELETE /api/notifications/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('proxies to control plane and returns 204 on success', async () => {
    removeNotificationFn.mockResolvedValue({ status: 204, data: undefined });

    const app = await buildApp(buildDeps());
    const res = await app.inject({ method: 'DELETE', url: '/api/notifications/test-id-456' });
    await app.close();

    expect(res.statusCode).toBe(204);
    expect(removeNotificationFn).toHaveBeenCalledWith('test-id-456');
  });
});

describe('DELETE /api/notifications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('proxies to control plane and returns 204 on success', async () => {
    clearAllNotificationsFn.mockResolvedValue({ status: 204, data: undefined });

    const app = await buildApp(buildDeps());
    const res = await app.inject({ method: 'DELETE', url: '/api/notifications' });
    await app.close();

    expect(res.statusCode).toBe(204);
    expect(clearAllNotificationsFn).toHaveBeenCalled();
  });
});

describe('notification route role enforcement', () => {
  const simpleConfig: Config = { ...mockConfig, authMode: 'simple', jwtSecret: 'test-jwt-secret-that-is-long-enough' };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('admin-readonly can GET /api/notifications', async () => {
    listNotificationsFn.mockResolvedValue({ status: 200, data: { notifications: [] } });
    const app = await buildAppWithConfig(simpleConfig, buildDeps());
    const token = app.jwt.sign(
      { username: 'viewer', roles: ['admin-readonly'], authMode: 'simple' },
      { expiresIn: 3600 },
    );

    const res = await app.inject({
      method: 'GET',
      url: '/api/notifications',
      headers: { authorization: `Bearer ${token}` },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
  });

  it('admin-readonly can POST mark-as-read', async () => {
    markNotificationReadFn.mockResolvedValue({ status: 204, data: undefined });
    const app = await buildAppWithConfig(simpleConfig, buildDeps());
    const token = app.jwt.sign(
      { username: 'viewer', roles: ['admin-readonly'], authMode: 'simple' },
      { expiresIn: 3600 },
    );

    const res = await app.inject({
      method: 'POST',
      url: '/api/notifications/n1/read',
      headers: { authorization: `Bearer ${token}` },
    });
    await app.close();

    expect(res.statusCode).toBe(204);
  });

  it('admin-readonly can POST read-all', async () => {
    markAllNotificationsReadFn.mockResolvedValue({ status: 204, data: undefined });
    const app = await buildAppWithConfig(simpleConfig, buildDeps());
    const token = app.jwt.sign(
      { username: 'viewer', roles: ['admin-readonly'], authMode: 'simple' },
      { expiresIn: 3600 },
    );

    const res = await app.inject({
      method: 'POST',
      url: '/api/notifications/read-all',
      headers: { authorization: `Bearer ${token}` },
    });
    await app.close();

    expect(res.statusCode).toBe(204);
  });

  it('admin-readonly gets 403 on DELETE /api/notifications/:id', async () => {
    const app = await buildAppWithConfig(simpleConfig, buildDeps());
    const token = app.jwt.sign(
      { username: 'viewer', roles: ['admin-readonly'], authMode: 'simple' },
      { expiresIn: 3600 },
    );

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/notifications/n1',
      headers: { authorization: `Bearer ${token}` },
    });
    await app.close();

    expect(res.statusCode).toBe(403);
    expect(removeNotificationFn).not.toHaveBeenCalled();
  });

  it('admin-readonly gets 403 on DELETE /api/notifications', async () => {
    const app = await buildAppWithConfig(simpleConfig, buildDeps());
    const token = app.jwt.sign(
      { username: 'viewer', roles: ['admin-readonly'], authMode: 'simple' },
      { expiresIn: 3600 },
    );

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/notifications',
      headers: { authorization: `Bearer ${token}` },
    });
    await app.close();

    expect(res.statusCode).toBe(403);
    expect(clearAllNotificationsFn).not.toHaveBeenCalled();
  });

  it('admin can DELETE /api/notifications/:id', async () => {
    removeNotificationFn.mockResolvedValue({ status: 204, data: undefined });
    const app = await buildAppWithConfig(simpleConfig, buildDeps());
    const token = app.jwt.sign(
      { username: 'admin', roles: ['admin'], authMode: 'simple' },
      { expiresIn: 3600 },
    );

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/notifications/n1',
      headers: { authorization: `Bearer ${token}` },
    });
    await app.close();

    expect(res.statusCode).toBe(204);
    expect(removeNotificationFn).toHaveBeenCalledWith('n1');
  });

  it('admin can DELETE /api/notifications', async () => {
    clearAllNotificationsFn.mockResolvedValue({ status: 204, data: undefined });
    const app = await buildAppWithConfig(simpleConfig, buildDeps());
    const token = app.jwt.sign(
      { username: 'admin', roles: ['admin'], authMode: 'simple' },
      { expiresIn: 3600 },
    );

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/notifications',
      headers: { authorization: `Bearer ${token}` },
    });
    await app.close();

    expect(res.statusCode).toBe(204);
    expect(clearAllNotificationsFn).toHaveBeenCalled();
  });
});
