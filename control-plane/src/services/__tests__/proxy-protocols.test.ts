// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { ProxyProtocolsService } from '../proxy-protocols.js';
import type { Redis } from '../../clients/redis.js';

function makeService(get: (key: string) => Promise<string | null>): ProxyProtocolsService {
  const redis = { get: vi.fn(get) } as unknown as Redis;
  return new ProxyProtocolsService(redis, 'sardeenz');
}

describe('ProxyProtocolsService', () => {
  it('returns the advertised protocol array when the key is present', async () => {
    const svc = makeService(() => Promise.resolve(JSON.stringify(['openai', 'oip'])));
    expect(await svc.getSupported()).toEqual(['openai', 'oip']);
  });

  it('returns null when the key is absent', async () => {
    const svc = makeService(() => Promise.resolve(null));
    expect(await svc.getSupported()).toBeNull();
  });

  it('returns null when the value is present but not a JSON array', async () => {
    const svc = makeService(() => Promise.resolve(JSON.stringify({ not: 'an array' })));
    expect(await svc.getSupported()).toBeNull();
  });

  it('returns null on malformed JSON', async () => {
    const svc = makeService(() => Promise.resolve('not-json{'));
    expect(await svc.getSupported()).toBeNull();
  });

  it('reads the byte-matching key sardeenz:proxy:protocols', async () => {
    const get = vi.fn(() => Promise.resolve(null));
    const redis = { get } as unknown as Redis;
    const svc = new ProxyProtocolsService(redis, 'sardeenz');
    await svc.getSupported();
    expect(get).toHaveBeenCalledWith('sardeenz:proxy:protocols');
  });
});
