import { Redis } from 'ioredis';
import type { Config } from '../config.js';

export class RedisReader {
  private readonly client: Redis;
  private readonly prefix: string;

  constructor(config: Config) {
    this.client = new Redis(config.redisUrl, {
      maxRetriesPerRequest: 3,
      retryStrategy: (times: number) => Math.min(times * 200, 2000),
    });
    this.prefix = config.redisKeyPrefix;
  }

  async isHealthy(): Promise<boolean> {
    try {
      const pong = await this.client.ping();
      return pong === 'PONG';
    } catch {
      return false;
    }
  }

  close(): void {
    this.client.disconnect();
  }
}
