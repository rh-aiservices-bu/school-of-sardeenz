import { ModelLifecycleState, WorkerStatus } from '@sardeenz/types';

import type { ModelLifecycleService } from './model-lifecycle.js';
import type { WorkerPoolService } from './worker-pool.js';
import type { MemoryBudgetService } from './memory-budget.js';
import type { RoutingMapService } from './routing-map.js';
import {
  reconciliationTicksTotal,
  reconciliationStuckModelsTotal,
  reconciliationDeadWorkersTotal,
  reconciliationTickDuration,
  reconciliationErrors,
  modelsTotal,
  workersTotal,
  deviceMemoryBytes,
} from '../health/metrics.js';

export interface ReconciliationLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface ReconciliationConfig {
  readonly reconciliationIntervalSecs: number;
  readonly deployTimeoutSecs: number;
  readonly sleepTimeoutSecs: number;
}

const TRANSITIONAL_STATES: ReadonlyMap<ModelLifecycleState, 'deploy' | 'sleep'> = new Map([
  [ModelLifecycleState.STARTING, 'deploy'],
  [ModelLifecycleState.DRAINING, 'sleep'],
  [ModelLifecycleState.STOPPING, 'sleep'],
]);

export class ReconciliationService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private wasLeader = false;
  private running = false;

  constructor(
    private readonly lifecycle: ModelLifecycleService,
    private readonly workerPool: WorkerPoolService,
    private readonly memoryBudget: MemoryBudgetService,
    private readonly routingMap: RoutingMapService,
    private readonly leaderElection: { readonly isLeader: boolean },
    private readonly config: ReconciliationConfig,
    private readonly logger: ReconciliationLogger,
  ) {}

  start(): void {
    if (this.timer) return;
    const intervalMs = this.config.reconciliationIntervalSecs * 1000;
    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMs);
    this.logger.info(
      { intervalSecs: this.config.reconciliationIntervalSecs },
      'Reconciliation loop started',
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.logger.info({}, 'Reconciliation loop stopped');
    }
  }

  async tick(): Promise<void> {
    if (!this.leaderElection.isLeader) {
      this.wasLeader = false;
      return;
    }

    if (this.running) return;
    this.running = true;

    try {
      const startedAt = Date.now();

      if (!this.wasLeader) {
        this.logger.info({}, 'Leader promotion detected — running full state rebuild');
      }
      this.wasLeader = true;

      reconciliationTicksTotal.inc();

      await this.safeStep('discoverWorkers', () => this.workerPool.discoverWorkers());
      await this.safeStep('checkHeartbeats', () => this.workerPool.checkHeartbeats());
      await this.safeStep('handleDeadWorkers', () => this.handleDeadWorkers());
      await this.safeStep('refreshMemoryBudgets', () => this.memoryBudget.refreshAll());
      await this.safeStep('recoverStuckModels', () => this.recoverStuckModels());
      await this.safeStep('refreshMetrics', () => this.refreshMetrics());

      reconciliationTickDuration.observe((Date.now() - startedAt) / 1000);
    } finally {
      this.running = false;
    }
  }

  private async safeStep(name: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      reconciliationErrors.inc({ step: name });
      this.logger.error(
        { step: name, err: err instanceof Error ? err.message : String(err) },
        'Reconciliation step failed',
      );
    }
  }

  private async handleDeadWorkers(): Promise<void> {
    const deadWorkers = this.workerPool.getDeadWorkers();
    if (deadWorkers.length === 0) return;

    this.logger.warn(
      { count: deadWorkers.length, workerIds: deadWorkers.map((w) => w.workerId) },
      'Dead workers detected',
    );

    const allStates = await this.lifecycle.getAllStates();

    for (const worker of deadWorkers) {
      const workerModels = allStates.filter(
        (m) => m.workerId === worker.workerId && this.isActiveOrTransitional(m.state),
      );

      for (const model of workerModels) {
        try {
          await this.lifecycle.transition(model.modelName, ModelLifecycleState.ERROR, {
            errorMessage: `Worker ${worker.workerId} is dead`,
          });
          await this.routingMap.removeModel(model.modelName);
          reconciliationDeadWorkersTotal.inc();
          this.logger.info(
            { modelName: model.modelName, workerId: worker.workerId },
            'Transitioned model to ERROR due to dead worker',
          );
        } catch (err) {
          this.logger.error(
            {
              modelName: model.modelName,
              workerId: worker.workerId,
              err: err instanceof Error ? err.message : String(err),
            },
            'Failed to handle model on dead worker',
          );
        }
      }

      this.workerPool.removeWorker(worker.workerId);
    }
  }

  private async recoverStuckModels(): Promise<void> {
    const allStates = await this.lifecycle.getAllStates();
    const now = Date.now();

    for (const model of allStates) {
      const timeoutType = TRANSITIONAL_STATES.get(model.state);
      if (timeoutType === undefined) continue;

      const timeoutSecs =
        timeoutType === 'deploy'
          ? this.config.deployTimeoutSecs
          : this.config.sleepTimeoutSecs;
      const timeoutMs = timeoutSecs * 1000;

      const stateAge = now - new Date(model.stateChangedAt).getTime();
      if (stateAge <= timeoutMs) continue;

      try {
        await this.lifecycle.transition(model.modelName, ModelLifecycleState.ERROR, {
          errorMessage: `Stuck in ${model.state} for ${Math.round(stateAge / 1000)}s (timeout: ${timeoutSecs}s)`,
        });
        await this.routingMap.removeModel(model.modelName);
        reconciliationStuckModelsTotal.inc();
        this.logger.warn(
          {
            modelName: model.modelName,
            state: model.state,
            stateAgeSecs: Math.round(stateAge / 1000),
            timeoutSecs,
          },
          'Recovered stuck model',
        );
      } catch (err) {
        this.logger.error(
          {
            modelName: model.modelName,
            state: model.state,
            err: err instanceof Error ? err.message : String(err),
          },
          'Failed to recover stuck model',
        );
      }
    }
  }

  private async refreshMetrics(): Promise<void> {
    const allStates = await this.lifecycle.getAllStates();
    const stateCounts = new Map<string, number>();
    for (const state of Object.values(ModelLifecycleState)) {
      stateCounts.set(state, 0);
    }
    for (const model of allStates) {
      stateCounts.set(model.state, (stateCounts.get(model.state) ?? 0) + 1);
    }
    for (const [state, count] of stateCounts) {
      modelsTotal.set({ state }, count);
    }

    const allWorkers = this.workerPool.getAllWorkers();
    const statusCounts = new Map<string, number>();
    for (const status of Object.values(WorkerStatus)) {
      statusCounts.set(status, 0);
    }
    for (const worker of allWorkers) {
      statusCounts.set(worker.status, (statusCounts.get(worker.status) ?? 0) + 1);
    }
    for (const [status, count] of statusCounts) {
      workersTotal.set({ status }, count);
    }

    const allBudgets = this.memoryBudget.getAllBudgets();
    for (const budget of allBudgets) {
      if (budget.stale) continue;
      for (const device of budget.devices) {
        deviceMemoryBytes.set({ worker_id: budget.workerId, state: 'total' }, device.totalBytes);
        deviceMemoryBytes.set({ worker_id: budget.workerId, state: 'used' }, device.usedBytes);
        deviceMemoryBytes.set(
          { worker_id: budget.workerId, state: 'available' },
          device.availableBytes,
        );
      }
    }
  }

  private isActiveOrTransitional(state: ModelLifecycleState): boolean {
    return state !== ModelLifecycleState.STOPPED && state !== ModelLifecycleState.ERROR;
  }
}
