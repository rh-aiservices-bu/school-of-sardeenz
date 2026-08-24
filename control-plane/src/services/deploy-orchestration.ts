import { ModelLifecycleState, RunnerState } from '@sardeenz/types';
import type { RunnerClient } from '../clients/runner.js';
import type { WorkerClient, StartRunnerRequest } from '../clients/worker.js';
import {
  deployDuration,
  deployTriggersTotal,
  runnerHealthCheckErrorsTotal,
} from '../health/metrics.js';
import { ControlPlaneError } from '../errors.js';
import { delaySafe } from '../utils.js';
import type { ModelLifecycleService } from './model-lifecycle.js';
import type { MemoryBudgetService } from './memory-budget.js';
import type { RoutingMapService, RunnerEndpoint } from './routing-map.js';
import type { WorkerPoolService } from './worker-pool.js';
import type { NotificationService } from './notification.js';
import { refreshModelRoutingState } from './sleep-wake.js';

export interface DeployModelParams {
  modelName: string;
  instanceId: string;
  workerId: string;
  runnerType: string;
  modelPath: string;
  requiredMemory: number;
  deviceType?: string;
  tensorParallel: number;
  engineConfig?: Record<string, unknown>;
  engineArgs?: string[];
  runtimeModule?: string;
  servedModelName?: string;
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
      // The route handler has already created this instance's Redis record (PENDING, then
      // STARTING) before calling deployModel() in the background — refresh the model-level
      // routing aggregate from all instances rather than stomping it to STARTING, since another
      // instance of this model may already be ACTIVE (a second replica deploying must not make
      // an already-healthy model look like it's starting from scratch).
      await refreshModelRoutingState(this.lifecycle, this.routingMap, params.modelName);

      const worker = this.workerPool.getWorker(params.workerId);
      if (!worker) {
        throw ControlPlaneError.workerNotFound(params.workerId);
      }

      const workerClient = this.createWorkerClient(worker.managementUrl);
      const startRequest: StartRunnerRequest = {
        modelName: params.modelName,
        servedModelName: params.servedModelName,
        instanceId: params.instanceId,
        runnerType: params.runnerType,
        modelPath: params.modelPath,
        requiredMemory: params.requiredMemory,
        deviceType: params.deviceType,
        tensorParallel: params.tensorParallel,
        engineConfig: params.engineConfig,
        engineArgs: params.engineArgs,
        runtimeModule: params.runtimeModule,
        devices: params.devices as StartRunnerRequest['devices'],
      };
      const runnerInfo = await workerClient.startRunner(startRequest);

      // The management port drives health/sleep/wake; the engine port (when the runner reports a
      // distinct one, e.g. vLLM's OpenAI server) is where inference is served and what the proxy
      // must target. Runners that serve inference on the management port omit enginePort — fall back.
      const enginePort = runnerInfo.enginePort ?? runnerInfo.port;

      // Persist the placement immediately (before waitForReady) so log streaming can
      // resolve the runner while the instance is still STARTING, rather than only after
      // the ACTIVE transition below.
      await this.lifecycle.setRunnerEndpoint(params.modelName, params.instanceId, {
        runnerId: runnerInfo.runnerId,
        host: runnerInfo.host,
        port: runnerInfo.port,
        enginePort,
      });

      // Health-poll the management shim, not the engine port.
      const runnerClient = this.createRunnerClient(runnerInfo.host, runnerInfo.port);
      await this.waitForReady(params.modelName, params.instanceId, runnerClient);

      // Route inference to the engine port so the proxy reaches the OpenAI server, not the shim.
      const endpoint: RunnerEndpoint = {
        host: runnerInfo.host,
        port: enginePort,
        weight: 1,
        healthy: true,
        runnerId: runnerInfo.runnerId,
      };
      await this.routingMap.addEndpoint(params.modelName, endpoint);

      await this.lifecycle.transition(
        params.modelName,
        params.instanceId,
        ModelLifecycleState.ACTIVE,
        {
          runnerHost: runnerInfo.host,
          runnerPort: runnerInfo.port,
          runnerEnginePort: enginePort,
          runnerId: runnerInfo.runnerId,
        },
      );
      await refreshModelRoutingState(this.lifecycle, this.routingMap, params.modelName);
      this.memoryBudget.releaseInstanceReservations(params.instanceId);

      this.notifications
        ?.createNotification({
          title: 'Model deployed',
          description: `${params.modelName} (${params.instanceId}) is now active`,
          variant: 'success',
          source: { type: 'model', name: params.modelName },
        })
        .catch(() => {});

      deployDuration.observe((Date.now() - startedAt) / 1000);
    } catch (err) {
      await this.transitionToError(
        params.modelName,
        params.instanceId,
        err instanceof Error ? err.message : String(err),
      );
      this.releaseReservations(params);
      throw err;
    }
  }

  private async waitForReady(
    modelName: string,
    instanceId: string,
    runnerClient: RunnerClient,
  ): Promise<void> {
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
          `Runner entered ERROR state while deploying instance ${instanceId} (${modelName}): ${result.message ?? 'unknown'}`,
          { modelName, instanceId, runnerMessage: result.message ?? null },
        );
      }

      await delaySafe(this.healthCheckIntervalMs, signal);
    }

    const message = `Deploy timed out after ${this.deployTimeoutMs}ms for instance ${instanceId} (${modelName})`;
    throw new ControlPlaneError(504, 'RUNNER_TIMEOUT', message, { modelName, instanceId });
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

  private async transitionToError(
    modelName: string,
    instanceId: string,
    errorMessage: string,
  ): Promise<void> {
    try {
      await this.lifecycle.transition(modelName, instanceId, ModelLifecycleState.ERROR, {
        errorMessage,
      });
      await refreshModelRoutingState(this.lifecycle, this.routingMap, modelName);
      this.notifications
        ?.createNotification({
          title: 'Model deployment failed',
          description: `${modelName} (${instanceId}): ${errorMessage}`,
          variant: 'danger',
          source: { type: 'model', name: modelName },
        })
        .catch(() => {});
    } catch {
      // Intentionally swallowed — do not mask the original error.
    }
  }

  private releaseReservations(params: DeployModelParams): void {
    this.memoryBudget.releaseInstanceReservations(params.instanceId);
  }
}
