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
const NOTIFICATIONS_CHANNEL = 'notifications';
const MAX_NOTIFICATIONS = 200;

export class NotificationService {
  private readonly listKey: string;
  private readonly channel: string;

  constructor(
    private readonly redis: Redis,
    keyPrefix: string,
    private readonly logger: NotificationLogger,
  ) {
    this.listKey = redisKey(keyPrefix, NOTIFICATIONS_LIST);
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
      const rawList = await this.redis.lrange(this.listKey, offset, offset + limit - 1);
      return rawList.map((raw: string) => JSON.parse(raw) as StoredNotification);
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
      const rawList = await this.redis.lrange(this.listKey, 0, -1);
      const index = rawList.findIndex(
        (raw: string) => (JSON.parse(raw) as StoredNotification).id === id,
      );
      if (index === -1) return;

      const notification = JSON.parse(rawList[index]) as StoredNotification;
      notification.isRead = true;
      await this.redis.lset(this.listKey, index, JSON.stringify(notification));
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
      if (rawList.length === 0) return;

      const pipeline = this.redis.pipeline();
      rawList.forEach((raw: string, index: number) => {
        const notification = JSON.parse(raw) as StoredNotification;
        notification.isRead = true;
        pipeline.lset(this.listKey, index, JSON.stringify(notification));
      });
      await pipeline.exec();
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
      await this.redis.del(this.listKey);
    } catch (err) {
      this.logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        'Failed to clear all notifications',
      );
      throw err;
    }
  }
}
