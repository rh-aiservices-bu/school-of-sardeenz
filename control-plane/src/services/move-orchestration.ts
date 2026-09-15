import { ModelLifecycleState, Protocol } from '@sardeenz/types';

import { WorkerHttpError, type WorkerClient } from '../clients/worker.js';
import type { RunnerClient } from '../clients/runner.js';
import type { InstanceState, ModelLifecycleService, MoveOperation } from './model-lifecycle.js';
import type { RoutingMapService } from './routing-map.js';
import type { SleepWakeService } from './sleep-wake.js';
import { refreshModelRoutingState } from './sleep-wake.js';
import type { WorkerPoolService } from './worker-pool.js';
import type { MemoryBudgetService } from './memory-budget.js';
import type { InstanceRepository } from './instance-repository.js';
import type { NotificationService } from './notification.js';
import type { StartupLogCaptureService } from './startup-log-capture.js';

export interface MoveOrchestrationLogger {
  debug(obj: Record<string, unknown>, msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

/**
 * Resumable move transaction executor. The durable MoveOperation is both the distributed
 * admission fence and the recovery cursor; process-local state is only a duplicate-work guard.
 */
export class MoveOrchestrationService {
  private readonly running = new Set<string>();

  constructor(
    private readonly lifecycle: ModelLifecycleService,
    private readonly routingMap: RoutingMapService,
    private readonly sleepWake: SleepWakeService,
    private readonly workerPool: WorkerPoolService,
    private readonly memoryBudget: MemoryBudgetService,
    private readonly instanceRepository: InstanceRepository,
    private readonly leaderElection: { readonly isLeader: boolean },
    private readonly createRunnerClient: (host: string, port: number) => RunnerClient,
    private readonly createWorkerClient: (baseUrl: string) => WorkerClient,
    private readonly ambiguousStartGraceMs: number,
    private readonly logger: MoveOrchestrationLogger,
    private readonly notifications?: NotificationService,
    private readonly startupLogs?: StartupLogCaptureService,
  ) {}

  async resumeAll(): Promise<void> {
    const operations = await this.lifecycle.getAllMoveOperations();
    await Promise.allSettled(operations.map((operation) => this.resume(operation.modelName)));
  }

  async resume(modelName: string): Promise<void> {
    if (!this.leaderElection.isLeader || this.running.has(modelName)) return;
    this.running.add(modelName);
    try {
      let operation = await this.lifecycle.getMoveOperation(modelName);
      if (!operation || !this.leaderElection.isLeader) return;

      if (operation.phase === 'REPLACEMENT_STARTING') {
        let replacement = await this.lifecycle.getInstance(
          modelName,
          operation.replacementInstanceId,
        );
        if (!replacement) {
          await this.finish(operation, false, 'replacement disappeared before cutover');
          return;
        }
        if (
          replacement.state === ModelLifecycleState.PENDING ||
          replacement.state === ModelLifecycleState.STARTING
        ) {
          replacement = await this.recoverReplacementStart(operation, replacement);
          if (!replacement) return;
        }
        if (replacement.state === ModelLifecycleState.ACTIVE) {
          await this.startupLogs?.markSucceeded(replacement.instanceId).catch(() => {});
          const updated = await this.lifecycle.updateMoveOperation(
            modelName,
            operation.operationId,
            { phase: 'REPLACEMENT_READY' },
          );
          if (!updated) return;
          operation = updated;
        } else if (replacement.state === ModelLifecycleState.ERROR) {
          await this.startupLogs
            ?.markFailed(
              replacement.instanceId,
              replacement.errorMessage ?? 'replacement deployment failed',
            )
            .catch(() => {});
          const updated = await this.lifecycle.updateMoveOperation(
            modelName,
            operation.operationId,
            {
              phase: 'REPLACEMENT_CLEANUP',
              errorMessage: replacement.errorMessage ?? 'replacement deployment failed',
            },
          );
          if (!updated) return;
          operation = updated;
        } else {
          return;
        }
      }

      if (operation.phase === 'REPLACEMENT_CLEANUP') {
        const replacement = await this.lifecycle.getInstance(
          modelName,
          operation.replacementInstanceId,
        );
        if (replacement && !(await this.teardown(operation, replacement, true))) return;
        await this.finish(
          operation,
          false,
          operation.errorMessage ?? 'replacement deployment failed',
        );
        return;
      }

      if (operation.phase === 'REPLACEMENT_READY' || operation.phase === 'CUTTING_OVER') {
        const [source, replacement] = await Promise.all([
          this.lifecycle.getInstance(modelName, operation.sourceInstanceId),
          this.lifecycle.getInstance(modelName, operation.replacementInstanceId),
        ]);
        if (!source) {
          if (replacement?.state === ModelLifecycleState.ACTIVE) {
            await this.finish(operation, true);
          } else if (replacement?.state === ModelLifecycleState.ERROR) {
            await this.lifecycle.updateMoveOperation(modelName, operation.operationId, {
              phase: 'REPLACEMENT_CLEANUP',
              errorMessage: replacement.errorMessage ?? 'replacement became unavailable',
            });
          } else if (!replacement) {
            await this.finish(operation, false, 'source and replacement both disappeared');
          }
          return;
        }
        if (replacement?.state !== ModelLifecycleState.ACTIVE) {
          // A healthy replacement is the invariant that makes every post-cutover retry safe. If
          // traffic was already shifted but the source has not begun draining, restore its weight
          // before cleaning up or releasing the transaction fence.
          if (!replacement || replacement.state === ModelLifecycleState.ERROR) {
            if (source.state !== ModelLifecycleState.ACTIVE) {
              throw new Error(
                `replacement became unavailable after source entered ${source.state}`,
              );
            }
            if (operation.phase === 'CUTTING_OVER') {
              await this.restoreSourceWeight(operation, source);
            }
          }
          if (replacement?.state === ModelLifecycleState.ERROR) {
            await this.lifecycle.updateMoveOperation(modelName, operation.operationId, {
              phase: 'REPLACEMENT_CLEANUP',
              errorMessage: replacement.errorMessage ?? 'replacement became unavailable',
            });
          } else if (!replacement) {
            await this.finish(operation, false, 'replacement disappeared before source drain');
          }
          return;
        }

        const cuttingOver = await this.lifecycle.updateMoveOperation(
          modelName,
          operation.operationId,
          { phase: 'CUTTING_OVER' },
        );
        if (!cuttingOver) return;
        operation = cuttingOver;
        if (!this.leaderElection.isLeader) return;

        if (source.state === ModelLifecycleState.ACTIVE) {
          if (!source.runnerHost || !source.runnerPort) {
            throw new Error('source has no recoverable routing endpoint');
          }
          const cutOver = await this.routingMap.cutoverEndpointAndWait(
            modelName,
            source.runnerHost,
            source.runnerEnginePort ?? source.runnerPort,
          );
          if (!cutOver) throw new Error('source routing endpoint was not found before cutover');
          if (!this.leaderElection.isLeader) return;
          await this.lifecycle.transition(
            modelName,
            operation.sourceInstanceId,
            ModelLifecycleState.DRAINING,
          );
          await refreshModelRoutingState(this.lifecycle, this.routingMap, modelName);
        } else if (source.state !== ModelLifecycleState.DRAINING) {
          throw new Error(`source entered ${source.state} during move`);
        }

        const sourceDraining = await this.lifecycle.updateMoveOperation(
          modelName,
          operation.operationId,
          { phase: 'SOURCE_DRAINING' },
        );
        if (!sourceDraining) return;
        operation = sourceDraining;
      }

      if (operation.phase === 'SOURCE_DRAINING') {
        if (!this.leaderElection.isLeader) return;
        const source = await this.lifecycle.getInstance(modelName, operation.sourceInstanceId);
        if (source && !(await this.teardown(operation, source, false))) return;
        await this.finish(operation, true);
      }
    } catch (err) {
      const operation = await this.lifecycle.getMoveOperation(modelName).catch(() => null);
      if (operation) {
        await this.lifecycle
          .updateMoveOperation(modelName, operation.operationId, {
            errorMessage: err instanceof Error ? err.message : String(err),
          })
          .catch(() => {});
      }
      this.logger.error(
        { err, modelName, phase: operation?.phase },
        'Resumable model move step failed; transaction retained for reconciliation',
      );
    } finally {
      this.running.delete(modelName);
    }
  }

  /**
   * Recover a leader crash at any point after the replacement record was created. The worker's
   * instanceId index distinguishes a request that never arrived, a cold start still in progress,
   * and a runner that became ready after the old leader disappeared.
   */
  private async recoverReplacementStart(
    operation: MoveOperation,
    initial: InstanceState,
  ): Promise<InstanceState | null> {
    const workerId = initial.workerId ?? operation.targetWorkerId;
    const worker = this.workerPool.getWorker(workerId);
    if (!worker) return null;

    const lookup = await this.createWorkerClient(worker.managementUrl).getRunnerByInstance(
      initial.instanceId,
    );
    if (lookup.status === 'starting') return null;
    if (lookup.status === 'absent') {
      const ageMs = Date.now() - new Date(operation.createdAt).getTime();
      if (ageMs < this.ambiguousStartGraceMs) return null;
      try {
        return await this.lifecycle.transition(
          operation.modelName,
          initial.instanceId,
          ModelLifecycleState.ERROR,
          { errorMessage: 'replacement runner was not started before leader handoff' },
        );
      } catch (err) {
        // The old leader may have completed activation between the lookup and transition. Treat
        // that as recovered success; every other state/error remains retryable via the durable op.
        const current = await this.lifecycle.getInstance(operation.modelName, initial.instanceId);
        if (current?.state === ModelLifecycleState.ACTIVE) return current;
        throw err;
      }
    }

    let replacement = initial;
    if (replacement.state === ModelLifecycleState.PENDING) {
      replacement = await this.lifecycle.transition(
        operation.modelName,
        initial.instanceId,
        ModelLifecycleState.STARTING,
        { workerId, deviceIndices: operation.targetDeviceIndices },
      );
    }
    await this.lifecycle.setRunnerEndpoint(operation.modelName, replacement.instanceId, {
      runnerId: lookup.runnerId,
      host: lookup.host,
      port: lookup.port,
      enginePort: lookup.enginePort,
    });
    await this.routingMap.addEndpoint(
      operation.modelName,
      {
        host: lookup.host,
        port: lookup.enginePort,
        weight: 1,
        healthy: true,
        runnerId: lookup.runnerId,
      },
      replacement.protocol ?? Protocol.openai,
    );

    try {
      replacement = await this.lifecycle.transition(
        operation.modelName,
        replacement.instanceId,
        ModelLifecycleState.ACTIVE,
        {
          runnerHost: lookup.host,
          runnerPort: lookup.port,
          runnerEnginePort: lookup.enginePort,
          runnerId: lookup.runnerId,
        },
      );
    } catch (err) {
      const current = await this.lifecycle.getInstance(operation.modelName, replacement.instanceId);
      if (current?.state !== ModelLifecycleState.ACTIVE) throw err;
      replacement = current;
    }
    await refreshModelRoutingState(this.lifecycle, this.routingMap, operation.modelName);
    this.memoryBudget.releaseInstanceReservations(replacement.instanceId);
    await this.startupLogs?.markSucceeded(replacement.instanceId).catch(() => {});
    return replacement;
  }

  private async teardown(
    operation: MoveOperation,
    initial: InstanceState,
    isReplacementCleanup: boolean,
  ): Promise<boolean> {
    let instance = initial;
    try {
      if (instance.runnerStartAmbiguous && !instance.runnerId) {
        if (!instance.workerId) return false;
        const worker = this.workerPool.getWorker(instance.workerId);
        if (!worker) return false;
        const lookup = await this.createWorkerClient(worker.managementUrl).getRunnerByInstance(
          instance.instanceId,
        );
        if (lookup.status === 'starting') return false;
        if (lookup.status === 'absent') {
          const ageMs = Date.now() - new Date(instance.stateChangedAt).getTime();
          if (ageMs < this.ambiguousStartGraceMs) return false;
        } else {
          await this.lifecycle.setRunnerEndpoint(operation.modelName, instance.instanceId, {
            runnerId: lookup.runnerId,
            host: lookup.host,
            port: lookup.port,
            enginePort: lookup.enginePort,
          });
          instance = (await this.lifecycle.getInstance(operation.modelName, instance.instanceId))!;
        }
      }

      const runnerClient =
        instance.runnerHost && instance.runnerPort
          ? this.createRunnerClient(instance.runnerHost, instance.runnerPort)
          : null;
      await this.sleepWake.stopModel(operation.modelName, instance.instanceId, runnerClient);

      if (instance.workerId && instance.runnerId) {
        const worker = this.workerPool.getWorker(instance.workerId);
        if (!worker) throw new Error(`worker ${instance.workerId} is unknown`);
        try {
          await this.createWorkerClient(worker.managementUrl).stopRunner(instance.runnerId);
        } catch (err) {
          if (!(err instanceof WorkerHttpError && err.status === 404)) throw err;
        }
      }

      await this.lifecycle.removeInstance(operation.modelName, instance.instanceId);
      await this.instanceRepository.delete(instance.instanceId).catch(() => {});
      this.memoryBudget.releaseInstanceReservations(instance.instanceId);
      return true;
    } catch (err) {
      try {
        const retained = await this.lifecycle.getInstance(operation.modelName, instance.instanceId);
        if (retained?.state === ModelLifecycleState.STOPPED) {
          await this.lifecycle.transition(
            operation.modelName,
            instance.instanceId,
            ModelLifecycleState.ERROR,
            {
              errorMessage: `${isReplacementCleanup ? 'Move replacement cleanup' : 'Move source teardown'} could not be confirmed`,
            },
          );
          await refreshModelRoutingState(this.lifecycle, this.routingMap, operation.modelName);
        }
      } catch (stateErr) {
        this.logger.warn(
          { stateErr, modelName: operation.modelName, instanceId: instance.instanceId },
          'Could not persist move teardown error state',
        );
      }
      this.logger.warn(
        { err, modelName: operation.modelName, instanceId: instance.instanceId },
        isReplacementCleanup
          ? 'Move replacement cleanup deferred'
          : 'Move source teardown deferred',
      );
      return false;
    }
  }

  private async restoreSourceWeight(
    operation: MoveOperation,
    source: InstanceState,
  ): Promise<void> {
    if (!source.runnerHost || !source.runnerPort) {
      throw new Error('source has no recoverable routing endpoint for rollback');
    }
    const restored = await this.routingMap.updateEndpointWeight(
      operation.modelName,
      source.runnerHost,
      source.runnerEnginePort ?? source.runnerPort,
      1,
    );
    if (!restored) throw new Error('source routing endpoint was not found during rollback');
  }

  private async finish(
    operation: MoveOperation,
    success: boolean,
    failureMessage?: string,
  ): Promise<void> {
    const removed = await this.lifecycle.removeMoveOperation(
      operation.modelName,
      operation.operationId,
    );
    if (!removed) return;

    if (success) {
      this.logger.info(
        {
          modelName: operation.modelName,
          sourceInstanceId: operation.sourceInstanceId,
          replacementInstanceId: operation.replacementInstanceId,
        },
        'Model move completed',
      );
      this.notifications
        ?.createNotification({
          title: 'Model moved',
          description: `${operation.modelName} moved to ${operation.targetWorkerId}`,
          variant: 'success',
          source: { type: 'model', name: operation.modelName },
        })
        .catch(() => {});
    } else {
      this.notifications
        ?.createNotification({
          title: 'Model move failed',
          description: `${operation.modelName}: ${failureMessage ?? 'move failed'}`,
          variant: 'danger',
          source: { type: 'model', name: operation.modelName },
        })
        .catch(() => {});
    }
  }
}
