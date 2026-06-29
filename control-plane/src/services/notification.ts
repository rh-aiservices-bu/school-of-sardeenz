import type { Redis } from '../clients/redis.js';
import { redisKey } from '../clients/redis.js';

export interface NotificationParams {
  title: string;
  description?: string;
  variant: 'success' | 'warning' | 'danger' | 'info';
  source?: { type: 'model' | 'worker' | 'system'; name?: string };
}

export interface StoredNotification {
  id: string;
  title: string;
  description?: string;
  variant: string;
  timestamp: string;
  isRead: boolean;
  source?: { type: string; name?: string };
}

export interface NotificationLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

const NOTIFICATIONS_LIST = 'notifications';
const NOTIFICATIONS_READ_SET = 'notifications:read';
const NOTIFICATIONS_CHANNEL = 'notifications';
const MAX_NOTIFICATIONS = 200;

export class NotificationService {
  private readonly listKey: string;
  private readonly readSetKey: string;
  private readonly channel: string;

  constructor(
    private readonly redis: Redis,
    keyPrefix: string,
    private readonly logger: NotificationLogger,
  ) {
    this.listKey = redisKey(keyPrefix, NOTIFICATIONS_LIST);
    this.readSetKey = redisKey(keyPrefix, NOTIFICATIONS_READ_SET);
    this.channel = redisKey(keyPrefix, NOTIFICATIONS_CHANNEL);
  }

  async createNotification(params: NotificationParams): Promise<StoredNotification> {
    const notification: StoredNotification = {
      id: crypto.randomUUID(),
      title: params.title,
      description: params.description,
      variant: params.variant,
      timestamp: new Date().toISOString(),
      isRead: false,
      source: params.source,
    };

    try {
      const pipeline = this.redis.pipeline();
      pipeline.lpush(this.listKey, JSON.stringify(notification));
      pipeline.ltrim(this.listKey, 0, MAX_NOTIFICATIONS - 1);
      await pipeline.exec();

      await this.redis.publish(this.channel, JSON.stringify(notification));
    } catch (err) {
      this.logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        'Failed to create notification',
      );
      throw err;
    }

    return notification;
  }

  async listNotifications(limit = 50, offset = 0): Promise<StoredNotification[]> {
    try {
      const [rawList, readIds] = await Promise.all([
        this.redis.lrange(this.listKey, offset, offset + limit - 1),
        this.redis.smembers(this.readSetKey),
      ]);

      const readSet = new Set(readIds);

      return rawList.map((raw: string) => {
        const notification = JSON.parse(raw) as StoredNotification;
        notification.isRead = readSet.has(notification.id);
        return notification;
      });
    } catch (err) {
      this.logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        'Failed to list notifications',
      );
      throw err;
    }
  }

  async markAsRead(id: string): Promise<void> {
    try {
      await this.redis.sadd(this.readSetKey, id);
    } catch (err) {
      this.logger.error(
        { id, err: err instanceof Error ? err.message : String(err) },
        'Failed to mark notification as read',
      );
      throw err;
    }
  }

  async markAllAsRead(): Promise<void> {
    try {
      const rawList = await this.redis.lrange(this.listKey, 0, -1);
      const ids = rawList.map((raw: string) => (JSON.parse(raw) as StoredNotification).id);

      if (ids.length > 0) {
        await this.redis.sadd(this.readSetKey, ...ids);
      }
    } catch (err) {
      this.logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        'Failed to mark all notifications as read',
      );
      throw err;
    }
  }

  async removeNotification(id: string): Promise<void> {
    try {
      const rawList = await this.redis.lrange(this.listKey, 0, -1);
      const target = rawList.find((raw: string) => {
        const n = JSON.parse(raw) as StoredNotification;
        return n.id === id;
      });

      if (target) {
        await this.redis.lrem(this.listKey, 1, target);
      }

      await this.redis.srem(this.readSetKey, id);
    } catch (err) {
      this.logger.error(
        { id, err: err instanceof Error ? err.message : String(err) },
        'Failed to remove notification',
      );
      throw err;
    }
  }

  async clearAll(): Promise<void> {
    try {
      await this.redis.del(this.listKey, this.readSetKey);
    } catch (err) {
      this.logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        'Failed to clear all notifications',
      );
      throw err;
    }
  }
}
