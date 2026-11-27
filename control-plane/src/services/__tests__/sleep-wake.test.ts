import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ModelLifecycleState,
  ModelState,
  Protocol,
  RunnerState,
  SleepLevel,
} from '@sardeenz/types';

import { refreshModelRoutingState, SleepWakeService } from '../sleep-wake.js';
import type { ModelLifecycleService, InstanceState } from '../model-lifecycle.js';
import type { RoutingMapLogger, RoutingMapService } from '../routing-map.js';
import type { MemoryBudgetService } from '../memory-budget.js';
import type { RunnerClient } from '../../clients/runner.js';
import { registry } from '../../health/metrics.js';

// These tests pin the add/remove-endpoint symmetry that the engine-port split (issue #77) hinges on:
// the routing endpoint is registered under the *engine* port, so sleep/wake/stop must remove and
// re-add it under that same engine port — never the management port.

const INSTANCE_ID = 'test-instance';

function makeState(overrides: Partial<InstanceState> = {}): InstanceState {
  return {
    instanceId: INSTANCE_ID,
    modelName: 'test-model',
    state: ModelLifecycleState.ACTIVE,
    workerId: 'worker-1',
    runnerHost: '10.0.0.1',
    runnerPort: 5001, // management port
    runnerEnginePort: 5002, // inference port — distinct from management
    runnerId: 'runner-abc',
    deviceIndices: [0],
    lastInferenceAt: null,
    stateChangedAt: '2026-01-01T00:00:00.000Z',
    errorMessage: null,
    ...overrides,
  };
}

interface Mocks {
  lifecycle: {
    getInstance: ReturnType<typeof vi.fn>;
    getInstancesForModel: ReturnType<typeof vi.fn>;
    transition: ReturnType<typeof vi.fn>;
  };
  routingMap: {
    setModelState: ReturnType<typeof vi.fn>;
    addEndpoint: ReturnType<typeof vi.fn>;
    removeEndpoint: ReturnType<typeof vi.fn>;
    removeModel: ReturnType<typeof vi.fn>;
  };
  memoryBudget: {
    releaseInstanceReservations: ReturnType<typeof vi.fn>;
  };
  runnerClient: {
    getHealth: ReturnType<typeof vi.fn>;
    sleep: ReturnType<typeof vi.fn>;
    wake: ReturnType<typeof vi.fn>;
  };
}

function createMocks(): Mocks {
  const lifecycle = {
    getInstance: vi.fn().mockResolvedValue(makeState()),
    // refreshModelRoutingState (called internally by every SleepWakeService method) resolves the
    // model-level routing aggregate from this — mirror whatever getInstance currently returns so
    // these single-instance tests behave as before #120.
    getInstancesForModel: vi.fn(async (): Promise<InstanceState[]> => {
      const current = (await lifecycle.getInstance()) as InstanceState | null;
      return current ? [current] : [];
    }),
    transition: vi.fn().mockResolvedValue({}),
  };
  return {
    lifecycle,
    routingMap: {
      setModelState: vi.fn().mockResolvedValue(undefined),
      addEndpoint: vi.fn().mockResolvedValue(undefined),
      removeEndpoint: vi.fn().mockResolvedValue(undefined),
      removeModel: vi.fn().mockResolvedValue(undefined),
    },
    memoryBudget: {
      releaseInstanceReservations: vi.fn(),
    },
    runnerClient: {
      // READY with no in-flight requests → drain and wake complete on the first poll.
      getHealth: vi.fn().mockResolvedValue({ state: RunnerState.READY, activeRequests: 0 }),
      sleep: vi.fn().mockResolvedValue(undefined),
      wake: vi.fn().mockResolvedValue(undefined),
    },
  };
}

function createService(mocks: Mocks, logger?: RoutingMapLogger): SleepWakeService {
  return new SleepWakeService(
    mocks.lifecycle as unknown as ModelLifecycleService,
    mocks.routingMap as unknown as RoutingMapService,
    mocks.memoryBudget as unknown as MemoryBudgetService,
    5_000,
    5_000,
    10,
    logger,
  );
}

