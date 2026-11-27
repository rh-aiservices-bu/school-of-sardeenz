import { describe, expect, it, vi, type Mock } from 'vitest';
import { ModelState, Protocol } from '@sardeenz/types';

import { RoutingMapService } from '../routing-map.js';
import type { Redis } from '../../clients/redis.js';
import { redisKey } from '../../clients/redis.js';
import { registry } from '../../health/metrics.js';

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

describe('RoutingMapService protocol-tag protection (#309)', () => {
  // Both writes return { existed, conflict, entryProtocol }; the Lua — not JavaScript — decides
  // whether an existing entry keeps its tag, so the mocked eval result is the whole contract.
  function makeRedis(evalResult: [number, number, Protocol]): {
    redis: Redis;
    evalMock: Mock;
  } {
    const evalMock = vi.fn().mockResolvedValue(evalResult);
    return { redis: { eval: evalMock } as unknown as Redis, evalMock };
  }

  function makeLogger(): {
    debug: Mock;
    info: Mock;
    warn: Mock;
    error: Mock;
  } {
    return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  }

  async function conflicts(kind: 'entry-vs-caller' | 'instance-vs-instance'): Promise<number> {
    const metrics = await registry.getMetricsAsJSON();
    const metric = metrics.find(
      (m) => m.name === 'sardeenz_control_plane_routing_protocol_conflicts_total',
    );
    const sample = metric?.values.find((v) => v.labels.kind === kind);
    return sample?.value ?? 0;
  }

  it('setModelState without a protocol passes the empty-string "no authoritative value" sentinel', async () => {
    const { redis, evalMock } = makeRedis([1, 0, Protocol.oip]);
    const service = new RoutingMapService(redis, KEY_PREFIX, makeLogger());

    await service.setModelState('m1', ModelState.ACTIVE);

    // redis.eval(script, numKeys, hashKey, channel, modelName, state, protocol, now)
    const args = evalMock.mock.calls[0] as unknown[];
    expect(args[6]).toBe('');
  });

  it('setModelState conflict marker warns once (current vs incoming) and counts entry-vs-caller', async () => {
    const before = await conflicts('entry-vs-caller');
    const logger = makeLogger();
    const { redis } = makeRedis([1, 1, Protocol.oip]);
    const service = new RoutingMapService(redis, KEY_PREFIX, logger);

    await service.setModelState('m1', ModelState.ACTIVE, Protocol.openai);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      { modelName: 'm1', current: Protocol.oip, incoming: Protocol.openai },
      'Routing entry protocol kept: caller value disagreed',
    );
    expect((await conflicts('entry-vs-caller')) - before).toBe(1);
  });

  it('addEndpoint without a protocol passes the empty-string sentinel in ARGV[5]', async () => {
    const { redis, evalMock } = makeRedis([1, 0, Protocol.oip]);
    const service = new RoutingMapService(redis, KEY_PREFIX, makeLogger());

    await service.addEndpoint('m1', { host: '10.0.0.1', port: 8001, weight: 1, healthy: true });

    // redis.eval(script, numKeys, hashKey, channel, modelName, endpointJson, now, updateJson, protocol)
    const args = evalMock.mock.calls[0] as unknown[];
    expect(args[8]).toBe('');
  });

  it('addEndpoint conflict marker keeps the tag, warns with the runnerId and counts entry-vs-caller', async () => {
    const before = await conflicts('entry-vs-caller');
    const logger = makeLogger();
    const { redis } = makeRedis([1, 1, Protocol.oip]);
    const service = new RoutingMapService(redis, KEY_PREFIX, logger);

    await service.addEndpoint(
      'm1',
      { host: '10.0.0.1', port: 8001, weight: 1, healthy: true, runnerId: 'runner-abc' },
      Protocol.openai,
    );

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      {
        modelName: 'm1',
        current: Protocol.oip,
        incoming: Protocol.openai,
        runnerId: 'runner-abc',
      },
      'Routing entry protocol kept: caller value disagreed',
    );
    expect((await conflicts('entry-vs-caller')) - before).toBe(1);
  });

  it('counts a conflict even when no logger is configured (never fully silent)', async () => {
    const before = await conflicts('entry-vs-caller');
    const { redis } = makeRedis([1, 1, Protocol.oip]);
    const service = new RoutingMapService(redis, KEY_PREFIX);

    await expect(
      service.setModelState('m1', ModelState.ACTIVE, Protocol.openai),
    ).resolves.toBeUndefined();
    expect((await conflicts('entry-vs-caller')) - before).toBe(1);
  });

  it('an agreeing authoritative protocol neither warns nor counts', async () => {
    const before = await conflicts('entry-vs-caller');
    const logger = makeLogger();
    const { redis } = makeRedis([1, 0, Protocol.openai]);
    const service = new RoutingMapService(redis, KEY_PREFIX, logger);

    await service.setModelState('m1', ModelState.ACTIVE, Protocol.openai);

    expect(logger.warn).not.toHaveBeenCalled();
    expect((await conflicts('entry-vs-caller')) - before).toBe(0);
  });
});
