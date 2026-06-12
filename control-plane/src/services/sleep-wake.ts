import { ModelLifecycleState, ModelState, RunnerState, SleepLevel } from '@sardeenz/types';
import type { RunnerClient } from '../clients/runner.js';
import {
  runnerHealthCheckErrorsTotal,
  sleepDuration,
  wakeDuration,
  wakeTriggersTotal,
} from '../health/metrics.js';
import { ControlPlaneError } from '../errors.js';
import type { ModelLifecycleService } from './model-lifecycle.js';
import type { RoutingMapService, RunnerEndpoint } from './routing-map.js';

/** Maps a ModelLifecycleState to the ModelState exposed in the routing map. */
function toRoutingState(state: ModelLifecycleState): ModelState | null {
  switch (state) {
    case ModelLifecycleState.STARTING:
      return ModelState.STARTING;
    case ModelLifecycleState.ACTIVE:
      return ModelState.ACTIVE;
    case ModelLifecycleState.DRAINING:
      return ModelState.DRAINING;
    case ModelLifecycleState.SLEEPING:
      return ModelState.SLEEPING;
    case ModelLifecycleState.ERROR:
      return ModelState.ERROR;
    // PENDING, STOPPING, STOPPED have no routing-map representation
    default:
      return null;
  }
}

/** Delay helper that respects an AbortSignal. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abortError = (): Error =>
      signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError');

    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(abortError());
    });
  });
}

/** Result returned by pollRunnerHealth. */
export interface RunnerHealthResult {
  state: RunnerState;
  activeRequests: number;
  message?: string;
}

export class SleepWakeService {
  constructor(
    private readonly lifecycle: ModelLifecycleService,
    private readonly routingMap: RoutingMapService,
    private readonly sleepTimeoutMs: number,
    private readonly wakeTimeoutMs: number,
    private readonly healthCheckIntervalMs: number,
  ) {}

  /**
   * Transition an ACTIVE model to SLEEPING:
   *   ACTIVE → DRAINING → (drain) → send /sleep → SLEEPING
   *
   * Updates the routing map at each stage. Records duration in sleepDuration histogram.
   */
  async sleepModel(modelName: string, runnerClient: RunnerClient): Promise<void> {
    const startedAt = Date.now();

    // Fetch current model state for endpoint details.
    const modelState = await this.lifecycle.getState(modelName);
    if (!modelState) {
      throw ControlPlaneError.modelNotFound(modelName);
    }

    try {
      // ACTIVE → DRAINING
      await this.lifecycle.transition(modelName, ModelLifecycleState.DRAINING);
      await this.routingMap.setModelState(modelName, ModelState.DRAINING);

      // Wait for in-flight requests to drain.
      await this.waitForDrain(modelName, runnerClient);

      // Send sleep command. The runner's /sleep call is synchronous — it blocks until
      // offload is complete, so we apply the sleep timeout to this call directly.
      await runnerClient.sleep(SleepLevel.L1_HOST_RAM);

      // Clear the endpoint so the proxy stops routing to this model.
      if (modelState.runnerHost && modelState.runnerPort) {
        await this.routingMap.removeEndpoint(modelName, modelState.runnerHost, modelState.runnerPort);
      }

      // DRAINING → SLEEPING
      await this.lifecycle.transition(modelName, ModelLifecycleState.SLEEPING);
      await this.routingMap.setModelState(modelName, ModelState.SLEEPING);

      sleepDuration.observe((Date.now() - startedAt) / 1000);
    } catch (err) {
      await this.transitionToError(
        modelName,
        err instanceof Error ? err.message : String(err),
      );
      throw err;
    }
  }

  /**
   * Transition a SLEEPING model back to ACTIVE:
   *   SLEEPING → STARTING → send /wake → (poll until READY) → ACTIVE
   *
   * Updates the routing map at each stage. Records duration in wakeDuration histogram.
   */
  async wakeModel(modelName: string, runnerClient: RunnerClient): Promise<void> {
    const startedAt = Date.now();

    wakeTriggersTotal.inc();

    const modelState = await this.lifecycle.getState(modelName);
    if (!modelState) {
      throw ControlPlaneError.modelNotFound(modelName);
    }

    try {
      // SLEEPING → STARTING
      await this.lifecycle.transition(modelName, ModelLifecycleState.STARTING);
      await this.routingMap.setModelState(modelName, ModelState.STARTING);

      // Send wake command. Unlike sleep, /wake on the runner completes quickly —
      // the runner begins reloading weights but does not wait for READY itself.
      await runnerClient.wake();

      // Poll health until the runner reports READY.
      await this.waitForReady(modelName, runnerClient);

      // Re-register the endpoint and flip state to ACTIVE.
      if (modelState.runnerHost && modelState.runnerPort) {
        const endpoint: RunnerEndpoint = {
          host: modelState.runnerHost,
          port: modelState.runnerPort,
          weight: 1,
          healthy: true,
          ...(modelState.runnerId ? { runnerId: modelState.runnerId } : {}),
        };
        await this.routingMap.addEndpoint(modelName, endpoint);
      }

      // STARTING → ACTIVE
      await this.lifecycle.transition(modelName, ModelLifecycleState.ACTIVE);
      await this.routingMap.setModelState(modelName, ModelState.ACTIVE);

      wakeDuration.observe((Date.now() - startedAt) / 1000);
    } catch (err) {
      await this.transitionToError(
        modelName,
        err instanceof Error ? err.message : String(err),
      );
      throw err;
    }
  }

