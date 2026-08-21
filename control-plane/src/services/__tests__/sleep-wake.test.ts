import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ModelLifecycleState, RunnerState } from '@sardeenz/types';

import { SleepWakeService } from '../sleep-wake.js';
import type { ModelLifecycleService, ModelState } from '../model-lifecycle.js';
import type { RoutingMapService } from '../routing-map.js';
import type { RunnerClient } from '../../clients/runner.js';

// These tests pin the add/remove-endpoint symmetry that the engine-port split (issue #77) hinges on:
// the routing endpoint is registered under the *engine* port, so sleep/wake/stop must remove and
// re-add it under that same engine port — never the management port.

function makeState(overrides: Partial<ModelState> = {}): ModelState {
  return {
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
    getState: ReturnType<typeof vi.fn>;
    transition: ReturnType<typeof vi.fn>;
  };
  routingMap: {
    setModelState: ReturnType<typeof vi.fn>;
    addEndpoint: ReturnType<typeof vi.fn>;
    removeEndpoint: ReturnType<typeof vi.fn>;
    removeModel: ReturnType<typeof vi.fn>;
  };
  runnerClient: {
    getHealth: ReturnType<typeof vi.fn>;
    sleep: ReturnType<typeof vi.fn>;
    wake: ReturnType<typeof vi.fn>;
  };
}

function createMocks(): Mocks {
  return {
    lifecycle: {
      getState: vi.fn().mockResolvedValue(makeState()),
      transition: vi.fn().mockResolvedValue({}),
    },
    routingMap: {
      setModelState: vi.fn().mockResolvedValue(undefined),
      addEndpoint: vi.fn().mockResolvedValue(undefined),
      removeEndpoint: vi.fn().mockResolvedValue(undefined),
      removeModel: vi.fn().mockResolvedValue(undefined),
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
    await service.sleepModel('test-model', mocks.runnerClient as unknown as RunnerClient);

    expect(mocks.routingMap.removeEndpoint).toHaveBeenCalledWith('test-model', '10.0.0.1', 5002);
    expect(mocks.routingMap.removeEndpoint).not.toHaveBeenCalledWith('test-model', '10.0.0.1', 5001);
  });

  it('wakeModel re-registers the endpoint under the engine port', async () => {
    mocks.lifecycle.getState.mockResolvedValue(
      makeState({ state: ModelLifecycleState.SLEEPING }),
    );

    await service.wakeModel('test-model', mocks.runnerClient as unknown as RunnerClient);

    expect(mocks.routingMap.addEndpoint).toHaveBeenCalledWith('test-model', {
      host: '10.0.0.1',
      port: 5002,
      weight: 1,
      healthy: true,
      runnerId: 'runner-abc',
    });
  });

  it('stopModel removes the endpoint under the engine port', async () => {
    await service.stopModel('test-model', mocks.runnerClient as unknown as RunnerClient);

    expect(mocks.routingMap.removeEndpoint).toHaveBeenCalledWith('test-model', '10.0.0.1', 5002);
  });

  it('falls back to the management port when no engine port is recorded (legacy state)', async () => {
    // State persisted before the engine-port split carries no runnerEnginePort.
    mocks.lifecycle.getState.mockResolvedValue(
      makeState({ state: ModelLifecycleState.SLEEPING, runnerEnginePort: undefined }),
    );

    await service.wakeModel('test-model', mocks.runnerClient as unknown as RunnerClient);

    expect(mocks.routingMap.addEndpoint).toHaveBeenCalledWith(
      'test-model',
      expect.objectContaining({ host: '10.0.0.1', port: 5001 }),
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
      mocks.runnerClient as unknown as RunnerClient,
    );

    expect(result.activeRequests).toBeNull();
  });

  it('pollRunnerHealth returns null activeRequests when the health check throws', async () => {
    mocks.runnerClient.getHealth.mockRejectedValue(new Error('connection refused'));

    const result = await service.pollRunnerHealth(
      'test-model',
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

    await service.sleepModel('test-model', mocks.runnerClient as unknown as RunnerClient);

    expect(mocks.runnerClient.getHealth).toHaveBeenCalledTimes(2);
    expect(mocks.runnerClient.sleep).toHaveBeenCalled();
  });
});
