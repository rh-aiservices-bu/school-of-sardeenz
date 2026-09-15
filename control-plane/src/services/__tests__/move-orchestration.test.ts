import { describe, expect, it, vi } from 'vitest';
import { ModelLifecycleState } from '@sardeenz/types';

import { MoveOrchestrationService } from '../move-orchestration.js';
import type { InstanceState, MoveOperation } from '../model-lifecycle.js';
import type { RunnerByInstanceLookup } from '../../clients/worker.js';

const operation: MoveOperation = {
  operationId: 'move-1',
  modelName: 'm1',
  sourceInstanceId: 'inst-source',
  replacementInstanceId: 'inst-replacement',
  targetWorkerId: 'worker-2',
  targetDeviceIndices: [1],
  phase: 'REPLACEMENT_READY',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

function instance(
  instanceId: string,
  state: ModelLifecycleState,
  workerId: string,
  port: number,
): InstanceState {
  return {
    instanceId,
    modelName: 'm1',
    state,
    workerId,
    runnerHost: '127.0.0.1',
    runnerPort: port,
    runnerEnginePort: port + 1,
    runnerId: `runner-${instanceId}`,
    deviceIndices: [workerId === 'worker-1' ? 0 : 1],
    lastInferenceAt: null,
    stateChangedAt: '2026-01-01T00:00:00Z',
    errorMessage: null,
  };
}

function build(over: { barrier?: () => Promise<boolean>; op?: MoveOperation } = {}) {
  let currentOperation: MoveOperation | null = over.op ?? operation;
  const instances = new Map<string, InstanceState>([
    ['inst-source', instance('inst-source', ModelLifecycleState.ACTIVE, 'worker-1', 8000)],
    [
      'inst-replacement',
      instance('inst-replacement', ModelLifecycleState.ACTIVE, 'worker-2', 9000),
    ],
  ]);
  const order: string[] = [];
  const lifecycle = {
    getMoveOperation: vi.fn(() => Promise.resolve(currentOperation)),
    getAllMoveOperations: vi.fn(() => Promise.resolve(currentOperation ? [currentOperation] : [])),
    updateMoveOperation: vi.fn((_model: string, _id: string, updates: object) => {
      currentOperation = currentOperation ? { ...currentOperation, ...updates } : null;
      return Promise.resolve(currentOperation);
    }),
    removeMoveOperation: vi.fn(() => {
      order.push('finish');
      currentOperation = null;
      return Promise.resolve(true);
    }),
    getInstance: vi.fn((_model: string, id: string) => Promise.resolve(instances.get(id) ?? null)),
    getInstancesForModel: vi.fn(() => Promise.resolve([...instances.values()])),
    transition: vi.fn((_model: string, id: string, state: ModelLifecycleState) => {
      order.push(`transition:${state}`);
      const current = instances.get(id)!;
      const updated = { ...current, state };
      instances.set(id, updated);
      return Promise.resolve(updated);
    }),
    setRunnerEndpoint: vi.fn(
      (
        _model: string,
        id: string,
        endpoint: { runnerId: string; host: string; port: number; enginePort: number },
      ) => {
        const current = instances.get(id)!;
        instances.set(id, {
          ...current,
          runnerId: endpoint.runnerId,
          runnerHost: endpoint.host,
          runnerPort: endpoint.port,
          runnerEnginePort: endpoint.enginePort,
        });
        return Promise.resolve();
      },
    ),
    removeInstance: vi.fn((_model: string, id: string) => {
      order.push(`remove:${id}`);
      instances.delete(id);
      return Promise.resolve();
    }),
  };
  const routingMap = {
    cutoverEndpointAndWait: vi.fn(() => {
      order.push('barrier');
      return over.barrier ? over.barrier() : Promise.resolve(true);
    }),
    updateEndpointWeight: vi.fn(() => {
      order.push('restore-source');
      return Promise.resolve(true);
    }),
    addEndpoint: vi.fn(() => Promise.resolve()),
    setModelState: vi.fn(() => Promise.resolve()),
    removeModel: vi.fn(() => Promise.resolve()),
  };
  const sleepWake = {
    stopModel: vi.fn((_model: string, id: string) => {
      order.push(`drain:${id}`);
      return Promise.resolve();
    }),
  };
  const stopRunner = vi.fn((runnerId: string) => {
    order.push(`stop:${runnerId}`);
    return Promise.resolve();
  });
  const getRunnerByInstance = vi.fn<() => Promise<RunnerByInstanceLookup>>(() =>
    Promise.resolve({ status: 'absent' }),
  );
  const memoryBudget = { releaseInstanceReservations: vi.fn() };
  const service = new MoveOrchestrationService(
    lifecycle as never,
    routingMap as never,
    sleepWake as never,
    {
      getWorker: vi.fn((workerId: string) => ({
        workerId,
        managementUrl: `http://${workerId}`,
      })),
    } as never,
    memoryBudget as never,
    { delete: vi.fn(() => Promise.resolve(true)) } as never,
    { isLeader: true },
    vi.fn(() => ({})) as never,
    vi.fn(() => ({ stopRunner, getRunnerByInstance })) as never,
    1_000,
    { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    { createNotification: vi.fn(() => Promise.resolve()) } as never,
  );
  return {
    service,
    lifecycle,
    routingMap,
    sleepWake,
    stopRunner,
    getRunnerByInstance,
    memoryBudget,
    instances,
    order,
  };
}

describe('MoveOrchestrationService', () => {
  it('waits for the proxy barrier before draining and removing the source', async () => {
    const { service, lifecycle, order } = build();

    await service.resume('m1');

    expect(order).toEqual([
      'barrier',
      `transition:${ModelLifecycleState.DRAINING}`,
      'drain:inst-source',
      'stop:runner-inst-source',
      'remove:inst-source',
      'finish',
    ]);
    expect(lifecycle.removeMoveOperation).toHaveBeenCalledWith('m1', 'move-1');
  });

  it('retains both instances and the durable transaction when the barrier is not acknowledged', async () => {
    const { service, lifecycle, sleepWake, instances } = build({
      barrier: () => Promise.reject(new Error('barrier timeout')),
    });

    await service.resume('m1');

    expect(sleepWake.stopModel).not.toHaveBeenCalled();
    expect(lifecycle.removeMoveOperation).not.toHaveBeenCalled();
    expect(instances.has('inst-source')).toBe(true);
    expect(instances.has('inst-replacement')).toBe(true);
    expect(lifecycle.updateMoveOperation).toHaveBeenCalledWith(
      'm1',
      'move-1',
      expect.objectContaining({ errorMessage: 'barrier timeout' }),
    );
  });

  it('does not cut over after losing the durable transaction CAS', async () => {
    const { service, lifecycle, routingMap, sleepWake } = build();
    lifecycle.updateMoveOperation.mockResolvedValueOnce(null);

    await service.resume('m1');

    expect(routingMap.cutoverEndpointAndWait).not.toHaveBeenCalled();
    expect(sleepWake.stopModel).not.toHaveBeenCalled();
  });

  it('restores a weight-zero source before failing a cutover whose replacement disappeared', async () => {
    const op = { ...operation, phase: 'CUTTING_OVER' as const };
    const { service, lifecycle, routingMap, instances, order } = build({ op });
    instances.delete('inst-replacement');

    await service.resume('m1');

    expect(routingMap.updateEndpointWeight).toHaveBeenCalledWith('m1', '127.0.0.1', 8001, 1);
    expect(order).toEqual(['restore-source', 'finish']);
    expect(lifecycle.removeMoveOperation).toHaveBeenCalledWith('m1', 'move-1');
    expect(instances.get('inst-source')?.state).toBe(ModelLifecycleState.ACTIVE);
  });

  it('resumes source teardown after a crash persisted DRAINING before the phase update', async () => {
    const op = { ...operation, phase: 'CUTTING_OVER' as const };
    const { service, instances, routingMap } = build({ op });
    instances.set(
      'inst-source',
      instance('inst-source', ModelLifecycleState.DRAINING, 'worker-1', 8000),
    );

    await service.resume('m1');

    expect(routingMap.cutoverEndpointAndWait).not.toHaveBeenCalled();
    expect(instances.has('inst-source')).toBe(false);
  });

  it('recovers a lost start reply by instance id before cleaning up the replacement', async () => {
    const op = { ...operation, phase: 'REPLACEMENT_CLEANUP' as const };
    const { service, instances, getRunnerByInstance, stopRunner } = build({ op });
    instances.set('inst-replacement', {
      ...instance('inst-replacement', ModelLifecycleState.ERROR, 'worker-2', 9000),
      runnerHost: null,
      runnerPort: null,
      runnerEnginePort: null,
      runnerId: null,
      runnerStartAmbiguous: true,
    });
    getRunnerByInstance.mockResolvedValueOnce({
      status: 'ready',
      runnerId: 'runner-recovered',
      host: '127.0.0.1',
      port: 9000,
      enginePort: 9001,
    });

    await service.resume('m1');

    expect(stopRunner).toHaveBeenCalledWith('runner-recovered');
    expect(instances.has('inst-replacement')).toBe(false);
  });

  it('adopts a replacement that became ready after the old leader disappeared', async () => {
    const op = { ...operation, phase: 'REPLACEMENT_STARTING' as const };
    const { service, instances, getRunnerByInstance, routingMap, lifecycle, memoryBudget } = build({
      op,
      barrier: () => Promise.reject(new Error('hold after recovered start')),
    });
    instances.set('inst-replacement', {
      ...instance('inst-replacement', ModelLifecycleState.STARTING, 'worker-2', 9000),
      runnerHost: null,
      runnerPort: null,
      runnerEnginePort: null,
      runnerId: null,
    });
    getRunnerByInstance.mockResolvedValueOnce({
      status: 'ready',
      runnerId: 'runner-recovered',
      host: '127.0.0.1',
      port: 9000,
      enginePort: 9001,
    });

    await service.resume('m1');

    expect(lifecycle.setRunnerEndpoint).toHaveBeenCalled();
    expect(routingMap.addEndpoint).toHaveBeenCalledWith(
      'm1',
      expect.objectContaining({ runnerId: 'runner-recovered', port: 9001 }),
      'openai',
    );
    expect(instances.get('inst-replacement')?.state).toBe(ModelLifecycleState.ACTIVE);
    expect(memoryBudget.releaseInstanceReservations).toHaveBeenCalledWith('inst-replacement');
  });

  it('retains a newly absent replacement because its start request may still arrive', async () => {
    const op = {
      ...operation,
      phase: 'REPLACEMENT_STARTING' as const,
      createdAt: new Date().toISOString(),
    };
    const { service, instances, lifecycle, getRunnerByInstance } = build({ op });
    instances.set('inst-replacement', {
      ...instance('inst-replacement', ModelLifecycleState.STARTING, 'worker-2', 9000),
      runnerHost: null,
      runnerPort: null,
      runnerEnginePort: null,
      runnerId: null,
    });

    await service.resume('m1');

    expect(getRunnerByInstance).toHaveBeenCalledWith('inst-replacement');
    expect(instances.has('inst-replacement')).toBe(true);
    expect(lifecycle.removeMoveOperation).not.toHaveBeenCalled();
  });

  it('cleans an undelivered replacement after the start ambiguity grace', async () => {
    const op = { ...operation, phase: 'REPLACEMENT_STARTING' as const };
    const { service, instances, lifecycle, getRunnerByInstance } = build({ op });
    instances.set('inst-replacement', {
      ...instance('inst-replacement', ModelLifecycleState.STARTING, 'worker-2', 9000),
      runnerHost: null,
      runnerPort: null,
      runnerEnginePort: null,
      runnerId: null,
    });

    await service.resume('m1');

    expect(getRunnerByInstance).toHaveBeenCalledWith('inst-replacement');
    expect(instances.has('inst-replacement')).toBe(false);
    expect(lifecycle.removeMoveOperation).toHaveBeenCalledWith('m1', 'move-1');
  });
});