  /**
   * Gracefully stop a model regardless of its current state:
   *   ACTIVE → DRAINING → STOPPING → STOPPED  (removes from routing map)
   *   SLEEPING → STOPPING → STOPPED           (removes from routing map)
   *
   * Passing null for runnerClient skips runner communication (e.g., the runner
   * process is already gone).
   */
  async stopModel(modelName: string, runnerClient: RunnerClient | null): Promise<void> {
    const modelState = await this.lifecycle.getState(modelName);
    if (!modelState) {
      throw ControlPlaneError.modelNotFound(modelName);
    }

    try {
      const currentState = modelState.state;

      // If ACTIVE, drain first.
      if (currentState === ModelLifecycleState.ACTIVE) {
        await this.lifecycle.transition(modelName, ModelLifecycleState.DRAINING);
        await this.routingMap.setModelState(modelName, ModelState.DRAINING);

        if (runnerClient) {
          await this.waitForDrain(modelName, runnerClient);
        }
      }

      // Remove the endpoint so routing stops immediately.
      if (modelState.runnerHost && modelState.runnerPort) {
        await this.routingMap.removeEndpoint(modelName, modelState.runnerHost, modelState.runnerPort);
      }

      // Transition to STOPPING then STOPPED.
      const stateBeforeStopping = (await this.lifecycle.getState(modelName))?.state;
      if (
        stateBeforeStopping === ModelLifecycleState.DRAINING ||
        stateBeforeStopping === ModelLifecycleState.SLEEPING
      ) {
        await this.lifecycle.transition(modelName, ModelLifecycleState.STOPPING);
      }
      await this.lifecycle.transition(modelName, ModelLifecycleState.STOPPED);

      // Remove from routing map entirely.
      await this.routingMap.removeModel(modelName);
    } catch (err) {
      await this.transitionToError(
        modelName,
        err instanceof Error ? err.message : String(err),
      );
      throw err;
    }
  }

  /**
   * Perform a single health check against the runner and return its state.
   * Increments the error counter on failure rather than throwing.
   */
  async pollRunnerHealth(
    modelName: string,
    runnerClient: RunnerClient,
  ): Promise<RunnerHealthResult> {
    try {
      const health = await runnerClient.getHealth();

      // Detect unexpected runner state transitions and surface them.
      const modelState = await this.lifecycle.getState(modelName);
      if (modelState && health.state === RunnerState.ERROR) {
        await this.transitionToError(
          modelName,
          health.message ?? 'Runner reported ERROR state during health check',
        );
      }

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

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Poll the runner's health until activeRequests reaches 0 (drain complete),
   * respecting sleepTimeoutMs via AbortSignal.timeout().
   */
  private async waitForDrain(modelName: string, runnerClient: RunnerClient): Promise<void> {
    const signal = AbortSignal.timeout(this.sleepTimeoutMs);

    while (!signal.aborted) {
      const result = await this.pollRunnerHealth(modelName, runnerClient);

      if (result.activeRequests === 0) {
        return;
      }

      await delay(this.healthCheckIntervalMs, signal);
    }

    // AbortSignal.timeout() throws DOMException('TimeoutError') when aborted,
    // but the while loop exits cleanly — fall through to the error.
    const message = `Drain timed out after ${this.sleepTimeoutMs}ms for model ${modelName}`;
    throw new ControlPlaneError(504, 'RUNNER_TIMEOUT', message, { modelName });
  }

  /**
   * Poll the runner's health until state is READY or BUSY, respecting
   * wakeTimeoutMs via AbortSignal.timeout().
   */
  private async waitForReady(modelName: string, runnerClient: RunnerClient): Promise<void> {
    const signal = AbortSignal.timeout(this.wakeTimeoutMs);

    while (!signal.aborted) {
      const result = await this.pollRunnerHealth(modelName, runnerClient);

      if (result.state === RunnerState.READY || result.state === RunnerState.BUSY) {
        return;
      }

      if (result.state === RunnerState.ERROR) {
        throw new ControlPlaneError(
          502,
          'RUNNER_UNAVAILABLE',
          `Runner entered ERROR state while waking model ${modelName}: ${result.message ?? 'unknown'}`,
          { modelName, runnerMessage: result.message ?? null },
        );
      }

      await delay(this.healthCheckIntervalMs, signal);
    }

    const message = `Wake timed out after ${this.wakeTimeoutMs}ms for model ${modelName}`;
    throw new ControlPlaneError(504, 'RUNNER_TIMEOUT', message, { modelName });
  }

  /**
   * Best-effort transition to ERROR state and update the routing map.
   * Swallows errors so it can be safely called from catch blocks.
   */
  private async transitionToError(modelName: string, errorMessage: string): Promise<void> {
    try {
      await this.lifecycle.transition(modelName, ModelLifecycleState.ERROR, { errorMessage });
      const routingState = toRoutingState(ModelLifecycleState.ERROR);
      if (routingState) {
        await this.routingMap.setModelState(modelName, routingState);
      }
    } catch {
      // Intentionally swallowed — do not mask the original error.
    }
  }
}
