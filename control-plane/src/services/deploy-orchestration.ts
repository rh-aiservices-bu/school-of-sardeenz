import { ModelLifecycleState, ModelState, RunnerState } from '@sardeenz/types';
import type { RunnerClient } from '../clients/runner.js';
import type { WorkerClient, StartRunnerRequest } from '../clients/worker.js';
import {
  deployDuration,
  deployTriggersTotal,
  runnerHealthCheckErrorsTotal,
} from '../health/metrics.js';
import { ControlPlaneError } from '../errors.js';
import { delay } from '../utils.js';
import type { ModelLifecycleService } from './model-lifecycle.js';
import type { MemoryBudgetService } from './memory-budget.js';
import type { RoutingMapService, RunnerEndpoint } from './routing-map.js';
import type { WorkerPoolService } from './worker-pool.js';
import type { NotificationService } from './notification.js';

export interface DeployModelParams {
  modelName: string;
  workerId: string;
  runnerType: string;
  modelPath: string;
  requiredMemory: number;
  deviceType?: string;
  tensorParallel: number;
  engineConfig?: Record<string, unknown>;
  runtimeModule?: string;
  devices: { deviceIndex: number; deviceType: string }[];
}

export class DeployOrchestrationService {
  constructor(
    private readonly lifecycle: ModelLifecycleService,
    private readonly routingMap: RoutingMapService,
    private readonly workerPool: WorkerPoolService,
    private readonly memoryBudget: MemoryBudgetService,
    private readonly createWorkerClient: (baseUrl: string) => WorkerClient,
    private readonly createRunnerClient: (host: string, port: number) => RunnerClient,
    private readonly deployTimeoutMs: number,
    private readonly healthCheckIntervalMs: number,
    private readonly notifications?: NotificationService,
  ) {}

  async deployModel(params: DeployModelParams): Promise<void> {
    const startedAt = Date.now();
    deployTriggersTotal.inc();

    try {
      await this.routingMap.setModelState(params.modelName, ModelState.STARTING);

      const worker = this.workerPool.getWorker(params.workerId);
      if (!worker) {
        throw ControlPlaneError.workerNotFound(params.workerId);
      }
      if (!worker.managementUrl) {
        throw new ControlPlaneError(
          500,
          'INTERNAL_ERROR',
          `Worker ${params.workerId} has no management URL`,
        );
      }

      const workerClient = this.createWorkerClient(worker.managementUrl);
      const startRequest: StartRunnerRequest = {
        modelName: params.modelName,
        runnerType: params.runnerType,
        modelPath: params.modelPath,
        requiredMemory: params.requiredMemory,
        deviceType: params.deviceType,
        tensorParallel: params.tensorParallel,
        engineConfig: params.engineConfig,
        runtimeModule: params.runtimeModule,
        devices: params.devices,
      };
      const runnerInfo = await workerClient.startRunner(startRequest);

      // Persist the placement immediately (before waitForReady) so log streaming can
      // resolve the runner while the model is still STARTING, rather than only after
      // the ACTIVE transition below.
      await this.lifecycle.setRunnerEndpoint(params.modelName, {
        runnerId: runnerInfo.runnerId,
        host: runnerInfo.host,
        port: runnerInfo.port,
      });

      const runnerClient = this.createRunnerClient(runnerInfo.host, runnerInfo.port);
      await this.waitForReady(params.modelName, runnerClient);

      const endpoint: RunnerEndpoint = {
        host: runnerInfo.host,
        port: runnerInfo.port,
        weight: 1,
        healthy: true,
        runnerId: runnerInfo.runnerId,
      };
      await this.routingMap.addEndpoint(params.modelName, endpoint);

      await this.lifecycle.transition(params.modelName, ModelLifecycleState.ACTIVE, {
        runnerHost: runnerInfo.host,
        runnerPort: runnerInfo.port,
        runnerId: runnerInfo.runnerId,
      });
      await this.routingMap.setModelState(params.modelName, ModelState.ACTIVE);

      this.notifications
        ?.createNotification({
          title: 'Model deployed',
          description: `${params.modelName} is now active`,
          variant: 'success',
          source: { type: 'model', name: params.modelName },
        })
        .catch(() => {});

      deployDuration.observe((Date.now() - startedAt) / 1000);
    } catch (err) {
      await this.transitionToError(
        params.modelName,
        err instanceof Error ? err.message : String(err),
      );
      this.releaseReservations(params);
      throw err;
    }
  }

  private async waitForReady(modelName: string, runnerClient: RunnerClient): Promise<void> {
    const signal = AbortSignal.timeout(this.deployTimeoutMs);

    while (!signal.aborted) {
      const result = await this.pollRunnerHealth(runnerClient);

      if (result.state === RunnerState.READY || result.state === RunnerState.BUSY) {
        return;
      }

      if (result.state === RunnerState.ERROR) {
        throw new ControlPlaneError(
          502,
          'RUNNER_UNAVAILABLE',
          `Runner entered ERROR state while deploying model ${modelName}: ${result.message ?? 'unknown'}`,
          { modelName, runnerMessage: result.message ?? null },
        );
      }

      await delay(this.healthCheckIntervalMs, signal);
    }

    const message = `Deploy timed out after ${this.deployTimeoutMs}ms for model ${modelName}`;
    throw new ControlPlaneError(504, 'RUNNER_TIMEOUT', message, { modelName });
  }

  private async pollRunnerHealth(
    runnerClient: RunnerClient,
  ): Promise<{ state: RunnerState; activeRequests: number; message?: string }> {
    try {
      const health = await runnerClient.getHealth();
      return {
        state: health.state,
        activeRequests: health.activeRequests ?? 0,
        message: health.message,
      };
    } catch (err) {
      runnerHealthCheckErrorsTotal.inc();
      const message = err instanceof Error ? err.message : String(err);
      return {
        state: RunnerState.ERROR,
        activeRequests: 0,
        message,
      };
    }
  }

  private async transitionToError(modelName: string, errorMessage: string): Promise<void> {
    try {
      await this.lifecycle.transition(modelName, ModelLifecycleState.ERROR, { errorMessage });
      await this.routingMap.setModelState(modelName, ModelState.ERROR);
      this.notifications
        ?.createNotification({
          title: 'Model deployment failed',
          description: `${modelName}: ${errorMessage}`,
          variant: 'danger',
          source: { type: 'model', name: modelName },
        })
        .catch(() => {});
    } catch {
      // Intentionally swallowed — do not mask the original error.
    }
  }

  private releaseReservations(params: DeployModelParams): void {
    const perDevice = params.requiredMemory / params.tensorParallel;
    for (const device of params.devices) {
      this.memoryBudget.releaseCapacity(params.workerId, device.deviceIndex, perDevice);
    }
  }
}
