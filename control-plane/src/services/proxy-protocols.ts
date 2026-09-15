import type { Redis } from '../clients/redis.js';
import { redisKey } from '../clients/redis.js';

// Reads the protocol families the running proxy advertises at the Redis string key
// `{prefix}:proxy:protocols` (written by the proxy on every (re)connect — proxy/src/state/
// redis_sync.rs). Used by the catalog import forward-compat guard (#125 Unit B item 4).
export class ProxyProtocolsService {
  private readonly key: string;
  constructor(
    private readonly redis: Redis,
    keyPrefix: string,
  ) {
    this.key = redisKey(keyPrefix, 'proxy', 'protocols');
  }

  // The advertised set, or null when the key is absent (proxy not started yet / older proxy).
  async getSupported(): Promise<string[] | null> {
    const raw = await this.redis.get(this.key);
    if (!raw) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : null;
    } catch {
      return null;
    }
  }
}
