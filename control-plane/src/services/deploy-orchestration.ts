import { ModelLifecycleState, Protocol, RunnerState } from '@sardeenz/types';
import type { RunnerClient } from '../clients/runner.js';
import { WorkerHttpError, type WorkerClient, type StartRunnerRequest } from '../clients/worker.js';
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
import type { StartupLogCaptureService } from './startup-log-capture.js';

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
  protocol: Protocol;
  entrypoint?: string[];
  devices: { deviceIndex: number; deviceType: string }[];
  /**
   * Optional fence for a deployment owned by a leader-scoped durable operation. When it turns
   * false, leave the instance and its capacity intact for the next leader to recover by
   * instanceId; treating leadership loss as a deployment failure could kill a healthy runner.
   */
  isStillOwner?: () => boolean;
}

class DeployOwnershipLostError extends Error {
  constructor() {
    super('Deployment ownership was lost during runner startup');
    this.name = 'DeployOwnershipLostError';
  }
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
    private readonly startupLogs?: StartupLogCaptureService,
  ) {}

  async deployModel(params: DeployModelParams): Promise<void> {
    const startedAt = Date.now();
    deployTriggersTotal.inc();
    // A network failure after POST has been sent is not evidence that the worker did not start
    // the runner.  Keep the placement observable (and its capacity accounted for) until
    // reconciliation can establish the runner's fate.
    let startDispatched = false;
    let startReplyReceived = false;
    const assertStillOwner = (): void => {
      if (params.isStillOwner && !params.isStillOwner()) {
        throw new DeployOwnershipLostError();
      }
    };

    try {
      assertStillOwner();
      // The route handler has already created this instance's Redis record (PENDING, then
      // STARTING) before calling deployModel() in the background — refresh the model-level
      // routing aggregate from all instances rather than stomping it to STARTING, since another
      // instance of this model may already be ACTIVE (a second replica deploying must not make
      // an already-healthy model look like it's starting from scratch).
      await refreshModelRoutingState(this.lifecycle, this.routingMap, params.modelName);
      assertStillOwner();

      const worker = this.workerPool.getWorker(params.workerId);
      if (!worker) {
        throw ControlPlaneError.workerNotFound(params.workerId);
      }

      const workerClient = this.createWorkerClient(worker.managementUrl);
      await this.startupLogs?.start(params.instanceId, params.modelName, params.workerId);
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
        entrypoint: params.entrypoint,
        devices: params.devices as StartRunnerRequest['devices'],
      };
      assertStillOwner();
      startDispatched = true;
      const runnerInfo = await workerClient.startRunner(startRequest);
      startReplyReceived = true;
      assertStillOwner();

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
      assertStillOwner();

      // Health-poll the management shim, not the engine port.
      const runnerClient = this.createRunnerClient(runnerInfo.host, runnerInfo.port);
      await this.waitForReady(params.modelName, params.instanceId, runnerClient);
      assertStillOwner();

      // Route inference to the engine port so the proxy reaches the OpenAI server, not the shim.
      const endpoint: RunnerEndpoint = {
        host: runnerInfo.host,
        port: enginePort,
        weight: 1,
        healthy: true,
        runnerId: runnerInfo.runnerId,
      };
      await this.routingMap.addEndpoint(params.modelName, endpoint, params.protocol);
      assertStillOwner();

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
      assertStillOwner();
      await refreshModelRoutingState(this.lifecycle, this.routingMap, params.modelName);
      this.memoryBudget.releaseInstanceReservations(params.instanceId);
      await this.startupLogs?.markSucceeded(params.instanceId).catch(() => {});

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
      // A new leader owns cleanup/recovery now. Preserve the STARTING/ACTIVE record and capacity;
      // the durable move transaction will resolve the worker's stable instanceId. Also recognize
      // a race where ownership changed between the last explicit check and another awaited write.
      if (
        err instanceof DeployOwnershipLostError ||
        (params.isStillOwner && !params.isStillOwner())
      ) {
        throw err instanceof DeployOwnershipLostError ? err : new DeployOwnershipLostError();
      }
      // A validation/auth rejection is a definite worker response. A conflict means this
      // instance already has a runner, and a server error can happen after the worker committed
      // the start but before it serialized the reply; both are ambiguous just like a transport
      // failure and must retain capacity until instance-id reconciliation establishes the fact.
      const startReplyAmbiguous =
        startDispatched &&
        !startReplyReceived &&
        (!(err instanceof WorkerHttpError) || err.status === 409 || err.status >= 500);
      await this.transitionToError(
        params.modelName,
        params.instanceId,
        err instanceof Error ? err.message : String(err),
        startReplyAmbiguous,
      );
      await this.startupLogs
        ?.markFailed(params.instanceId, err instanceof Error ? err.message : String(err))
        .catch(() => {});
      if (!startReplyAmbiguous) this.releaseReservations(params);
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
    runnerStartAmbiguous = false,
  ): Promise<void> {
    try {
      await this.lifecycle.transition(modelName, instanceId, ModelLifecycleState.ERROR, {
        errorMessage,
        ...(runnerStartAmbiguous ? { runnerStartAmbiguous: true } : {}),
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
