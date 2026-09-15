import { Redis } from 'ioredis';

import type { Config } from '../config.js';

export type { Redis };

export function createRedisClient(config: Config): Redis {
  return new Redis(config.redisUrl, {
    keyPrefix: '',
    lazyConnect: true,
    retryStrategy(times: number) {
      return Math.min(times * 200, 5000);
    },
  });
}

export function createSubscriber(config: Config): Redis {
  return new Redis(config.redisUrl, {
    keyPrefix: '',
    lazyConnect: true,
    retryStrategy(times: number) {
      return Math.min(times * 200, 5000);
    },
  });
}

export function redisKey(prefix: string, ...parts: string[]): string {
  return [prefix, ...parts].join(':');
}
