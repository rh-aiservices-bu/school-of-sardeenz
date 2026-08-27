import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ModelLifecycleState, Protocol, RunnerState, SleepLevel } from '@sardeenz/types';

import { SleepWakeService } from '../sleep-wake.js';
import type { ModelLifecycleService, InstanceState } from '../model-lifecycle.js';
import type { RoutingMapService } from '../routing-map.js';
import type { MemoryBudgetService } from '../memory-budget.js';
import type { RunnerClient } from '../../clients/runner.js';

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

function createService(mocks: Mocks): SleepWakeService {
  return new SleepWakeService(
    mocks.lifecycle as unknown as ModelLifecycleService,
    mocks.routingMap as unknown as RoutingMapService,
    mocks.memoryBudget as unknown as MemoryBudgetService,
    5_000,
    5_000,
    10,
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
      Protocol.openai,
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
      Protocol.openai,
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
    await service.wakeModel(
      'test-model',
      INSTANCE_ID,
      mocks.runnerClient as unknown as RunnerClient,
    );

    expect(mocks.runnerClient.wake).toHaveBeenCalledWith();
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