describe('SleepWakeService — engine-port routing symmetry', () => {
  let mocks: Mocks;
  let service: SleepWakeService;

  beforeEach(() => {
    mocks = createMocks();
    service = createService(mocks);
  });

  it('sleepModel removes the endpoint under the engine port, not the management port', async () => {
    await service.sleepModel(
      'test-model',
      INSTANCE_ID,
      mocks.runnerClient as unknown as RunnerClient,
    );

    expect(mocks.routingMap.removeEndpoint).toHaveBeenCalledWith('test-model', '10.0.0.1', 5002);
    expect(mocks.routingMap.removeEndpoint).not.toHaveBeenCalledWith(
      'test-model',
      '10.0.0.1',
      5001,
    );
  });

  it('wakeModel re-registers the endpoint under the engine port', async () => {
    mocks.lifecycle.getInstance.mockResolvedValue(
      makeState({ state: ModelLifecycleState.SLEEPING }),
    );

    await service.wakeModel(
      'test-model',
      INSTANCE_ID,
      mocks.runnerClient as unknown as RunnerClient,
    );

    expect(mocks.routingMap.addEndpoint).toHaveBeenCalledWith(
      'test-model',
      {
        host: '10.0.0.1',
        port: 5002,
        weight: 1,
        healthy: true,
        runnerId: 'runner-abc',
      },
      undefined,
    );
  });

  it('stopModel removes the endpoint under the engine port', async () => {
    await service.stopModel(
      'test-model',
      INSTANCE_ID,
      mocks.runnerClient as unknown as RunnerClient,
    );

    expect(mocks.routingMap.removeEndpoint).toHaveBeenCalledWith('test-model', '10.0.0.1', 5002);
  });

  it('drains an already-DRAINING move source before removing its endpoint', async () => {
    mocks.lifecycle.getInstance.mockResolvedValue(
      makeState({ state: ModelLifecycleState.DRAINING }),
    );
    mocks.runnerClient.getHealth
      .mockResolvedValueOnce({ state: RunnerState.BUSY, activeRequests: 2 })
      .mockResolvedValueOnce({ state: RunnerState.READY, activeRequests: 0 });

    await service.stopModel(
      'test-model',
      INSTANCE_ID,
      mocks.runnerClient as unknown as RunnerClient,
    );

    expect(mocks.runnerClient.getHealth).toHaveBeenCalledTimes(2);
    expect(mocks.routingMap.removeEndpoint).toHaveBeenCalledAfter(mocks.runnerClient.getHealth);
  });

  it('falls back to the management port when no engine port is recorded (legacy state)', async () => {
    // State persisted before the engine-port split carries no runnerEnginePort.
    mocks.lifecycle.getInstance.mockResolvedValue(
      makeState({ state: ModelLifecycleState.SLEEPING, runnerEnginePort: undefined }),
    );

    await service.wakeModel(
      'test-model',
      INSTANCE_ID,
      mocks.runnerClient as unknown as RunnerClient,
    );

    expect(mocks.routingMap.addEndpoint).toHaveBeenCalledWith(
      'test-model',
      expect.objectContaining({ host: '10.0.0.1', port: 5001 }),
      undefined,
    );
  });
});

describe('SleepWakeService — activeRequests unknown handling (#116)', () => {
  let mocks: Mocks;
  let service: SleepWakeService;

  beforeEach(() => {
    mocks = createMocks();
    service = createService(mocks);
  });

  it('pollRunnerHealth returns null activeRequests when the field is missing from the response', async () => {
    mocks.runnerClient.getHealth.mockResolvedValue({ state: RunnerState.READY });

    const result = await service.pollRunnerHealth(
      'test-model',
      INSTANCE_ID,
      mocks.runnerClient as unknown as RunnerClient,
    );

    expect(result.activeRequests).toBeNull();
  });

  it('pollRunnerHealth returns null activeRequests when the health check throws', async () => {
    mocks.runnerClient.getHealth.mockRejectedValue(new Error('connection refused'));

    const result = await service.pollRunnerHealth(
      'test-model',
      INSTANCE_ID,
      mocks.runnerClient as unknown as RunnerClient,
    );

    expect(result.state).toBe(RunnerState.ERROR);
    expect(result.activeRequests).toBeNull();
  });

  it('waitForDrain (via sleepModel) keeps polling while activeRequests is unknown, then completes once it reports 0', async () => {
    // First poll: unknown (missing field) — must not be treated as "drained". Second poll: drained.
    mocks.runnerClient.getHealth
      .mockResolvedValueOnce({ state: RunnerState.READY })
      .mockResolvedValueOnce({ state: RunnerState.READY, activeRequests: 0 });

    await service.sleepModel(
      'test-model',
      INSTANCE_ID,
      mocks.runnerClient as unknown as RunnerClient,
    );

    expect(mocks.runnerClient.getHealth).toHaveBeenCalledTimes(2);
    expect(mocks.runnerClient.sleep).toHaveBeenCalled();
  });
});

