// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotificationService } from '../notification.js';
import type { Redis } from '../../clients/redis.js';
import type { NotificationLogger } from '../notification.js';

function createMockPipeline() {
  return {
    lpush: vi.fn().mockReturnThis(),
    ltrim: vi.fn().mockReturnThis(),
    lset: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue([]),
  };
}

const mockRedis = {
  lpush: vi.fn().mockResolvedValue(1),
  ltrim: vi.fn().mockResolvedValue('OK'),
  lrange: vi.fn().mockResolvedValue([]),
  lset: vi.fn().mockResolvedValue('OK'),
  lrem: vi.fn().mockResolvedValue(1),
  del: vi.fn().mockResolvedValue(1),
  publish: vi.fn().mockResolvedValue(1),
  pipeline: vi.fn(),
};

const mockLogger: NotificationLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

describe('NotificationService', () => {
  let service: NotificationService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRedis.pipeline.mockReturnValue(createMockPipeline());
    service = new NotificationService(mockRedis as unknown as Redis, 'test', mockLogger);
  });

  describe('createNotification', () => {
    it('stores notification in Redis list via pipeline and publishes to channel', async () => {
      const uuidSpy = vi.spyOn(crypto, 'randomUUID').mockReturnValue('test-0000-0000-0000-uuid123');
      const mockDate = new Date('2026-06-29T12:00:00.000Z');
      vi.spyOn(global, 'Date').mockImplementation(() => mockDate);

      const params = {
        title: 'Test notification',
        description: 'Test description',
        variant: 'info' as const,
      };

      const result = await service.createNotification(params);

      expect(result).toEqual({
        id: 'test-0000-0000-0000-uuid123',
        title: 'Test notification',
        description: 'Test description',
        variant: 'info',
        timestamp: '2026-06-29T12:00:00.000Z',
        isRead: false,
        source: undefined,
      });

      expect(uuidSpy).toHaveBeenCalled();
      const pipelineMock = createMockPipeline();
      mockRedis.pipeline.mockReturnValue(pipelineMock);
      expect(mockRedis.pipeline).toHaveBeenCalled();
      expect(mockRedis.publish).toHaveBeenCalledWith('test:notifications', JSON.stringify(result));

      vi.restoreAllMocks();
    });

    it('includes source when provided', async () => {
      vi.spyOn(crypto, 'randomUUID').mockReturnValue('test-0000-0000-0000-uuid456');

      const params = {
        title: 'Model deployed',
        variant: 'success' as const,
        source: { type: 'model' as const, name: 'llama-3' },
      };

      const result = await service.createNotification(params);

      expect(result.source).toEqual({ type: 'model', name: 'llama-3' });
      vi.restoreAllMocks();
    });

    it('logs error and rethrows when Redis pipeline fails', async () => {
      const testError = new Error('Redis connection lost');
      const failingPipeline = createMockPipeline();
      failingPipeline.exec = vi.fn().mockRejectedValue(testError);
      mockRedis.pipeline.mockReturnValue(failingPipeline);

      await expect(service.createNotification({ title: 'Test', variant: 'info' })).rejects.toThrow(
        'Redis connection lost',
      );

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(mockLogger.error).toHaveBeenCalledWith(
        { err: 'Redis connection lost' },
        'Failed to create notification',
      );
    });
  });

  describe('listNotifications', () => {
    it('returns parsed notifications as stored (isRead already in the JSON)', async () => {
      const notification1 = {
        id: 'n1',
        title: 'Notification 1',
        variant: 'info',
        timestamp: '2026-06-29T10:00:00.000Z',
        isRead: true,
      };
      const notification2 = {
        id: 'n2',
        title: 'Notification 2',
        variant: 'warning',
        timestamp: '2026-06-29T11:00:00.000Z',
        isRead: false,
      };

      mockRedis.lrange.mockResolvedValue([
        JSON.stringify(notification1),
        JSON.stringify(notification2),
      ]);

      const result = await service.listNotifications();

      expect(result).toEqual([notification1, notification2]);
      expect(mockRedis.lrange).toHaveBeenCalledWith('test:notifications', 0, 49);
    });

    it('handles custom limit and offset', async () => {
      mockRedis.lrange.mockResolvedValue([]);

      await service.listNotifications(10, 5);

      expect(mockRedis.lrange).toHaveBeenCalledWith('test:notifications', 5, 14);
    });
  });

  describe('markAsRead', () => {
    it('finds the notification by id and LSETs it with isRead true', async () => {
      const notification = {
        id: 'test-id-123',
        title: 'Target',
        variant: 'info',
        timestamp: '2026-06-29T10:00:00.000Z',
        isRead: false,
      };
      mockRedis.lrange.mockResolvedValue([JSON.stringify(notification)]);

      await service.markAsRead('test-id-123');

      expect(mockRedis.lset).toHaveBeenCalledWith(
        'test:notifications',
        0,
        JSON.stringify({ ...notification, isRead: true }),
      );
    });

    it('is a no-op when the notification is not found', async () => {
      mockRedis.lrange.mockResolvedValue([]);

      await service.markAsRead('nonexistent-id');

      expect(mockRedis.lset).not.toHaveBeenCalled();
    });
  });

  describe('markAllAsRead', () => {
    it('LSETs every notification in the list with isRead true', async () => {
      const notifications = [
        {
          id: 'n1',
          title: 'N1',
          variant: 'info',
          timestamp: '2026-06-29T10:00:00.000Z',
          isRead: false,
        },
        {
          id: 'n2',
          title: 'N2',
          variant: 'info',
          timestamp: '2026-06-29T11:00:00.000Z',
          isRead: false,
        },
      ];

      mockRedis.lrange.mockResolvedValue(notifications.map((n) => JSON.stringify(n)));
      const pipelineMock = createMockPipeline();
      mockRedis.pipeline.mockReturnValue(pipelineMock);

      await service.markAllAsRead();

      expect(mockRedis.lrange).toHaveBeenCalledWith('test:notifications', 0, -1);
      expect(pipelineMock.lset).toHaveBeenCalledWith(
        'test:notifications',
        0,
        JSON.stringify({ ...notifications[0], isRead: true }),
      );
      expect(pipelineMock.lset).toHaveBeenCalledWith(
        'test:notifications',
        1,
        JSON.stringify({ ...notifications[1], isRead: true }),
      );
      expect(pipelineMock.exec).toHaveBeenCalled();
    });

    it('skips the pipeline when list is empty', async () => {
      mockRedis.lrange.mockResolvedValue([]);

      await service.markAllAsRead();

      expect(mockRedis.pipeline).not.toHaveBeenCalled();
    });
  });

  describe('removeNotification', () => {
    it('finds notification in list by id and calls lrem', async () => {
      const notification = {
        id: 'target-id',
        title: 'Target',
        variant: 'info',
        timestamp: '2026-06-29T10:00:00.000Z',
      };
      const rawNotification = JSON.stringify(notification);

      mockRedis.lrange.mockResolvedValue([rawNotification]);

      await service.removeNotification('target-id');

      expect(mockRedis.lrem).toHaveBeenCalledWith('test:notifications', 1, rawNotification);
    });

    it('handles notification not found gracefully (no lrem call)', async () => {
      mockRedis.lrange.mockResolvedValue([
        JSON.stringify({
          id: 'other-id',
          title: 'Other',
          variant: 'info',
          timestamp: '2026-06-29T10:00:00.000Z',
        }),
      ]);

      await service.removeNotification('nonexistent-id');

      expect(mockRedis.lrem).not.toHaveBeenCalled();
    });
  });

  describe('clearAll', () => {
    it('calls del on the list key', async () => {
      await service.clearAll();

      expect(mockRedis.del).toHaveBeenCalledWith('test:notifications');
    });
  });
});
