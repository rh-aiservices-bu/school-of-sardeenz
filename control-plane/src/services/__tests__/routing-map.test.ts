import { describe, expect, it, vi } from 'vitest';

import { RoutingMapService } from '../routing-map.js';
import type { Redis } from '../../clients/redis.js';
import { redisKey } from '../../clients/redis.js';

const KEY_PREFIX = 'test';
const PROXY_ID = 'proxy-a';
const PRESENCE_KEY = redisKey(KEY_PREFIX, 'proxies', PROXY_ID);
const ACK_KEY_PATTERN = /^test:routing-barrier-acks:/;

function makeBarrierRedis(opts: { presence: Array<string | null>; acks?: string[][] }): {
  redis: Redis;
  get: ReturnType<typeof vi.fn>;
  scan: ReturnType<typeof vi.fn>;
  smembers: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
} {
  let presenceCall = 0;
  let acksCall = 0;
  // The last scripted value repeats, so a case only lists the transitions it cares about.
  const get = vi.fn(() =>
    Promise.resolve(opts.presence[Math.min(presenceCall++, opts.presence.length - 1)] ?? null),
  );
  const scan = vi.fn().mockResolvedValue(['0', [PRESENCE_KEY]]);
  const smembers = vi.fn(() => {
    const next = opts.acks?.[Math.min(acksCall++, (opts.acks?.length ?? 1) - 1)] ?? [];
    return Promise.resolve(next);
  });
  const evalMock = vi.fn().mockResolvedValue([1, 0]);
  const del = vi.fn().mockResolvedValue(1);
  const redis = { get, scan, smembers, eval: evalMock, del } as unknown as Redis;
  return { redis, get, scan, smembers, del };
}

describe('RoutingMapService.cutoverEndpointAndWait', () => {
  it("resolves as soon as a required proxy's presence lease expires", async () => {
    // Pre-fix trace (#322): the third read returns null, `Number(null)` is 0 — finite and
    // <= cutoverStartedMs — so the proxy stays outstanding and the barrier would spin for
    // ROUTING_BARRIER_TIMEOUT_MS instead of returning, failing this test on the unit timeout.
    const old = String(Date.now() - 1_000);
    const { redis, get, del } = makeBarrierRedis({ presence: [old, old, null] });
    const service = new RoutingMapService(redis, KEY_PREFIX);

    const startedAt = Date.now();
    await expect(service.cutoverEndpointAndWait('m1', '10.0.0.1', 8001)).resolves.toBe(true);

    expect(get).toHaveBeenCalledTimes(3);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(del).toHaveBeenCalledTimes(1);
    expect(del).toHaveBeenCalledWith(expect.stringMatching(ACK_KEY_PATTERN));
  });

  it('ignores a proxy whose presence timestamp is newer than the cutover start (reconnect)', async () => {
    const old = String(Date.now() - 1_000);
    const reconnectedAt = String(Date.now() + 60_000);
    const { redis, get, smembers, del } = makeBarrierRedis({
      presence: [old, reconnectedAt],
    });
    const service = new RoutingMapService(redis, KEY_PREFIX);

    await expect(service.cutoverEndpointAndWait('m1', '10.0.0.1', 8001)).resolves.toBe(true);

    expect(get).toHaveBeenCalledTimes(2);
    expect(smembers).toHaveBeenCalledTimes(1);
    expect(del).toHaveBeenCalledOnce();
  });

  it('is vacuously quiescent when a scanned presence key has already expired', async () => {
    const { redis, smembers, del } = makeBarrierRedis({ presence: [null] });
    const service = new RoutingMapService(redis, KEY_PREFIX);

    await expect(service.cutoverEndpointAndWait('m1', '10.0.0.1', 8001)).resolves.toBe(true);

    expect(smembers).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });

  it('treats an empty presence value like a missing key', async () => {
    const { redis, smembers, del } = makeBarrierRedis({ presence: [''] });
    const service = new RoutingMapService(redis, KEY_PREFIX);

    await expect(service.cutoverEndpointAndWait('m1', '10.0.0.1', 8001)).resolves.toBe(true);

    expect(smembers).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });

  it('keeps polling while a live presence lease has not acknowledged', async () => {
    const old = String(Date.now() - 1_000);
    const { redis, get, smembers } = makeBarrierRedis({
      presence: [old],
      acks: [[], [], [PROXY_ID]],
    });
    const service = new RoutingMapService(redis, KEY_PREFIX);

    await expect(service.cutoverEndpointAndWait('m1', '10.0.0.1', 8001)).resolves.toBe(true);

    // Three polls: two unacknowledged (each re-reading the presence key) then the ack, which
    // short-circuits before the presence read — 1 snapshot + 2 poll reads.
    expect(smembers).toHaveBeenCalledTimes(3);
    expect(get).toHaveBeenCalledTimes(3);
  });
});