describe('SleepWakeService — VRAM reservation release (#87)', () => {
  let mocks: Mocks;
  let service: SleepWakeService;

  beforeEach(() => {
    mocks = createMocks();
    service = createService(mocks);
  });

  it('stopModel releases the model reservation once the model is fully stopped', async () => {
    await service.stopModel(
      'test-model',
      INSTANCE_ID,
      mocks.runnerClient as unknown as RunnerClient,
    );

    expect(mocks.memoryBudget.releaseInstanceReservations).toHaveBeenCalledWith(INSTANCE_ID);
  });

  it('sleepModel does NOT release the reservation — a sleeping model keeps its VRAM budget', async () => {
    await service.sleepModel(
      'test-model',
      INSTANCE_ID,
      mocks.runnerClient as unknown as RunnerClient,
    );

    expect(mocks.memoryBudget.releaseInstanceReservations).not.toHaveBeenCalled();
  });
});

describe('SleepWakeService — timeout threading (#89)', () => {
  let mocks: Mocks;
  let service: SleepWakeService;

  beforeEach(() => {
    mocks = createMocks();
    service = createService(mocks);
  });

  it('sleepModel passes sleepTimeoutMs to runnerClient.sleep()', async () => {
    await service.sleepModel(
      'test-model',
      INSTANCE_ID,
      mocks.runnerClient as unknown as RunnerClient,
    );

    expect(mocks.runnerClient.sleep).toHaveBeenCalledWith(SleepLevel.L1_HOST_RAM, 5_000);
  });

  it('wakeModel does not pass a custom timeout to runnerClient.wake()', async () => {
    // SLEEPING keeps the direct three-argument call wake-eligible (#323 gate).
    mocks.lifecycle.getInstance.mockResolvedValue(
      makeState({ state: ModelLifecycleState.SLEEPING }),
    );

    await service.wakeModel(
      'test-model',
      INSTANCE_ID,
      mocks.runnerClient as unknown as RunnerClient,
    );

    expect(mocks.runnerClient.wake).toHaveBeenCalledWith();
  });
});

