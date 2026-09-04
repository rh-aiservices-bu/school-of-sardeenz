import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  DeviceType,
  ModelLifecycleState,
  ModelState,
  Protocol,
  RunnerState,
} from '@sardeenz/types';

import { canConnect, createHarness, type TestHarness } from './helpers/harness.js';
import { createMockRunner, type MockRunnerServer } from './helpers/mock-runner.js';
import { createMockWorker, type MockWorkerServer } from './helpers/mock-worker.js';
import { RunnerClient } from '../../clients/runner.js';
import { redisKey } from '../../clients/redis.js';
import type { RunnerEndpoint } from '../../services/routing-map.js';

const AVAILABLE = await canConnect();

const WORKER_ID = 'w1';
const MEM = 8_000_000_000;

async function deployModel(
  harness: TestHarness,
  runner: MockRunnerServer,
  worker: MockWorkerServer,
  modelName: string,
  instanceId: string,
): Promise<void> {
  await harness.registerWorker({
    workerId: WORKER_ID,
    managementUrl: worker.url,
    devices: [{ deviceIndex: 0, deviceType: DeviceType.CUDA, memoryTotalBytes: 16_000_000_000 }],
  });

  await harness.modelRepository.create({
    name: modelName,
    runnerType: 'vllm',
    modelPath: `/models/${modelName}`,
    requiredMemory: MEM,
    deviceType: 'CUDA',
  });

  await harness.lifecycle.createInstance(modelName, instanceId, WORKER_ID);
  await harness.lifecycle.transition(modelName, instanceId, ModelLifecycleState.STARTING);

  runner.setHealthState(RunnerState.READY);

  await harness.deployOrchestration.deployModel({
    protocol: Protocol.openai,
    modelName,
    instanceId,
    workerId: WORKER_ID,
    runnerType: 'vllm',
    modelPath: `/models/${modelName}`,
    requiredMemory: MEM,
    tensorParallel: 1,
    devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
  });
}

