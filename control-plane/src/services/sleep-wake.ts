import {
  ModelLifecycleState,
  ModelState,
  Protocol,
  RunnerState,
  SleepLevel,
} from '@sardeenz/types';
import type { RunnerClient } from '../clients/runner.js';
import {
  runnerHealthCheckErrorsTotal,
  sleepDuration,
  wakeDuration,
  wakeTriggersTotal,
} from '../health/metrics.js';
import { ControlPlaneError } from '../errors.js';
import { delaySafe } from '../utils.js';
import { deriveAggregateState, type ModelLifecycleService } from './model-lifecycle.js';
import type { MemoryBudgetService } from './memory-budget.js';
import type { RoutingMapService, RunnerEndpoint } from './routing-map.js';

/** Maps a ModelLifecycleState to the ModelState exposed in the routing map. */
export function toRoutingState(state: ModelLifecycleState): ModelState | null {
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

/**
 * Recompute a model's routing-map state from the aggregate of all of its current instances,
 * and write it. Replaces per-instance-operation calls to `routingMap.setModelState(modelName,
 * <fixed state>)` — with N instances, the routing-map model-level state must reflect the
 * aggregate (e.g. one instance sleeping while another stays ACTIVE must not flip the model's
 * routing state to SLEEPING). When no instances remain, removes the model from the routing map
 * entirely rather than leaving a stale STOPPED-ish entry (`toRoutingState` has no STOPPED
 * mapping). Endpoints themselves are still added/removed per instance by the callers of this
 * function — this only recomputes the model-level `state` field of the routing entry.
 */
export async function refreshModelRoutingState(
  lifecycle: ModelLifecycleService,
  routingMap: RoutingMapService,
  modelName: string,
): Promise<void> {
  const instances = await lifecycle.getInstancesForModel(modelName);
  const aggregate = deriveAggregateState(instances);
  const routingState = toRoutingState(aggregate);
  if (routingState) {
    const protocol = instances.find((i) => i.protocol)?.protocol ?? Protocol.openai;
    await routingMap.setModelState(modelName, routingState, protocol);
  } else {
    await routingMap.removeModel(modelName);
  }
}

/** Result returned by pollRunnerHealth. */
export interface RunnerHealthResult {
  state: RunnerState;
  activeRequests: number | null;
  message?: string;
}

export class SleepWakeService {
  constructor(
    private readonly lifecycle: ModelLifecycleService,
    private readonly routingMap: RoutingMapService,
    private readonly memoryBudget: MemoryBudgetService,
    private readonly sleepTimeoutMs: number,
    private readonly wakeTimeoutMs: number,
    private readonly healthCheckIntervalMs: number,
  ) {}

  /**
   * Transition an ACTIVE instance to SLEEPING:
   *   ACTIVE → DRAINING → (drain) → send /sleep → SLEEPING
   *
   * Updates the routing map (per-instance endpoint removal, then a model-level aggregate
   * refresh) at each stage. Records duration in sleepDuration histogram.
   */
  async sleepModel(
    modelName: string,
    instanceId: string,
    runnerClient: RunnerClient,
  ): Promise<void> {
    const startedAt = Date.now();

    // Fetch current instance state for endpoint details.
    const instanceState = await this.lifecycle.getInstance(modelName, instanceId);
    if (!instanceState) {
      throw ControlPlaneError.modelNotFound(`${modelName}/${instanceId}`);
    }

    try {
      // ACTIVE → DRAINING is claimed atomically by the route handler.
      // If called directly (not from route), claim it here.
      if (instanceState.state === ModelLifecycleState.ACTIVE) {
        await this.lifecycle.transition(modelName, instanceId, ModelLifecycleState.DRAINING);
      }
      await refreshModelRoutingState(this.lifecycle, this.routingMap, modelName);

      // Wait for in-flight requests to drain.
      await this.waitForDrain(modelName, instanceId, runnerClient);

      // Send sleep command. The runner's /sleep call is synchronous — it blocks until
      // offload is complete, so we apply the sleep timeout to this call directly.
      await runnerClient.sleep(SleepLevel.L1_HOST_RAM, this.sleepTimeoutMs);

      // Clear the endpoint so the proxy stops routing to this instance. Match on the same
      // (host, engine port) pair the endpoint was registered under.
      if (instanceState.runnerHost && instanceState.runnerPort) {
        await this.routingMap.removeEndpoint(
          modelName,
          instanceState.runnerHost,
          instanceState.runnerEnginePort ?? instanceState.runnerPort,
        );
      }

      // DRAINING → SLEEPING
      await this.lifecycle.transition(modelName, instanceId, ModelLifecycleState.SLEEPING);
      await refreshModelRoutingState(this.lifecycle, this.routingMap, modelName);

      sleepDuration.observe((Date.now() - startedAt) / 1000);
    } catch (err) {
      await this.transitionToError(
        modelName,
        instanceId,
        err instanceof Error ? err.message : String(err),
      );
      throw err;
    }
  }

  /**
   * Transition a SLEEPING instance back to ACTIVE:
   *   SLEEPING → STARTING → send /wake → (poll until READY) → ACTIVE
   *
   * Updates the routing map (per-instance endpoint re-add, then a model-level aggregate
   * refresh) at each stage. Records duration in wakeDuration histogram.
   */
  async wakeModel(
    modelName: string,
    instanceId: string,
    runnerClient: RunnerClient,
  ): Promise<void> {
    const startedAt = Date.now();

    wakeTriggersTotal.inc();

    const instanceState = await this.lifecycle.getInstance(modelName, instanceId);
    if (!instanceState) {
      throw ControlPlaneError.modelNotFound(`${modelName}/${instanceId}`);
    }

    try {
      // SLEEPING → STARTING is claimed atomically by the route handler.
      // If called directly (not from route), claim it here.
      if (instanceState.state === ModelLifecycleState.SLEEPING) {
        await this.lifecycle.transition(modelName, instanceId, ModelLifecycleState.STARTING);
      }
      await refreshModelRoutingState(this.lifecycle, this.routingMap, modelName);

      // Send wake command. Unlike sleep, /wake on the runner completes quickly —
      // the runner begins reloading weights but does not wait for READY itself.
      await runnerClient.wake();

      // Poll health until the runner reports READY.
      await this.waitForReady(modelName, instanceId, runnerClient);

      // Re-register the endpoint and flip state to ACTIVE. Route inference to the engine port
      // (falling back to the management port for pre-engine-port state or single-server runners).
      if (instanceState.runnerHost && instanceState.runnerPort) {
        const endpoint: RunnerEndpoint = {
          host: instanceState.runnerHost,
          port: instanceState.runnerEnginePort ?? instanceState.runnerPort,
          weight: 1,
          healthy: true,
          ...(instanceState.runnerId ? { runnerId: instanceState.runnerId } : {}),
        };
        await this.routingMap.addEndpoint(
          modelName,
          endpoint,
          instanceState.protocol ?? Protocol.openai,
        );
      }

      // STARTING → ACTIVE
      await this.lifecycle.transition(modelName, instanceId, ModelLifecycleState.ACTIVE);
      await refreshModelRoutingState(this.lifecycle, this.routingMap, modelName);

      wakeDuration.observe((Date.now() - startedAt) / 1000);
    } catch (err) {
      await this.transitionToError(
        modelName,
        instanceId,
        err instanceof Error ? err.message : String(err),
      );
      throw err;
    }
  }

  /**
   * Gracefully stop an instance regardless of its current state:
   *   ACTIVE → DRAINING → STOPPING → STOPPED  (removes the instance's endpoint)
   *   SLEEPING → STOPPING → STOPPED           (removes the instance's endpoint)
   *
   * Passing null for runnerClient skips runner communication (e.g., the runner
   * process is already gone). Does not remove the instance's Redis record or the routing
   * model-level aggregate — callers do that (see routes/models.ts) once this settles, since
   * "stop this instance" and "forget this instance" are different concerns and the caller may
   * need the settled STOPPED state for other bookkeeping first.
   */
  async stopModel(
    modelName: string,
    instanceId: string,
    runnerClient: RunnerClient | null,
  ): Promise<void> {
    const instanceState = await this.lifecycle.getInstance(modelName, instanceId);
    if (!instanceState) {
      throw ControlPlaneError.modelNotFound(`${modelName}/${instanceId}`);
    }

    try {
      const currentState = instanceState.state;

      // Move persists DRAINING before it tears the source down.  DRAINING therefore means
      // "not accepting new traffic" rather than "already empty"; always poll it before stop.
      if (currentState === ModelLifecycleState.ACTIVE) {
        await this.lifecycle.transition(modelName, instanceId, ModelLifecycleState.DRAINING);
        await refreshModelRoutingState(this.lifecycle, this.routingMap, modelName);
      }
      if (
        runnerClient &&
        (currentState === ModelLifecycleState.ACTIVE ||
          currentState === ModelLifecycleState.DRAINING)
      ) {
        await this.waitForDrain(modelName, instanceId, runnerClient);
      }

      // Remove the endpoint so routing stops immediately. Match on the same (host, engine port)
      // pair the endpoint was registered under.
      if (instanceState.runnerHost && instanceState.runnerPort) {
        await this.routingMap.removeEndpoint(
          modelName,
          instanceState.runnerHost,
          instanceState.runnerEnginePort ?? instanceState.runnerPort,
        );
      }

      // Transition to STOPPING then STOPPED. States like PENDING and STARTING
      // cannot reach STOPPING directly, so route them through ERROR first.
      const stateBeforeStopping = (await this.lifecycle.getInstance(modelName, instanceId))?.state;

      if (
        stateBeforeStopping === ModelLifecycleState.PENDING ||
        stateBeforeStopping === ModelLifecycleState.STARTING
      ) {
        await this.lifecycle.transition(modelName, instanceId, ModelLifecycleState.ERROR, {
          errorMessage: 'Instance stopped during startup',
        });
        await this.lifecycle.transition(modelName, instanceId, ModelLifecycleState.STOPPED);
      } else if (
        stateBeforeStopping === ModelLifecycleState.DRAINING ||
        stateBeforeStopping === ModelLifecycleState.SLEEPING
      ) {
        await this.lifecycle.transition(modelName, instanceId, ModelLifecycleState.STOPPING);
        await this.lifecycle.transition(modelName, instanceId, ModelLifecycleState.STOPPED);
      } else if (stateBeforeStopping === ModelLifecycleState.STOPPING) {
        await this.lifecycle.transition(modelName, instanceId, ModelLifecycleState.STOPPED);
      } else if (stateBeforeStopping === ModelLifecycleState.ERROR) {
        await this.lifecycle.transition(modelName, instanceId, ModelLifecycleState.STOPPED);
      }
      // STOPPED is already terminal — no transition needed.

      await refreshModelRoutingState(this.lifecycle, this.routingMap, modelName);
      this.memoryBudget.releaseInstanceReservations(instanceId);
    } catch (err) {
      await this.transitionToError(
        modelName,
        instanceId,
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
    instanceId: string,
    runnerClient: RunnerClient,
  ): Promise<RunnerHealthResult> {
    try {
      const health = await runnerClient.getHealth();

      // Detect unexpected runner state transitions and surface them.
      const instanceState = await this.lifecycle.getInstance(modelName, instanceId);
      if (instanceState && health.state === RunnerState.ERROR) {
        await this.transitionToError(
          modelName,
          instanceId,
          health.message ?? 'Runner reported ERROR state during health check',
        );
      }

      return {
        state: health.state,
        activeRequests: health.activeRequests ?? null,
        message: health.message,
      };
    } catch (err) {
      runnerHealthCheckErrorsTotal.inc();
      const message = err instanceof Error ? err.message : String(err);
      return {
        state: RunnerState.ERROR,
        activeRequests: null,
        message,
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  // Consecutive failed health polls before waitForDrain fast-fails. The health endpoint is
  // answered by the runner's own shim — the runner being down is not a transient "busy" state
  // that polling can outlast, it means there is nothing left to drain. Three polls keeps a
  // single blip (a dropped health read while the runner is otherwise fine) from cutting a
  // genuine drain short.
  private static readonly MAX_CONSECUTIVE_HEALTH_FAILURES = 3;

  /**
   * Poll the runner's health until activeRequests reaches 0 (drain complete),
   * respecting sleepTimeoutMs via AbortSignal.timeout().
   *
   * Fast-fails (defence in depth for #166) when the runner becomes unreachable: N consecutive
   * failed health polls means there is no live process left to drain, so waiting out the full
   * sleep timeout only burns the user-visible stop time (~sleepTimeoutSecs of "Draining"). The
   * caller's catch transitions the instance to ERROR, exactly as a drain timeout would — just
   * within one or two poll intervals instead of minutes. A successful poll resets the streak,
   * so intermittent blips on a healthy runner still complete their drain normally.
   */
  private async waitForDrain(
    modelName: string,
    instanceId: string,
    runnerClient: RunnerClient,
  ): Promise<void> {
    const signal = AbortSignal.timeout(this.sleepTimeoutMs);
    let consecutiveFailures = 0;

    while (!signal.aborted) {
      const result = await this.pollRunnerHealth(modelName, instanceId, runnerClient);

      if (result.state === RunnerState.ERROR) {
        // pollRunnerHealth reports ERROR for (a) a failed health call — the runner's shim is
        // unreachable, so there is no live process left to drain — and (b) a reachable runner
        // self-reporting ERROR, whose record pollRunnerHealth has already transitioned to
        // ERROR. Counting both is right: in (a) polling waits on a dead process, in (b) the
        // record is already in ERROR, so continuing the drain buys nothing either way.
        consecutiveFailures += 1;
        if (consecutiveFailures >= SleepWakeService.MAX_CONSECUTIVE_HEALTH_FAILURES) {
          const message = `Runner for instance ${instanceId} (${modelName}) became unreachable during drain: ${result.message ?? 'health check failed'}`;
          throw new ControlPlaneError(502, 'RUNNER_UNAVAILABLE', message, {
            modelName,
            instanceId,
            runnerMessage: result.message ?? null,
          });
        }
      } else {
        consecutiveFailures = 0;
      }

      if (result.activeRequests !== null && result.activeRequests === 0) {
        return;
      }

      await delaySafe(this.healthCheckIntervalMs, signal);
    }

    const message = `Drain timed out after ${this.sleepTimeoutMs}ms for instance ${instanceId} (${modelName})`;
    throw new ControlPlaneError(504, 'RUNNER_TIMEOUT', message, { modelName, instanceId });
  }

  /**
   * Poll the runner's health until state is READY or BUSY, respecting
   * wakeTimeoutMs via AbortSignal.timeout().
   */
  private async waitForReady(
    modelName: string,
    instanceId: string,
    runnerClient: RunnerClient,
  ): Promise<void> {
    const signal = AbortSignal.timeout(this.wakeTimeoutMs);

    while (!signal.aborted) {
      const result = await this.pollRunnerHealth(modelName, instanceId, runnerClient);

      if (result.state === RunnerState.READY || result.state === RunnerState.BUSY) {
        return;
      }

      if (result.state === RunnerState.ERROR) {
        throw new ControlPlaneError(
          502,
          'RUNNER_UNAVAILABLE',
          `Runner entered ERROR state while waking instance ${instanceId} (${modelName}): ${result.message ?? 'unknown'}`,
          { modelName, instanceId, runnerMessage: result.message ?? null },
        );
      }

      await delaySafe(this.healthCheckIntervalMs, signal);
    }

    const message = `Wake timed out after ${this.wakeTimeoutMs}ms for instance ${instanceId} (${modelName})`;
    throw new ControlPlaneError(504, 'RUNNER_TIMEOUT', message, { modelName, instanceId });
  }

  /**
   * Best-effort transition to ERROR state and refresh the routing map's aggregate.
   * Swallows errors so it can be safely called from catch blocks.
   */
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
    } catch {
      // Intentionally swallowed — do not mask the original error.
    }
  }
}
