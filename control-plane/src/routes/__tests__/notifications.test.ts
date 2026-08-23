// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerNotificationRoutes } from '../notifications.js';
import type { RouteDeps } from '../deps.js';

interface MockNotifications {
  listNotifications: ReturnType<typeof vi.fn>;
  markAsRead: ReturnType<typeof vi.fn>;
  markAllAsRead: ReturnType<typeof vi.fn>;
  removeNotification: ReturnType<typeof vi.fn>;
  clearAll: ReturnType<typeof vi.fn>;
  createNotification: ReturnType<typeof vi.fn>;
}

function createMockNotifications(): MockNotifications {
  return {
    listNotifications: vi.fn(),
    markAsRead: vi.fn(),
    markAllAsRead: vi.fn(),
    removeNotification: vi.fn(),
    clearAll: vi.fn(),
    createNotification: vi.fn(),
  };
}

function toDeps(mockNotifications: MockNotifications): RouteDeps {
  return {
    config: {} as RouteDeps['config'],
    modelRepository: {} as RouteDeps['modelRepository'],
    instanceRepository: {} as RouteDeps['instanceRepository'],
    lifecycle: {} as RouteDeps['lifecycle'],
    memoryBudget: {} as RouteDeps['memoryBudget'],
    workerPool: {} as RouteDeps['workerPool'],
    routingMap: {} as RouteDeps['routingMap'],
    placement: {} as RouteDeps['placement'],
    eviction: {} as RouteDeps['eviction'],
    sleepWake: {} as RouteDeps['sleepWake'],
    deployOrchestration: {} as RouteDeps['deployOrchestration'],
    leaderElection: {} as RouteDeps['leaderElection'],
    notifications: mockNotifications as unknown as RouteDeps['notifications'],
    catalogService: {} as RouteDeps['catalogService'],
    moduleStore: {} as RouteDeps['moduleStore'],
    weightsBrowser: {} as RouteDeps['weightsBrowser'],
    createRunnerClient: vi.fn(),
    createWorkerClient: vi.fn(),
  };
}

async function buildTestApp(deps: RouteDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  registerNotificationRoutes(app, deps);
  await app.ready();
  return app;
}

describe('Notification routes', () => {
  let app: FastifyInstance;
  let mockNotifications: MockNotifications;

  beforeEach(() => {
    mockNotifications = createMockNotifications();
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  describe('GET /api/v1/notifications', () => {
    it('returns notification list with 200', async () => {
      const notifications = [
        {
          id: 'n1',
          title: 'Test notification',
          variant: 'info',
          timestamp: '2026-06-29T10:00:00.000Z',
          isRead: false,
        },
      ];
      mockNotifications.listNotifications.mockResolvedValue(notifications);
      app = await buildTestApp(toDeps(mockNotifications));

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/notifications',
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ notifications });
      expect(mockNotifications.listNotifications).toHaveBeenCalledWith(50, 0);
    });

    it('passes limit and offset query parameters', async () => {
      mockNotifications.listNotifications.mockResolvedValue([]);
      app = await buildTestApp(toDeps(mockNotifications));

      await app.inject({
        method: 'GET',
        url: '/api/v1/notifications?limit=10&offset=5',
      });

      expect(mockNotifications.listNotifications).toHaveBeenCalledWith(10, 5);
    });
  });

  describe('POST /api/v1/notifications/:id/read', () => {
    it('calls markAsRead and returns 204', async () => {
      mockNotifications.markAsRead.mockResolvedValue(undefined);
      app = await buildTestApp(toDeps(mockNotifications));

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/notifications/test-id-123/read',
      });

      expect(res.statusCode).toBe(204);
      expect(mockNotifications.markAsRead).toHaveBeenCalledWith('test-id-123');
    });
  });

  describe('POST /api/v1/notifications/read-all', () => {
    it('calls markAllAsRead and returns 204', async () => {
      mockNotifications.markAllAsRead.mockResolvedValue(undefined);
      app = await buildTestApp(toDeps(mockNotifications));

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/notifications/read-all',
      });

      expect(res.statusCode).toBe(204);
      expect(mockNotifications.markAllAsRead).toHaveBeenCalled();
    });
  });

  describe('DELETE /api/v1/notifications/:id', () => {
    it('calls removeNotification and returns 204', async () => {
      mockNotifications.removeNotification.mockResolvedValue(undefined);
      app = await buildTestApp(toDeps(mockNotifications));

      const res = await app.inject({
        method: 'DELETE',
        url: '/api/v1/notifications/test-id-456',
      });

      expect(res.statusCode).toBe(204);
      expect(mockNotifications.removeNotification).toHaveBeenCalledWith('test-id-456');
    });
  });

  describe('DELETE /api/v1/notifications', () => {
    it('calls clearAll and returns 204', async () => {
      mockNotifications.clearAll.mockResolvedValue(undefined);
      app = await buildTestApp(toDeps(mockNotifications));

      const res = await app.inject({
        method: 'DELETE',
        url: '/api/v1/notifications',
      });

      expect(res.statusCode).toBe(204);
      expect(mockNotifications.clearAll).toHaveBeenCalled();
    });
  });
});