describe.skipIf(!AVAILABLE)('Routing map serialization integration (#79)', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = createHarness();
    await harness.setup();
  });

  afterEach(async () => {
    await harness?.teardown();
  });

  it('happy path: removing one of multiple endpoints leaves endpoints as a JSON array', async () => {
    const MODEL = 'multi-endpoint-model';
    const HASH = redisKey(harness.keyPrefix, 'routing-map');

    const epA: RunnerEndpoint = { host: '10.0.0.1', port: 8001, weight: 1, healthy: true };
    const epB: RunnerEndpoint = { host: '10.0.0.2', port: 8002, weight: 1, healthy: true };

    await harness.routingMap.addEndpoint(MODEL, epA);
    await harness.routingMap.addEndpoint(MODEL, epB);
    await harness.routingMap.removeEndpoint(MODEL, epA.host, epA.port);

    const raw = await harness.redis.hget(HASH, MODEL);
    expect(raw).not.toBeNull();
    expect(raw).toContain('"endpoints":[');

    const parsed = JSON.parse(raw as string) as { endpoints: unknown };
    expect(Array.isArray(parsed.endpoints)).toBe(true);
    expect((parsed.endpoints as unknown[]).length).toBe(1);
  });

  it('regression: removing the last endpoint encodes endpoints as [] never {}', async () => {
    const MODEL = 'last-endpoint-model';
    const HASH = redisKey(harness.keyPrefix, 'routing-map');

    const ep: RunnerEndpoint = { host: '10.0.0.3', port: 8003, weight: 1, healthy: true };

    await harness.routingMap.addEndpoint(MODEL, ep);
    await harness.routingMap.removeEndpoint(MODEL, ep.host, ep.port);

    const raw = await harness.redis.hget(HASH, MODEL);
    expect(raw).not.toBeNull();
    expect(raw).toContain('"endpoints":[]');
    expect(raw).not.toContain('"endpoints":{}');

    const parsed = JSON.parse(raw as string) as { endpoints: unknown };
    expect(Array.isArray(parsed.endpoints)).toBe(true);
    expect((parsed.endpoints as unknown[]).length).toBe(0);
  });

  // Documented fallback (per Blueprint) if this mock runner/worker path proves flaky in CI:
  // drop the deployModel()/sleepModel() call and instead exercise the same sequence sleepModel
  // drives directly against the harness — addEndpoint(M, ep) -> removeEndpoint(M, ep.host,
  // ep.port) -> setModelState(M, ModelState.SLEEPING) -> assert raw. Not needed here; the mock
  // pair matches the sleep-wake.integration.test.ts exemplar exactly.
  it('regression: full sleepModel round-trip encodes endpoints as [] never {}', async () => {
    const MODEL = 'sleep-roundtrip-model';
    const INSTANCE_ID = 'inst-sleep-roundtrip';
    const HASH = redisKey(harness.keyPrefix, 'routing-map');

    const runner = await createMockRunner();
    const worker = await createMockWorker(runner);
    try {
      runner.setActiveRequests(0);

      await deployModel(harness, runner, worker, MODEL, INSTANCE_ID);

      const runnerClient = new RunnerClient({ host: runner.host, port: runner.port });
      runner.setActiveRequests(0);
      await harness.sleepWake.sleepModel(MODEL, INSTANCE_ID, runnerClient);

      const raw = await harness.redis.hget(HASH, MODEL);
      expect(raw).not.toBeNull();
      expect(raw).toContain('"endpoints":[]');
      expect(raw).not.toContain('"endpoints":{}');

      const parsed = JSON.parse(raw as string) as { endpoints: unknown };
      expect(Array.isArray(parsed.endpoints)).toBe(true);
    } finally {
      await worker.close();
      await runner.close();
    }
  });

  it('regression: transitioning with an empty deviceIndices array encodes [] never {}', async () => {
    const MODEL = 'empty-devices-model';
    const INSTANCE_ID = 'inst-empty-devices';
    const MODEL2 = 'nonempty-devices-model';
    const INSTANCE_ID2 = 'inst-nonempty-devices';

    await harness.lifecycle.createInstance(MODEL, INSTANCE_ID);
    const raw = await harness.lifecycle.transition(
      MODEL,
      INSTANCE_ID,
      ModelLifecycleState.STARTING,
      {
        deviceIndices: [],
      },
    );
    expect(raw.deviceIndices).toEqual([]);

    const rawState = await harness.redis.get(
      redisKey(harness.keyPrefix, 'models', MODEL, INSTANCE_ID),
    );
    expect(rawState).not.toBeNull();
    expect(rawState).toContain('"deviceIndices":[]');
    expect(rawState).not.toContain('"deviceIndices":{}');

    const parsed = JSON.parse(rawState as string) as { deviceIndices: unknown };
    expect(Array.isArray(parsed.deviceIndices)).toBe(true);
    expect((parsed.deviceIndices as unknown[]).length).toBe(0);

    // Non-empty arrays must keep round-tripping correctly.
    await harness.lifecycle.createInstance(MODEL2, INSTANCE_ID2);
    const raw2 = await harness.lifecycle.transition(
      MODEL2,
      INSTANCE_ID2,
      ModelLifecycleState.STARTING,
      { deviceIndices: [0, 1] },
    );
    expect(raw2.deviceIndices).toEqual([0, 1]);
  });

  it('persists protocol on the routing entry and preserves it across state changes (#125)', async () => {
    const MODEL = 'protocol-roundtrip-model';
    const HASH = redisKey(harness.keyPrefix, 'routing-map');
    const ep: RunnerEndpoint = { host: '10.0.0.9', port: 8009, weight: 1, healthy: true };

    await harness.routingMap.addEndpoint(MODEL, ep, Protocol.oip);
    await harness.routingMap.setModelState(MODEL, ModelState.SLEEPING, Protocol.oip);

    const raw = await harness.redis.hget(HASH, MODEL);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw as string) as { protocol: string; endpoints: unknown[] };
    expect(parsed.protocol).toBe('oip');
    expect(Array.isArray(parsed.endpoints)).toBe(true);
  });

  it('addEndpoint with omitted protocol defaults to openai (Lua ARGV[5] default)', async () => {
    const MODEL = 'protocol-default-model';
    const HASH = redisKey(harness.keyPrefix, 'routing-map');
    const ep: RunnerEndpoint = { host: '10.0.0.10', port: 8010, weight: 1, healthy: true };

    await harness.routingMap.addEndpoint(MODEL, ep);

    const raw = await harness.redis.hget(HASH, MODEL);
    const parsed = JSON.parse(raw as string) as { protocol: string };
    expect(parsed.protocol).toBe('openai');
  });

  it('updateEndpointHealth and removeEndpoint preserve a pre-set protocol', async () => {
    const MODEL = 'protocol-preserve-model';
    const HASH = redisKey(harness.keyPrefix, 'routing-map');
    const ep: RunnerEndpoint = { host: '10.0.0.11', port: 8011, weight: 1, healthy: true };

    await harness.routingMap.addEndpoint(MODEL, ep, Protocol.oip);
    await harness.routingMap.updateEndpointHealth(MODEL, ep.host, ep.port, false);

    let raw = await harness.redis.hget(HASH, MODEL);
    let parsed = JSON.parse(raw as string) as { protocol: string };
    expect(parsed.protocol).toBe('oip');

    await harness.routingMap.removeEndpoint(MODEL, ep.host, ep.port);
    raw = await harness.redis.hget(HASH, MODEL);
    parsed = JSON.parse(raw as string) as { protocol: string };
    expect(parsed.protocol).toBe('oip');
  });

  it('does not restore a cutover weight when a state refresh races it', async () => {
    const MODEL = 'state-weight-race-model';
    const ep: RunnerEndpoint = { host: '10.0.0.12', port: 8012, weight: 1, healthy: true };
    await harness.routingMap.addEndpoint(MODEL, ep);

    await Promise.all(
      Array.from({ length: 20 }, () =>
        Promise.all([
          harness.routingMap.setModelState(MODEL, ModelState.ACTIVE),
          harness.routingMap.updateEndpointWeight(MODEL, ep.host, ep.port, 0),
        ]),
      ),
    );
    // Do not mask the race with a final write: the old HGET/HSET implementation could leave 1
    // here when a stale state refresh committed after the last cutover.
    expect((await harness.routingMap.getEntry(MODEL))?.endpoints[0]?.weight).toBe(0);
  });
});