describe('SleepWakeService — unclaimed wake no-op (#323)', () => {
  const UNCLAIMED = 'sardeenz_control_plane_wake_unclaimed_total';
  const TRIGGERS = 'sardeenz_control_plane_wake_triggers_total';

  /** Current value of a wake-family counter (prom-client global registry). */
  async function metricValue(name: string, state?: string): Promise<number> {
    const metrics = await registry.getMetricsAsJSON();
    const metric = metrics.find((m) => m.name === name);
    const sample =
      state === undefined
        ? metric?.values[0]
        : metric?.values.find((v) => v.labels.state === state);
    return sample?.value ?? 0;
  }

  function makeLogger() {
    return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  }

  it('wakeModel on an unclaimed ACTIVE instance is a logged, counted no-op', async () => {
    const mocks = createMocks();
    mocks.lifecycle.getInstance.mockResolvedValue(makeState({ state: ModelLifecycleState.ACTIVE }));
    const logger = makeLogger();
    const service = createService(mocks, logger);
    const unclaimedBefore = await metricValue(UNCLAIMED, ModelLifecycleState.ACTIVE);
    const triggersBefore = await metricValue(TRIGGERS);

    await service.wakeModel(
      'test-model',
      INSTANCE_ID,
      mocks.runnerClient as unknown as RunnerClient,
    );

    // Nothing wakes, transitions or touches routing — the instance stays ACTIVE.
    expect(mocks.runnerClient.wake).not.toHaveBeenCalled();
    expect(mocks.lifecycle.transition).not.toHaveBeenCalled();
    expect(mocks.routingMap.addEndpoint).not.toHaveBeenCalled();
    expect(mocks.routingMap.setModelState).not.toHaveBeenCalled();

    // Counted as an unclaimed skip, and explicitly NOT as a wake trigger.
    expect(await metricValue(UNCLAIMED, ModelLifecycleState.ACTIVE)).toBe(unclaimedBefore + 1);
    expect(await metricValue(TRIGGERS)).toBe(triggersBefore);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      {
        modelName: 'test-model',
        instanceId: INSTANCE_ID,
        state: ModelLifecycleState.ACTIVE,
        claimed: false,
      },
      'Skipped unclaimed wake: instance not in a wake-eligible state',
    );
  });

  it('wakeModel with { claimed: true } proceeds on a STARTING instance', async () => {
    // The route already won SLEEPING → STARTING; the caller's claim is honoured.
    const mocks = createMocks();
    mocks.lifecycle.getInstance.mockResolvedValue(
      makeState({ state: ModelLifecycleState.STARTING }),
    );
    const logger = makeLogger();
    const service = createService(mocks, logger);
    const triggersBefore = await metricValue(TRIGGERS);

    await service.wakeModel(
      'test-model',
      INSTANCE_ID,
      mocks.runnerClient as unknown as RunnerClient,
      {
        claimed: true,
      },
    );

    expect(mocks.runnerClient.wake).toHaveBeenCalledWith();
    // No second SLEEPING → STARTING claim; the wake settles the instance back to ACTIVE.
    expect(mocks.lifecycle.transition).toHaveBeenCalledTimes(1);
    expect(mocks.lifecycle.transition).toHaveBeenCalledWith(
      'test-model',
      INSTANCE_ID,
      ModelLifecycleState.ACTIVE,
    );
    expect(mocks.routingMap.addEndpoint).toHaveBeenCalled();
    expect(await metricValue(TRIGGERS)).toBe(triggersBefore + 1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('wakeModel with { claimed: true } on a non-STARTING instance is a logged, counted no-op', async () => {
    // The instance moved past STARTING between the route's CAS and this re-read (fast wake or an
    // external transition): a counted no-op, never the old failed STARTING → ACTIVE → ERROR path.
    const mocks = createMocks();
    mocks.lifecycle.getInstance.mockResolvedValue(makeState({ state: ModelLifecycleState.ACTIVE }));
    const logger = makeLogger();
    const service = createService(mocks, logger);
    const unclaimedBefore = await metricValue(UNCLAIMED, ModelLifecycleState.ACTIVE);

    await service.wakeModel(
      'test-model',
      INSTANCE_ID,
      mocks.runnerClient as unknown as RunnerClient,
      {
        claimed: true,
      },
    );

    expect(mocks.runnerClient.wake).not.toHaveBeenCalled();
    expect(mocks.lifecycle.transition).not.toHaveBeenCalled();
    expect(await metricValue(UNCLAIMED, ModelLifecycleState.ACTIVE)).toBe(unclaimedBefore + 1);
    expect(logger.warn).toHaveBeenCalledWith(
      {
        modelName: 'test-model',
        instanceId: INSTANCE_ID,
        state: ModelLifecycleState.ACTIVE,
        claimed: true,
      },
      'Skipped unclaimed wake: instance not in a wake-eligible state',
    );
  });
});

describe('SleepWakeService — RUNNER_TIMEOUT reachability (#96)', () => {
  it('waitForDrain surfaces RUNNER_TIMEOUT, not an AbortError, when the drain never completes', async () => {
    const mocks = createMocks();
    mocks.runnerClient.getHealth.mockResolvedValue({
      state: RunnerState.READY,
      activeRequests: 5,
    });
    const service = new SleepWakeService(
      mocks.lifecycle as unknown as ModelLifecycleService,
      mocks.routingMap as unknown as RoutingMapService,
      mocks.memoryBudget as unknown as MemoryBudgetService,
      50,
      50,
      10,
    );

    await expect(
      service.sleepModel('test-model', INSTANCE_ID, mocks.runnerClient as unknown as RunnerClient),
    ).rejects.toMatchObject({ code: 'RUNNER_TIMEOUT' });
  });

  it('waitForReady surfaces RUNNER_TIMEOUT, not an AbortError, when the runner never becomes ready', async () => {
    const mocks = createMocks();
    mocks.lifecycle.getInstance.mockResolvedValue(
      makeState({ state: ModelLifecycleState.SLEEPING }),
    );
    mocks.runnerClient.getHealth.mockResolvedValue({
      state: RunnerState.STARTING,
      activeRequests: 0,
    });
    const service = new SleepWakeService(
      mocks.lifecycle as unknown as ModelLifecycleService,
      mocks.routingMap as unknown as RoutingMapService,
      mocks.memoryBudget as unknown as MemoryBudgetService,
      50,
      50,
      10,
    );

    await expect(
      service.wakeModel('test-model', INSTANCE_ID, mocks.runnerClient as unknown as RunnerClient),
    ).rejects.toMatchObject({ code: 'RUNNER_TIMEOUT' });
  });

  // ---------------------------------------------------------------------------
  // waitForDrain fast-fail on unreachable runner (#166 fix C)
  // ---------------------------------------------------------------------------

  it('waitForDrain fast-fails after 3 consecutive failed health polls instead of burning sleepTimeoutMs', async () => {
    // Runner is gone (e.g. ghost instance after a blank worker restart): every poll fails.
    const mocks = createMocks();
    mocks.runnerClient.getHealth.mockRejectedValue(new Error('connect ECONNREFUSED'));
    const service = new SleepWakeService(
      mocks.lifecycle as unknown as ModelLifecycleService,
      mocks.routingMap as unknown as RoutingMapService,
      mocks.memoryBudget as unknown as MemoryBudgetService,
      60_000, // long timeout — the fast-fail must end the wait well before this
      60_000,
      1,
    );

    const start = Date.now();
    await expect(
      service.sleepModel('test-model', INSTANCE_ID, mocks.runnerClient as unknown as RunnerClient),
    ).rejects.toMatchObject({ code: 'RUNNER_UNAVAILABLE' });
    // 3 failed polls at a 1ms interval — comfortably under even a fraction of the 60s timeout.
    expect(Date.now() - start).toBeLessThan(1_000);
    expect(mocks.runnerClient.getHealth).toHaveBeenCalledTimes(3);
  });

  it('stopModel on an unreachable runner settles promptly with an ERROR record (no drain-timeout message)', async () => {
    const mocks = createMocks();
    mocks.runnerClient.getHealth.mockRejectedValue(new Error('connect ECONNREFUSED'));
    const service = new SleepWakeService(
      mocks.lifecycle as unknown as ModelLifecycleService,
      mocks.routingMap as unknown as RoutingMapService,
      mocks.memoryBudget as unknown as MemoryBudgetService,
      60_000,
      60_000,
      1,
    );

    const start = Date.now();
    await expect(
      service.stopModel('test-model', INSTANCE_ID, mocks.runnerClient as unknown as RunnerClient),
    ).rejects.toMatchObject({ code: 'RUNNER_UNAVAILABLE' });
    expect(Date.now() - start).toBeLessThan(1_000);

    // The catch path lands the instance in ERROR with the fast-fail message — not the
    // ~5-minute "Drain timed out" message the pre-fix behavior produced.
    expect(mocks.lifecycle.transition).toHaveBeenCalledWith(
      'test-model',
      INSTANCE_ID,
      ModelLifecycleState.ERROR,
      expect.objectContaining({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        errorMessage: expect.stringContaining('became unreachable during drain'),
      }),
    );
  });

  it('waitForDrain still completes its full poll cycle when a healthy runner reports active requests', async () => {
    // A reachable runner that keeps in-flight requests must NOT be fast-failed: its polls
    // succeed (state READY), so the failure streak stays at zero and the drain times out
    // the normal way — preserving the pre-fix behavior for genuinely busy runners.
    const mocks = createMocks();
    mocks.runnerClient.getHealth.mockResolvedValue({
      state: RunnerState.READY,
      activeRequests: 5,
    });
    const service = new SleepWakeService(
      mocks.lifecycle as unknown as ModelLifecycleService,
      mocks.routingMap as unknown as RoutingMapService,
      mocks.memoryBudget as unknown as MemoryBudgetService,
      50,
      50,
      10,
    );

    await expect(
      service.sleepModel('test-model', INSTANCE_ID, mocks.runnerClient as unknown as RunnerClient),
    ).rejects.toMatchObject({ code: 'RUNNER_TIMEOUT' });
    // Ran the full ~50ms timeout window (many polls), not the 3-poll fast-fail — a reachable
    // runner with in-flight traffic keeps being polled to the natural timeout.
    expect(mocks.runnerClient.getHealth.mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  it('a single health failure on an otherwise healthy runner does not trip the fast-fail', async () => {
    // Poll 1: unreachable (e.g. a dropped read). Poll 2: runner answers with active requests.
    // Poll 3: drained. The streak resets on the successful poll — no fast-fail, normal drain.
    const mocks = createMocks();
    const service = createService(mocks);
    mocks.runnerClient.getHealth
      .mockRejectedValueOnce(new Error('connect ECONNREFUSED'))
      .mockResolvedValueOnce({ state: RunnerState.READY, activeRequests: 2 })
      .mockResolvedValueOnce({ state: RunnerState.READY, activeRequests: 0 });

    await service.sleepModel(
      'test-model',
      INSTANCE_ID,
      mocks.runnerClient as unknown as RunnerClient,
    );

    expect(mocks.runnerClient.getHealth).toHaveBeenCalledTimes(3);
    expect(mocks.runnerClient.sleep).toHaveBeenCalled();
    expect(mocks.lifecycle.transition).not.toHaveBeenCalledWith(
      'test-model',
      INSTANCE_ID,
      ModelLifecycleState.ERROR,
      expect.anything(),
    );
  });
});

describe('refreshModelRoutingState protocol derivation (#309)', () => {
  async function conflicts(kind: 'entry-vs-caller' | 'instance-vs-instance'): Promise<number> {
    const metrics = await registry.getMetricsAsJSON();
    const metric = metrics.find(
      (m) => m.name === 'sardeenz_control_plane_routing_protocol_conflicts_total',
    );
    const sample = metric?.values.find((v) => v.labels.kind === kind);
    return sample?.value ?? 0;
  }

  function makeLogger() {
    return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  }

  it('derives the tag when every tagged instance agrees, ignoring an untagged legacy sibling', async () => {
    const mocks = createMocks();
    mocks.lifecycle.getInstancesForModel.mockResolvedValue([
      makeState({ instanceId: 'inst-a', protocol: Protocol.oip }),
      makeState({ instanceId: 'inst-b', protocol: Protocol.oip }),
      makeState({ instanceId: 'inst-legacy', protocol: undefined }),
    ]);

    await refreshModelRoutingState(
      mocks.lifecycle as unknown as ModelLifecycleService,
      mocks.routingMap as unknown as RoutingMapService,
      'test-model',
    );

    expect(mocks.routingMap.setModelState).toHaveBeenCalledWith(
      'test-model',
      ModelState.ACTIVE,
      Protocol.oip,
    );
  });

  it('passes no protocol, counts instance-vs-instance and warns once when tagged instances disagree', async () => {
    const before = await conflicts('instance-vs-instance');
    const logger = makeLogger();
    const mocks = createMocks();
    mocks.lifecycle.getInstancesForModel.mockResolvedValue([
      makeState({ instanceId: 'inst-a', protocol: Protocol.openai }),
      makeState({ instanceId: 'inst-b', protocol: Protocol.oip }),
    ]);

    await refreshModelRoutingState(
      mocks.lifecycle as unknown as ModelLifecycleService,
      mocks.routingMap as unknown as RoutingMapService,
      'test-model',
      logger,
    );

    expect(mocks.routingMap.setModelState).toHaveBeenCalledWith(
      'test-model',
      ModelState.ACTIVE,
      undefined,
    );
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      { modelName: 'test-model', protocols: [Protocol.openai, Protocol.oip] },
      'Instance protocols disagree — keeping the routing entry protocol',
    );
    expect((await conflicts('instance-vs-instance')) - before).toBe(1);
  });

  it('passes no protocol when no instance carries a tag (all legacy records)', async () => {
    const before = await conflicts('instance-vs-instance');
    const logger = makeLogger();
    const mocks = createMocks();
    mocks.lifecycle.getInstancesForModel.mockResolvedValue([
      makeState({ instanceId: 'inst-a', protocol: undefined }),
    ]);

    await refreshModelRoutingState(
      mocks.lifecycle as unknown as ModelLifecycleService,
      mocks.routingMap as unknown as RoutingMapService,
      'test-model',
      logger,
    );

    expect(mocks.routingMap.setModelState).toHaveBeenCalledWith(
      'test-model',
      ModelState.ACTIVE,
      undefined,
    );
    expect(logger.warn).not.toHaveBeenCalled();
    expect((await conflicts('instance-vs-instance')) - before).toBe(0);
  });
});
