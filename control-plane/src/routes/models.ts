import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { ModelLifecycleState } from '@sardeenz/types';

import type { RouteDeps } from './deps.js';
import { ControlPlaneError } from '../errors.js';
import { isContainedIn } from '../utils/path-containment.js';
import {
  assertModelNameRoutableForProtocol,
  assertValidModelName,
  MODEL_NAME_PATTERN,
} from '../utils/model-name.js';
import type { ModelRecord } from '../services/model-repository.js';
import { deriveAggregateState, type InstanceState } from '../services/model-lifecycle.js';
import { refreshModelRoutingState } from '../services/sleep-wake.js';
import { WorkerHttpError } from '../clients/worker.js';

interface DeployBody {
  modelName: string;
  runnerType: string;
  modelPath: string;
  requiredMemory: number;
  deviceType?: string;
  tensorParallel?: number;
  engineConfig?: Record<string, unknown>;
  engineArgs?: string[];
  runtimeModule?: string;
  servedModelName?: string;
  displayName?: string;
  pinned?: boolean;
}

interface MoveBody {
  targetWorkerId: string;
  targetDeviceIndices: number[];
}

// Mirrors the worker-agent contract's runtimeModule pattern; it becomes a SIF filename segment.
const RUNTIME_MODULE_PATTERN = /^[A-Za-z0-9_.-]+$/;

// engineArgs sanity caps (#126 review) — generous enough for any real vLLM invocation while
// bounding the payload the control plane accepts and forwards to a worker.
const MAX_ENGINE_ARGS_COUNT = 128;
const MAX_ENGINE_ARG_LENGTH = 512;

// Stop is only valid from these settled states. Every other state (PENDING, STARTING, DRAINING,
// STOPPING, and the synthetic STOPPED) is transient or already-terminal background work in
// flight — interrupting it would race the fire-and-forget deploy/start/wake orchestration and
// leave an orphaned runner holding VRAM the budget no longer accounts for. ERROR is included
// deliberately: the dashboard offers Stop from it, and sleepWake.stopModel already knows how to
// tear an ERROR-state instance down (see VALID_TRANSITIONS in model-lifecycle.ts).
const STOPPABLE_STATES: ReadonlySet<ModelLifecycleState> = new Set([
  ModelLifecycleState.ACTIVE,
  ModelLifecycleState.SLEEPING,
  ModelLifecycleState.ERROR,
]);

// Delete is rejected from these transient states (M10 decision, #140): every one has
// fire-and-forget background work in flight (deploy/start/wake orchestration, sleep drain,
// or a running stop) that no synchronous teardown can cancel — deleting would release the
// VRAM reservation and the lifecycle key while startRunner still completes on the worker,
// orphaning a runner holding VRAM the budget counts as free. The complement — ACTIVE,
// SLEEPING, STOPPED, ERROR — is deletable with 202: stopModel settles ERROR/SLEEPING/ACTIVE
// via VALID_TRANSITIONS, and a STOPPED record carries no live process.
const TRANSIENT_FOR_DELETE: ReadonlySet<ModelLifecycleState> = new Set([
  ModelLifecycleState.PENDING,
  ModelLifecycleState.STARTING,
  ModelLifecycleState.DRAINING,
  ModelLifecycleState.STOPPING,
]);

/** Mint a fresh instance identity. Control-plane-assigned, no coordination needed (ADR-019 §0). */
function mintInstanceId(): string {
  return `inst-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

/**
 * Stop one instance's runner, clear its Redis lifecycle state, and delete its Postgres row.
 * Isolated: every failure is caught, logged with `context`, and never rethrown — a caller
 * fanning this out over several instances (via `Promise.allSettled`) is guaranteed that one
 * instance's teardown failure never aborts, or is even visible to, the others. Returns `true` on
 * success, `false` on failure (already logged) so the caller can count/report failures without
 * re-catching.
 *
 * On a non-404 `stopRunner` failure (or an unresolvable worker), the process is left running and
 * this function returns `false` with the Redis record retained. That retained record does not
 * strand the process forever: e.g. after Delete's unconditional model-row removal, it becomes an
 * orphan (Redis instance, no Postgres model row), and `ReconciliationService.reapOrphanedInstances`
 * now best-effort re-attempts `stopRunner` on it before dropping the record, rather than silently
 * dropping a still-live process's bookkeeping (round-3 review, #157).
 */
async function teardownInstance(
  app: FastifyInstance,
  deps: RouteDeps,
  modelName: string,
  instance: Pick<InstanceState, 'instanceId' | 'runnerHost' | 'runnerPort'>,
  context: string,
): Promise<boolean> {
  try {
    const runnerClient =
      instance.runnerHost && instance.runnerPort
        ? deps.createRunnerClient(instance.runnerHost, instance.runnerPort)
        : null;
    // Grab workerId/runnerId up front — they survive stopModel's state transitions (it never
    // clears them), but reading them here rather than after keeps the "what do we need to reap
    // the process" and "did stopModel settle" concerns visually separate.
    const state = await deps.lifecycle.getInstance(modelName, instance.instanceId);
    await deps.sleepWake.stopModel(modelName, instance.instanceId, runnerClient);

    // #157: stopModel only updates state/routing/budget — it never terminates the runner
    // process. Reap it here so every teardown path (delete, stop, instance-delete, eviction)
    // actually frees the VRAM the process holds.
    if (state?.workerId && state.runnerId) {
      const worker = deps.workerPool.getWorker(state.workerId);
      if (worker) {
        try {
          await deps.createWorkerClient(worker.managementUrl).stopRunner(state.runnerId);
        } catch (stopErr: unknown) {
          // The worker no longer tracks this runner (already exited and reaped) — not a
          // failure, the process is already gone. Typed status check (round-3 review, Low 1):
          // a response body that happens to contain the substring "returned 404" must not be
          // misclassified as this tolerated case.
          if (stopErr instanceof WorkerHttpError && stopErr.status === 404) {
            app.log.debug(
              { modelName, instanceId: instance.instanceId, runnerId: state.runnerId },
              `${context}: runner already gone (404 from worker)`,
            );
          } else {
            throw stopErr;
          }
        }
      } else {
        app.log.warn(
          { modelName, instanceId: instance.instanceId, workerId: state.workerId },
          `${context}: cannot reap runner process; worker unknown`,
        );
        // Do not discard lifecycle/SQL bookkeeping when we cannot establish that the runner
        // stopped. Reconciliation can retry once the worker returns.
        throw new Error(`worker ${state.workerId} is unknown`);
      }
    } else {
      app.log.warn(
        { modelName, instanceId: instance.instanceId },
        `${context}: cannot reap runner process; no runnerId (nothing dispatched yet — see #140)`,
      );
    }

    await deps.lifecycle.removeInstance(modelName, instance.instanceId);
    await deps.instanceRepository.delete(instance.instanceId).catch(() => {});
    return true;
  } catch (err: unknown) {
    app.log.error(
      { err, modelName, instanceId: instance.instanceId },
      `${context}: instance teardown failed`,
    );
    return false;
  }
}

/**
 * Process-local in-flight claim sets, created once per `registerModelRoutes` and shared between
 * the route handlers and `deployFromRecord`. Hoisted into one object (rather than left as closures)
 * so the launch pipeline can consult `deletingInFlight` — the model-DELETE claim — and refuse to
 * mint (or, mid-reclamation, dispatch) an instance for a model whose teardown is already
 * backgrounding, closing the launch-vs-delete race from the launch side (#173).
 */
interface RouteClaims {
  readonly stoppingInFlight: Set<string>;
  readonly instanceOpInFlight: Set<string>;
  readonly deletingInFlight: Set<string>;
  readonly movingInFlight: Set<string>;
}

interface DeployFromRecordOptions {
  fixedPlacement?: { workerId: string; deviceIndices: number[] };
  /** A move needs this promise; ordinary deployments remain fire-and-forget. */
  awaitDeployment?: boolean;
  /** The move that owns the claim may launch its own replacement. */
  allowMoveClaim?: boolean;
}

/**
 * Runs the placement → reserve → transition → dispatch pipeline for a stored model record,
 * creating exactly one new instance identified by `instanceId`. Shared by `POST /api/v1/models`
 * (record just created, first instance), `POST /api/v1/models/:modelName/instances` (record
 * already has ≥0 other instances, this is an additional replica), and
 * `POST /api/v1/models/:modelName/start` (record already existed, zero instances). Owns only the
 * Redis instance state it creates — on synchronous failure it removes that Redis key, but never
 * touches the Postgres `models` row or other instances; the caller decides what happens to those.
 */
async function deployFromRecord(
  app: FastifyInstance,
  deps: RouteDeps,
  claims: RouteClaims,
  record: ModelRecord,
  instanceId: string,
  options: DeployFromRecordOptions = {},
): Promise<{
  instanceId: string;
  state: ModelLifecycleState;
  message: string;
  deployment?: Promise<void>;
}> {
  // #173: a model DELETE claims `deletingInFlight` synchronously, then backgrounds the teardown
  // over a snapshot of the model's instances. A launch dispatched into that window (add-instance,
  // start, or a same-named deploy) mints an instance the snapshot never saw, so its runner
  // survives the delete's model-row removal — the orphaned-runner race #140 set out to close,
  // reached from the launch side. Refuse before any Redis/budget state is created. This is the
  // top-of-pipeline guard shared by all three callers; the reclamation branch below re-checks
  // right before its (post-await) dispatch.
  if (claims.deletingInFlight.has(record.name)) {
    throw ControlPlaneError.operationInProgress(
      record.name,
      'start a new instance for',
      'delete-in-progress',
      'a delete is already in progress',
    );
  }
  if (claims.movingInFlight.has(record.name) && !options.allowMoveClaim) {
    throw ControlPlaneError.operationInProgress(
      record.name,
      'start a new instance for',
      'move-in-progress',
      'a move is already in progress',
    );
  }

  // Re-checked here (not just at deploy time) so a stored modelPath that predates a narrowed
  // weightsDir, or that reached the table by any path other than the validated deploy route,
  // is still rejected before a runner is launched from it. Deploy's own pre-create check
  // (below, in the POST /api/v1/models handler) becomes a redundant first check for that path;
  // this is the single source of truth for both callers.
  if (!isContainedIn(record.modelPath, deps.config.weightsDir)) {
    throw ControlPlaneError.invalidRequest(
      `Model ${record.name} has a stored modelPath outside the weights directory`,
    );
  }

  if (record.requiredMemory === null || record.requiredMemory <= 0) {
    throw ControlPlaneError.invalidRequest(
      `Model ${record.name} has no stored requiredMemory; cannot start`,
    );
  }
  const requiredMemory = record.requiredMemory;
  const tensorParallel = record.tensorParallel;

  const runnerMeta = await deps.catalogService.resolveRunnerMetadata(record.runnerType);
  assertModelNameRoutableForProtocol(record.name, runnerMeta.protocol);

  let redisCreated = false;
  try {
    await deps.lifecycle.createInstance(record.name, instanceId, null, runnerMeta.protocol);
    redisCreated = true;

    // Refresh budgets before the first placement, mirroring the eviction-retry path below.
    // In-memory budgets age up to a full reconciliation interval between refreshAll() runs, and
    // place() skips stale budgets — without this, a deploy landing late in the reconciliation
    // window can spuriously skip a healthy worker (or trigger an unnecessary eviction).
    await deps.memoryBudget.refreshAll();
    const workers = deps.workerPool.getAllWorkers();
    const budgets = new Map(deps.memoryBudget.getAllBudgets().map((b) => [b.workerId, b]));

    const placementRequest = {
      modelName: record.name,
      runnerType: record.runnerType,
      requiredMemory,
      deviceType: record.deviceType ?? undefined,
      tensorParallel,
    };

    const result = options.fixedPlacement
      ? deps.placement.placeFixed(
          placementRequest,
          options.fixedPlacement.workerId,
          options.fixedPlacement.deviceIndices,
          workers,
          budgets,
        )
      : deps.placement.place(placementRequest, workers, budgets);

    if (result) {
      for (const device of result.devices) {
        deps.memoryBudget.reserveCapacity(
          result.workerId,
          device.deviceIndex,
          instanceId,
          requiredMemory / tensorParallel,
        );
      }

      await deps.lifecycle.transition(record.name, instanceId, ModelLifecycleState.STARTING, {
        workerId: result.workerId,
        deviceIndices: result.devices.map((d) => d.deviceIndex),
      });

      await deps.instanceRepository.create({
        instanceId,
        modelName: record.name,
        workerId: result.workerId,
        deviceIndices: result.devices.map((d) => d.deviceIndex),
      });

      // #173: the top-of-pipeline guard ran several awaits ago (catalog lookup, budget refresh,
      // transition, row insert) — a model DELETE landing in that window snapshots without this
      // instance and claims `deletingInFlight`. Re-check right before the fire-and-forget dispatch,
      // mirroring the reclamation branch below. Throwing routes through the outer catch, which
      // removes the Redis key and releases the reservation; the Postgres row is dropped here so
      // nothing outlives the 409 (the delete's CASCADE would catch it anyway).
      if (claims.deletingInFlight.has(record.name)) {
        await deps.instanceRepository.delete(instanceId).catch(() => {});
        throw ControlPlaneError.operationInProgress(
          record.name,
          'start a new instance for',
          'delete-in-progress',
          'a delete is already in progress',
        );
      }

      const deployment = deps.deployOrchestration.deployModel({
        modelName: record.name,
        instanceId,
        workerId: result.workerId,
        runnerType: record.runnerType,
        modelPath: record.modelPath,
        requiredMemory,
        deviceType: record.deviceType ?? undefined,
        tensorParallel,
        engineConfig: record.engineConfig ?? undefined,
        engineArgs: record.engineArgs ?? undefined,
        runtimeModule: record.runtimeModule ?? undefined,
        servedModelName: record.servedModelName ?? undefined,
        protocol: runnerMeta.protocol,
        entrypoint: runnerMeta.entrypoint,
        devices: result.devices,
      });
      if (!options.awaitDeployment) {
        void deployment.catch((err: unknown) => {
          app.log.error(
            { err, modelName: record.name, instanceId },
            'Background deploy orchestration failed',
          );
        });
      }

      return {
        instanceId,
        state: ModelLifecycleState.STARTING,
        message: `Placed on worker ${result.workerId}`,
        deployment: options.awaitDeployment ? deployment : undefined,
      };
    }

    if (options.fixedPlacement) {
      throw ControlPlaneError.placementFailed(
        record.name,
        'fixed-target-insufficient-capacity-or-incompatible',
      );
    }

    const eligibleWorkerIds = deps.placement.eligibleWorkerIds(placementRequest, workers);
    if (eligibleWorkerIds.size === 0) {
      throw ControlPlaneError.placementFailed(record.name, 'No worker with sufficient capacity');
    }

    const allInstances = await deps.lifecycle.getAllInstances();
    const inferenceTs = await deps.lifecycle.getLastInferenceTimestamps(
      allInstances.map((s) => s.modelName),
    );
    for (const s of allInstances) {
      s.lastInferenceAt = inferenceTs.get(s.modelName) ?? s.lastInferenceAt;
    }
    const allRecords = await deps.modelRepository.findAll();
    const pinnedModels = new Set(allRecords.filter((r) => r.pinned).map((r) => r.name));
    const memoryByModel = new Map(
      allRecords.filter((r) => r.requiredMemory !== null).map((r) => [r.name, r.requiredMemory!]),
    );

    const victims = deps.eviction.selectVictims(
      allInstances,
      pinnedModels,
      requiredMemory,
      eligibleWorkerIds,
      memoryByModel,
    );

    if (victims.length === 0) {
      throw ControlPlaneError.placementFailed(record.name, 'No worker with sufficient capacity');
    }

    void (async () => {
      try {
        const stopTimer = deps.eviction.startTimer();
        // Registry semantics: DB row for the *model* is kept; only the evicted instance's Redis
        // state and Postgres row are cleared (see #121, extended to instances by #120). Isolated
        // per victim (Promise.allSettled over teardownInstance, which never throws) so one
        // victim's teardown failure can't strand the others still holding VRAM the budget no
        // longer thinks is theirs to give — the capacity check below simply won't reclaim
        // whatever a failed teardown left behind.
        const results = await Promise.allSettled(
          victims.map(async (victim) => {
            const victimState = await deps.lifecycle.getInstance(
              victim.modelName,
              victim.instanceId,
            );
            const ok = await teardownInstance(
              app,
              deps,
              victim.modelName,
              {
                instanceId: victim.instanceId,
                runnerHost: victimState?.runnerHost ?? null,
                runnerPort: victimState?.runnerPort ?? null,
              },
              'Eviction (capacity reclamation)',
            );
            if (ok) deps.eviction.recordEviction('capacity');
            return ok;
          }),
        );
        stopTimer();

        const victimFailures = results.filter(
          (r) => r.status === 'rejected' || r.value === false,
        ).length;
        if (victimFailures > 0) {
          app.log.error(
            { modelName: record.name, victimFailures, totalVictims: victims.length },
            'Some eviction victims failed teardown during capacity reclamation',
          );
        }

        await deps.memoryBudget.refreshAll();
        const refreshedBudgets = new Map(
          deps.memoryBudget.getAllBudgets().map((b) => [b.workerId, b]),
        );
        const reclaimed = deps.placement.place(placementRequest, workers, refreshedBudgets);

        if (!reclaimed) {
          throw ControlPlaneError.placementFailed(
            record.name,
            'No worker with sufficient capacity after capacity reclamation',
          );
        }

        for (const device of reclaimed.devices) {
          deps.memoryBudget.reserveCapacity(
            reclaimed.workerId,
            device.deviceIndex,
            instanceId,
            requiredMemory / tensorParallel,
          );
        }

        await deps.lifecycle.transition(record.name, instanceId, ModelLifecycleState.STARTING, {
          workerId: reclaimed.workerId,
          deviceIndices: reclaimed.devices.map((d) => d.deviceIndex),
        });

        await deps.instanceRepository.create({
          instanceId,
          modelName: record.name,
          workerId: reclaimed.workerId,
          deviceIndices: reclaimed.devices.map((d) => d.deviceIndex),
        });

        // #173: eviction + re-placement above spans several awaits, so a model DELETE may have
        // claimed `deletingInFlight` since the top-of-pipeline guard passed. Re-check right before
        // the fire-and-forget dispatch — the last point we can still avoid launching a runner the
        // in-flight delete's snapshot never saw. If claimed, release the reservation we just made
        // and settle the instance to ERROR (mirroring this block's own catch below, rather than
        // removing the Redis key: the delete's teardown + reconciliation reap the remnant, and a
        // remaining ERROR row is the same terminal, deletable state that catch produces). Skip the
        // dispatch.
        if (claims.deletingInFlight.has(record.name)) {
          deps.memoryBudget.releaseInstanceReservations(instanceId);
          await deps.lifecycle.transition(record.name, instanceId, ModelLifecycleState.ERROR, {
            errorMessage: 'Deployment aborted: model delete in progress',
          });
          await refreshModelRoutingState(deps.lifecycle, deps.routingMap, record.name);
          app.log.warn(
            { modelName: record.name, instanceId },
            'Capacity reclamation aborted: model delete claimed mid-flight',
          );
          return;
        }

        deps.deployOrchestration
          .deployModel({
            modelName: record.name,
            instanceId,
            workerId: reclaimed.workerId,
            runnerType: record.runnerType,
            modelPath: record.modelPath,
            requiredMemory,
            deviceType: record.deviceType ?? undefined,
            tensorParallel,
            engineConfig: record.engineConfig ?? undefined,
            engineArgs: record.engineArgs ?? undefined,
            runtimeModule: record.runtimeModule ?? undefined,
            servedModelName: record.servedModelName ?? undefined,
            protocol: runnerMeta.protocol,
            entrypoint: runnerMeta.entrypoint,
            devices: reclaimed.devices,
          })
          .catch((err: unknown) => {
            app.log.error(
              { err, modelName: record.name, instanceId },
              'Background deploy orchestration failed',
            );
          });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        app.log.error(
          { err, modelName: record.name, instanceId },
          'Background capacity reclamation failed',
        );

        try {
          await deps.lifecycle.transition(record.name, instanceId, ModelLifecycleState.ERROR, {
            errorMessage: message,
          });
          await refreshModelRoutingState(deps.lifecycle, deps.routingMap, record.name);
        } catch {
          // Intentionally swallowed — do not mask the original error.
        }

        deps.notifications
          .createNotification({
            title: 'Model deployment failed',
            description: `${record.name}: ${message}`,
            variant: 'danger',
            source: { type: 'model', name: record.name },
          })
          .catch((notifyErr: unknown) => {
            app.log.debug(
              { err: notifyErr, modelName: record.name },
              'Failed to create failure notification',
            );
          });
      }
    })();

    return {
      instanceId,
      state: ModelLifecycleState.PENDING,
      message: 'Capacity reclamation in progress',
    };
  } catch (err) {
    if (redisCreated) {
      await deps.lifecycle.removeInstance(record.name, instanceId).catch(() => {});
    }
    // The direct-place branch above reserves capacity before the transition/instanceRepository
    // writes that can still throw synchronously here; release is idempotent and a no-op if this
    // instanceId never reserved anything (e.g. failure happened before placement even ran), so
    // it's safe to call unconditionally rather than tracking whether reserveCapacity ran.
    deps.memoryBudget.releaseInstanceReservations(instanceId);
    throw err;
  }
}

/** Build the InstanceDetail wire shape from an in-memory InstanceState plus its Postgres row. */
function toInstanceDetail(
  instance: InstanceState,
  createdAt: string | undefined,
  measuredByInstance: Map<string, number>,
): Record<string, unknown> {
  return {
    instanceId: instance.instanceId,
    state: instance.state,
    workerId: instance.workerId ?? undefined,
    deviceIndices: instance.deviceIndices ?? undefined,
    runnerEndpoint:
      instance.runnerHost && instance.runnerPort
        ? { host: instance.runnerHost, port: instance.runnerPort }
        : undefined,
    // Measured (NVML), not the configured requiredMemory — see ModelInfo.currentMemory. Absent
    // when this instance has no measurement.
    currentMemory: measuredByInstance.get(instance.instanceId) ?? undefined,
    stateChangedAt: instance.stateChangedAt ?? undefined,
    errorMessage: instance.errorMessage ?? undefined,
    createdAt: createdAt ?? instance.stateChangedAt,
  };
}

export function registerModelRoutes(app: FastifyInstance, deps: RouteDeps): void {
  // Model names with a Stop synchronously claimed but not yet backgrounded-complete. Closes the
  // double-Stop race: two concurrent Stop calls can both read the same settled state before
  // either mutates anything, since Stop's teardown is fully backgrounded and none of ACTIVE/
  // SLEEPING/ERROR has a uniform valid edge straight to STOPPING in VALID_TRANSITIONS (only
  // SLEEPING and DRAINING do — see model-lifecycle.ts), so a synchronous state transition can't
  // serve as the claim for all three. This in-process set does instead; it never touches
  // VALID_TRANSITIONS. Keyed on modelName (not instanceId) — a model-level Stop claims the whole
  // model, since it acts on every instance at once. Only the leader instance runs mutating
  // routes, so per-process state is sufficient — no cross-instance coordination needed.
  const stoppingInFlight = new Set<string>();

  // Same race, instance-scoped: two concurrent DELETE/sleep/wake calls on one instance can both
  // read the same settled state before either mutates anything. Keyed on `${modelName}:
  // ${instanceId}` (not just instanceId) purely for readability in logs/errors — instanceId alone
  // is already globally unique. Shared across all three instance-scoped ops rather than one Set
  // per op: an instance can only be meaningfully doing one of delete/sleep/wake at a time, so
  // claiming across all three is the more conservative (and simpler) guard.
  const instanceOpInFlight = new Set<string>();

  // Model-delete analogue of stoppingInFlight (#140): closes the double-DELETE window — two
  // concurrent Deletes can both read the same settled state before either mutates anything,
  // since teardown is fully backgrounded. Keyed on modelName and held until the background
  // teardown completes. Deliberately a separate set from stoppingInFlight: Stop and Delete
  // are orthogonal operations that need only each exclude themselves.
  const deletingInFlight = new Set<string>();

  // A move owns the model from replacement reservation until the old runner has been reaped.
  // The leader-only mutation model makes this process-local claim sufficient.
  const movingInFlight = new Set<string>();

  // Bundle the three sets so the shared `deployFromRecord` pipeline can see `deletingInFlight`
  // (#173). The bare names above are still used directly by the route handlers in this closure.
  const claims: RouteClaims = {
    stoppingInFlight,
    instanceOpInFlight,
    deletingInFlight,
    movingInFlight,
  };
  const assertNoMove = (modelName: string, action: string): void => {
    if (movingInFlight.has(modelName)) {
      throw ControlPlaneError.operationInProgress(
        modelName,
        action,
        'move-in-progress',
        'a move is already in progress',
      );
    }
  };

  app.post<{ Body: DeployBody }>('/api/v1/models', async (request, reply) => {
    if (!deps.leaderElection.isLeader) {
      throw ControlPlaneError.notLeader();
    }

    const body = request.body;
    if (
      !body?.modelName ||
      typeof body.modelName !== 'string' ||
      !body.runnerType ||
      typeof body.runnerType !== 'string' ||
      !body.modelPath ||
      typeof body.modelPath !== 'string' ||
      typeof body.requiredMemory !== 'number' ||
      body.requiredMemory <= 0
    ) {
      throw ControlPlaneError.invalidRequest(
        'modelName (string), runnerType (string), modelPath (string), and requiredMemory (positive number) are required',
      );
    }

    assertValidModelName(body.modelName);

    if (!isContainedIn(body.modelPath, deps.config.weightsDir)) {
      throw ControlPlaneError.invalidRequest(
        'modelPath must be an absolute path inside the weights directory',
      );
    }

    if (
      body.tensorParallel !== undefined &&
      (typeof body.tensorParallel !== 'number' || body.tensorParallel < 1)
    ) {
      throw ControlPlaneError.invalidRequest('tensorParallel must be a positive integer');
    }

    if (
      body.runtimeModule !== undefined &&
      (typeof body.runtimeModule !== 'string' || !RUNTIME_MODULE_PATTERN.test(body.runtimeModule))
    ) {
      throw ControlPlaneError.invalidRequest(
        'runtimeModule must match ^[A-Za-z0-9_.-]+$ (e.g. "vllm-0.21")',
      );
    }

    if (body.engineArgs !== undefined) {
      if (!Array.isArray(body.engineArgs) || body.engineArgs.some((a) => typeof a !== 'string')) {
        throw ControlPlaneError.invalidRequest('engineArgs must be an array of strings');
      }
      // Sanity caps, not a real security boundary (the launcher's RESERVED_ENGINE_FLAGS check is)
      // — just cheap defense-in-depth against a pathological payload reaching the worker (#126
      // review).
      if (body.engineArgs.length > MAX_ENGINE_ARGS_COUNT) {
        throw ControlPlaneError.invalidRequest(
          `engineArgs must contain at most ${MAX_ENGINE_ARGS_COUNT} elements`,
        );
      }
      if (body.engineArgs.some((a) => a.length > MAX_ENGINE_ARG_LENGTH)) {
        throw ControlPlaneError.invalidRequest(
          `each engineArgs element must be at most ${MAX_ENGINE_ARG_LENGTH} characters`,
        );
      }
    }

    if (
      body.servedModelName !== undefined &&
      (typeof body.servedModelName !== 'string' || !MODEL_NAME_PATTERN.test(body.servedModelName))
    ) {
      throw ControlPlaneError.invalidRequest('servedModelName must match ^[A-Za-z0-9._/-]{1,200}$');
    }

    let trimmedDisplayName: string | undefined;
    if (body.displayName !== undefined) {
      if (typeof body.displayName !== 'string') {
        throw ControlPlaneError.invalidRequest('displayName must be a string');
      }
      trimmedDisplayName = body.displayName.trim();
      if (trimmedDisplayName.length === 0 || trimmedDisplayName.length > 200) {
        throw ControlPlaneError.invalidRequest(
          'displayName must be 1–200 characters when provided',
        );
      }
    }

    let record: ModelRecord;
    try {
      record = await deps.modelRepository.create({
        name: body.modelName,
        runnerType: body.runnerType,
        modelPath: body.modelPath,
        requiredMemory: body.requiredMemory,
        deviceType: body.deviceType,
        tensorParallel: body.tensorParallel,
        engineConfig: body.engineConfig,
        engineArgs: body.engineArgs,
        runtimeModule: body.runtimeModule,
        servedModelName: body.servedModelName,
        displayName: trimmedDisplayName,
        pinned: body.pinned,
      });
    } catch (err) {
      if (err instanceof Error && err.message.includes('unique')) {
        throw ControlPlaneError.modelAlreadyExists(body.modelName);
      }
      throw err;
    }

    const instanceId = mintInstanceId();
    try {
      const { state, message } = await deployFromRecord(app, deps, claims, record, instanceId);
      return reply.code(202).send({ modelName: record.name, instanceId, state, message });
    } catch (err) {
      // Placement failed synchronously — roll back the DB row so the name is free to retry.
      await deps.modelRepository.delete(record.name).catch(() => {});
      throw err;
    }
  });

  app.post<{ Params: { modelName: string } }>(
    '/api/v1/models/:modelName/instances',
    async (request, reply) => {
      if (!deps.leaderElection.isLeader) {
        throw ControlPlaneError.notLeader();
      }

      const { modelName } = request.params;
      assertValidModelName(modelName);

      const record = await deps.modelRepository.findByName(modelName);
      if (!record) {
        throw ControlPlaneError.modelNotFound(modelName);
      }

      const instanceId = mintInstanceId();
      const { state, message } = await deployFromRecord(app, deps, claims, record, instanceId);

      return reply.code(202).send({ modelName, instanceId, state, message });
    },
  );

  app.post<{
    Params: { modelName: string; instanceId: string };
    Body: MoveBody;
  }>('/api/v1/models/:modelName/instances/:instanceId/move', async (request, reply) => {
    if (!deps.leaderElection.isLeader) throw ControlPlaneError.notLeader();

    const { modelName, instanceId } = request.params;
    const body = request.body;
    assertValidModelName(modelName);
    if (
      !body ||
      typeof body.targetWorkerId !== 'string' ||
      body.targetWorkerId.length === 0 ||
      !Array.isArray(body.targetDeviceIndices) ||
      body.targetDeviceIndices.length === 0 ||
      body.targetDeviceIndices.some((index) => !Number.isInteger(index) || index < 0) ||
      new Set(body.targetDeviceIndices).size !== body.targetDeviceIndices.length
    ) {
      throw new ControlPlaneError(
        400,
        'INVALID_REQUEST',
        'A target worker and unique non-negative device indices are required',
        { reason: 'invalid-move-target' },
      );
    }

    const [record, source] = await Promise.all([
      deps.modelRepository.findByName(modelName),
      deps.lifecycle.getInstance(modelName, instanceId),
    ]);
    if (!record || !source) {
      throw new ControlPlaneError(
        404,
        'MODEL_NOT_FOUND',
        `Model instance not found: ${modelName}/${instanceId}`,
        {
          modelName,
          instanceId,
          reason: 'instance-not-found',
        },
      );
    }
    if (movingInFlight.has(modelName)) {
      throw ControlPlaneError.operationInProgress(
        modelName,
        'move',
        'move-in-progress',
        'a move is already in progress',
      );
    }
    if (
      deletingInFlight.has(modelName) ||
      stoppingInFlight.has(modelName) ||
      instanceOpInFlight.has(`${modelName}:${instanceId}`)
    ) {
      throw ControlPlaneError.operationInProgress(
        modelName,
        'move',
        'operation-in-progress',
        'another lifecycle operation is already in progress',
      );
    }
    if (source.state !== ModelLifecycleState.ACTIVE) {
      throw ControlPlaneError.invalidState(`${modelName}/${instanceId}`, source.state, 'move');
    }
    if (!source.workerId || !source.runnerHost || !source.runnerPort) {
      throw new ControlPlaneError(
        500,
        'INTERNAL_ERROR',
        `Active instance ${instanceId} of ${modelName} has no runner endpoint`,
      );
    }
    if (body.targetDeviceIndices.length !== record.tensorParallel) {
      throw new ControlPlaneError(
        400,
        'INVALID_REQUEST',
        'Target device count must equal tensor parallelism',
        { reason: 'tensor-parallel-mismatch' },
      );
    }
    const targetWorker = deps.workerPool.getWorker(body.targetWorkerId);
    if (!targetWorker) throw ControlPlaneError.workerNotFound(body.targetWorkerId);
    if (
      body.targetDeviceIndices.some(
        (index) => !targetWorker.devices.some((device) => device.deviceIndex === index),
      )
    ) {
      throw new ControlPlaneError(
        400,
        'INVALID_REQUEST',
        'Target device does not exist on target worker',
        {
          reason: 'target-device-not-found',
          targetWorkerId: body.targetWorkerId,
        },
      );
    }
    if (
      source.workerId === body.targetWorkerId &&
      source.deviceIndices?.length === body.targetDeviceIndices.length &&
      source.deviceIndices.every((index) => body.targetDeviceIndices.includes(index))
    ) {
      throw new ControlPlaneError(
        400,
        'INVALID_REQUEST',
        'Target placement is identical to source placement',
        { reason: 'identical-source-placement' },
      );
    }

    movingInFlight.add(modelName);
    const replacementInstanceId = mintInstanceId();
    try {
      const launch = await deployFromRecord(app, deps, claims, record, replacementInstanceId, {
        fixedPlacement: { workerId: body.targetWorkerId, deviceIndices: body.targetDeviceIndices },
        awaitDeployment: true,
        allowMoveClaim: true,
      });
      // Redis lifecycle state, SQL row, and capacity holds now exist: safe to acknowledge.
      void (async () => {
        let cutoverComplete = false;
        try {
          await launch.deployment;
          const currentSource = await deps.lifecycle.getInstance(modelName, instanceId);
          if (
            currentSource?.state !== ModelLifecycleState.ACTIVE ||
            !currentSource.runnerHost ||
            !currentSource.runnerPort
          ) {
            throw new Error('source instance changed before traffic cutover');
          }
          const endpointPort = currentSource.runnerEnginePort ?? currentSource.runnerPort;
          const cutOver = await deps.routingMap.updateEndpointWeight(
            modelName,
            currentSource.runnerHost,
            endpointPort,
            0,
          );
          if (!cutOver) throw new Error('source routing endpoint was not found before cutover');
          cutoverComplete = true;

          const stopped = await teardownInstance(
            app,
            deps,
            modelName,
            currentSource,
            'Move source teardown',
          );
          if (!stopped) {
            await deps.notifications.createNotification({
              title: 'Model move completed with source teardown failure',
              description: `${modelName} (${instanceId}) no longer receives traffic but could not be stopped`,
              variant: 'danger',
              source: { type: 'model', name: modelName },
            });
            return;
          }
          await deps.notifications.createNotification({
            title: 'Model moved',
            description: `${modelName} moved to ${body.targetWorkerId}`,
            variant: 'success',
            source: { type: 'model', name: modelName },
          });
        } catch (err) {
          app.log.error(
            { err, modelName, instanceId, replacementInstanceId, cutoverComplete },
            'Model move orchestration failed',
          );
          // Before the atomic Redis cutover the source must remain untouched. The replacement is
          // safe to reap; retained bookkeeping on a failed reap makes the failure observable.
          if (!cutoverComplete) {
            const replacement = await deps.lifecycle.getInstance(modelName, replacementInstanceId);
            if (replacement)
              await teardownInstance(app, deps, modelName, replacement, 'Move replacement cleanup');
          }
          await deps.notifications.createNotification({
            title: 'Model move failed',
            description: `${modelName}: ${err instanceof Error ? err.message : String(err)}`,
            variant: 'danger',
            source: { type: 'model', name: modelName },
          });
        } finally {
          movingInFlight.delete(modelName);
        }
      })();
      return reply
        .code(202)
        .send({ modelName, sourceInstanceId: instanceId, replacementInstanceId });
    } catch (err) {
      movingInFlight.delete(modelName);
      throw err;
    }
  });

  app.get<{ Querystring: { state?: string } }>('/api/v1/models', async (request, reply) => {
    const stateFilter = request.query.state as ModelLifecycleState | undefined;

    if (stateFilter && !Object.values(ModelLifecycleState).includes(stateFilter)) {
      throw ControlPlaneError.invalidRequest(`Invalid state filter: ${stateFilter}`);
    }

    const [allInstances, allRecords] = await Promise.all([
      deps.lifecycle.getAllInstances(),
      deps.modelRepository.findAll(),
    ]);

    const instancesByModel = new Map<string, InstanceState[]>();
    for (const instance of allInstances) {
      const existing = instancesByModel.get(instance.modelName);
      if (existing) existing.push(instance);
      else instancesByModel.set(instance.modelName, [instance]);
    }
    const recordMap = new Map(allRecords.map((r) => [r.name, r]));

    const modelNames = new Set([...instancesByModel.keys(), ...allRecords.map((r) => r.name)]);
    const inferenceTs = await deps.lifecycle.getLastInferenceTimestamps([...modelNames]);
    const measuredByInstance = deps.memoryBudget.getMeasuredByInstance();

    const models = [];

    for (const name of modelNames) {
      const instances = instancesByModel.get(name) ?? [];
      const record = recordMap.get(name);

      const currentState = deriveAggregateState(instances);
      if (stateFilter && currentState !== stateFilter) continue;

      // Measured (NVML), summed across the model's instances. Absent when none of them have a
      // measurement (model not running, or the worker(s) can't measure) — see ModelInfo.currentMemory.
      let currentMemory: number | undefined;
      for (const instance of instances) {
        const measured = measuredByInstance.get(instance.instanceId);
        if (measured !== undefined) {
          currentMemory = (currentMemory ?? 0) + measured;
        }
      }

      models.push({
        modelName: name,
        displayName: record?.displayName ?? undefined,
        state: currentState,
        runnerType: record?.runnerType ?? 'unknown',
        instanceCount: instances.length,
        // Unambiguous only with exactly one instance — with N instances, the per-instance
        // breakdown lives at GET /api/v1/models/{modelName}.
        workerId: instances.length === 1 ? (instances[0].workerId ?? undefined) : undefined,
        requiredMemory: record?.requiredMemory ?? undefined,
        currentMemory,
        lastInferenceAt: inferenceTs.get(name) ?? undefined,
        pinned: record?.pinned ?? false,
        createdAt: record?.createdAt?.toISOString() ?? instances[0]?.stateChangedAt ?? undefined,
      });
    }

    return reply.code(200).send({ models });
  });

  app.get<{ Params: { modelName: string } }>(
    '/api/v1/models/:modelName',
    async (request, reply) => {
      const { modelName } = request.params;
      assertValidModelName(modelName);

      const [instances, record, instanceRows] = await Promise.all([
        deps.lifecycle.getInstancesForModel(modelName),
        deps.modelRepository.findByName(modelName),
        deps.instanceRepository.findByModel(modelName),
      ]);

      if (instances.length === 0 && !record) {
        throw ControlPlaneError.modelNotFound(modelName);
      }

      const createdAtByInstance = new Map(
        instanceRows.map((row) => [row.instanceId, row.createdAt.toISOString()]),
      );
      const inferenceTs = await deps.lifecycle.getLastInferenceTimestamps([modelName]);
      const measuredByInstance = deps.memoryBudget.getMeasuredByInstance();

      const detail = {
        modelName,
        displayName: record?.displayName ?? undefined,
        state: deriveAggregateState(instances),
        runnerType: record?.runnerType ?? 'unknown',
        modelPath: record?.modelPath ?? '',
        requiredMemory: record?.requiredMemory ?? 0,
        deviceType: record?.deviceType ?? undefined,
        tensorParallel: record?.tensorParallel ?? 1,
        engineConfig: record?.engineConfig ?? undefined,
        engineArgs: record?.engineArgs ?? undefined,
        runtimeModule: record?.runtimeModule ?? undefined,
        servedModelName: record?.servedModelName ?? undefined,
        pinned: record?.pinned ?? false,
        instances: instances.map((instance) =>
          toInstanceDetail(
            instance,
            createdAtByInstance.get(instance.instanceId),
            measuredByInstance,
          ),
        ),
        lastInferenceAt: inferenceTs.get(modelName) ?? undefined,
        createdAt: record?.createdAt?.toISOString() ?? instances[0]?.stateChangedAt ?? '',
        updatedAt: record?.updatedAt?.toISOString() ?? instances[0]?.stateChangedAt ?? '',
      };

      return reply.code(200).send(detail);
    },
  );

  app.delete<{ Params: { modelName: string } }>(
    '/api/v1/models/:modelName',
    async (request, reply) => {
      if (!deps.leaderElection.isLeader) {
        throw ControlPlaneError.notLeader();
      }

      const { modelName } = request.params;
      assertValidModelName(modelName);
      assertNoMove(modelName, 'delete');

      const [instances, record] = await Promise.all([
        deps.lifecycle.getInstancesForModel(modelName),
        deps.modelRepository.findByName(modelName),
      ]);

      if (instances.length === 0 && !record) {
        throw ControlPlaneError.modelNotFound(modelName);
      }

      if (instances.length === 0 && record) {
        await deps.modelRepository.delete(modelName);
        return reply.code(202).send({
          modelName,
          state: ModelLifecycleState.STOPPED,
          previousState: ModelLifecycleState.STOPPED,
          message: 'Model record removed',
        });
      }

      const aggregateState = deriveAggregateState(instances);

      // #174: report the specific transient instance (state + id), not the aggregate. For a
      // mixed-state model (e.g. ACTIVE + STARTING) the aggregate can be a settled value, which
      // would misleadingly claim the model is deletable and give the operator nothing to act on.
      const transientInstance = instances.find((i) => TRANSIENT_FOR_DELETE.has(i.state));
      if (transientInstance) {
        throw ControlPlaneError.invalidInstanceState(
          modelName,
          transientInstance.instanceId,
          transientInstance.state,
          'delete',
        );
      }

      // #174: distinct message + `details.reason` from the transient-state case above, so a client
      // can tell "a delete is already running, do nothing" from "wait for a launch to settle".
      if (deletingInFlight.has(modelName)) {
        throw ControlPlaneError.operationInProgress(
          modelName,
          'delete',
          'delete-in-progress',
          'a delete is already in progress',
        );
      }

      // #173: a Stop or an instance-scoped op (delete/sleep/wake) can be claimed but not yet past
      // its first state transition, so its instances still read as settled and slip past the
      // transient guard above. Both that op and this delete would then run teardown on the same
      // instance while the model row and routing map are removed underneath the in-flight op.
      // Refuse until it settles.
      if (stoppingInFlight.has(modelName)) {
        throw ControlPlaneError.operationInProgress(
          modelName,
          'delete',
          'stop-in-progress',
          'a stop is already in progress',
        );
      }
      const busyInstance = instances.find((i) =>
        instanceOpInFlight.has(`${modelName}:${i.instanceId}`),
      );
      if (busyInstance) {
        throw ControlPlaneError.operationInProgress(
          modelName,
          'delete',
          'instance-operation-in-progress',
          `an operation is already in progress on instance ${busyInstance.instanceId}`,
        );
      }

      deletingInFlight.add(modelName);

      deps.notifications
        .createNotification({
          title: 'Model deleted',
          description: `${modelName} removal initiated (${instances.length} instance(s))`,
          variant: 'info',
          source: { type: 'model', name: modelName },
        })
        .catch((err: unknown) => {
          app.log.debug({ err, modelName }, 'Failed to create delete notification');
        });

      void (async () => {
        try {
          // Isolated per instance (Promise.allSettled over teardownInstance, which never
          // throws) — one instance's teardown failure must not strand the others, and the
          // model row / routing map cleanup below must still run so the record doesn't
          // survive a partial delete.
          const results = await Promise.allSettled(
            instances.map((instance) => teardownInstance(app, deps, modelName, instance, 'Delete')),
          );
          const failures = results.filter(
            (r) => r.status === 'rejected' || r.value === false,
          ).length;
          if (failures > 0) {
            app.log.error(
              { modelName, failures, total: instances.length },
              'Some instances failed teardown during model delete',
            );
          }

          try {
            // CASCADE on the FK cleans up any instance rows this loop didn't reach (e.g. one
            // created concurrently after the snapshot above, or one whose teardown failed
            // above).
            await deps.modelRepository.delete(modelName);
            await deps.routingMap.removeModel(modelName);
            app.log.info({ modelName }, 'Model removed');
          } catch (err: unknown) {
            app.log.error({ err, modelName }, 'Background model deletion failed');
          }
        } finally {
          deletingInFlight.delete(modelName);
        }
      })();

      return reply.code(202).send({
        modelName,
        state: ModelLifecycleState.STOPPING,
        previousState: aggregateState,
        message: 'Model removal initiated',
      });
    },
  );

  app.post<{ Params: { modelName: string } }>(
    '/api/v1/models/:modelName/sleep',
    async (request, reply) => {
      if (!deps.leaderElection.isLeader) {
        throw ControlPlaneError.notLeader();
      }

      const { modelName } = request.params;
      assertValidModelName(modelName);
      assertNoMove(modelName, 'sleep');

      const instances = await deps.lifecycle.getInstancesForModel(modelName);
      if (instances.length === 0) {
        throw ControlPlaneError.modelNotFound(modelName);
      }

      const active = instances.filter((i) => i.state === ModelLifecycleState.ACTIVE);
      if (active.length === 0) {
        throw ControlPlaneError.invalidState(modelName, deriveAggregateState(instances), 'sleep');
      }

      for (const instance of active) {
        if (!instance.runnerHost || !instance.runnerPort) {
          throw new ControlPlaneError(
            500,
            'INTERNAL_ERROR',
            `Instance ${instance.instanceId} of ${modelName} has no runner endpoint`,
          );
        }
      }

      // Atomically claim ACTIVE → DRAINING for every active instance before launching
      // background work.
      for (const instance of active) {
        await deps.lifecycle.transition(
          modelName,
          instance.instanceId,
          ModelLifecycleState.DRAINING,
        );
      }
      await refreshModelRoutingState(deps.lifecycle, deps.routingMap, modelName);

      deps.notifications
        .createNotification({
          title: 'Model sleep initiated',
          description: `${modelName} is draining (${active.length} instance(s))`,
          variant: 'info',
          source: { type: 'model', name: modelName },
        })
        .catch((err: unknown) => {
          app.log.debug({ err, modelName }, 'Failed to create sleep notification');
        });

      for (const instance of active) {
        const runnerClient = deps.createRunnerClient(instance.runnerHost!, instance.runnerPort!);
        deps.sleepWake
          .sleepModel(modelName, instance.instanceId, runnerClient)
          .catch((err: unknown) => {
            app.log.error(
              { err, modelName, instanceId: instance.instanceId },
              'Background sleep failed',
            );
          });
      }

      return reply.code(202).send({
        modelName,
        state: ModelLifecycleState.DRAINING,
        previousState: ModelLifecycleState.ACTIVE,
        message: `Sleep initiated for ${active.length} instance(s)`,
      });
    },
  );

  app.post<{ Params: { modelName: string } }>(
    '/api/v1/models/:modelName/wake',
    async (request, reply) => {
      if (!deps.leaderElection.isLeader) {
        throw ControlPlaneError.notLeader();
      }

      const { modelName } = request.params;
      assertValidModelName(modelName);
      assertNoMove(modelName, 'wake');

      const instances = await deps.lifecycle.getInstancesForModel(modelName);
      if (instances.length === 0) {
        throw ControlPlaneError.modelNotFound(modelName);
      }

      const alreadyStarting = instances.filter((i) => i.state === ModelLifecycleState.STARTING);
      const sleeping = instances.filter((i) => i.state === ModelLifecycleState.SLEEPING);

      if (sleeping.length === 0) {
        if (alreadyStarting.length > 0) {
          return reply.code(202).send({
            modelName,
            state: ModelLifecycleState.STARTING,
            previousState: ModelLifecycleState.STARTING,
            message: 'Model is already waking up',
          });
        }
        throw ControlPlaneError.invalidState(modelName, deriveAggregateState(instances), 'wake');
      }

      for (const instance of sleeping) {
        if (!instance.runnerHost || !instance.runnerPort) {
          throw new ControlPlaneError(
            500,
            'INTERNAL_ERROR',
            `Instance ${instance.instanceId} of ${modelName} has no runner endpoint`,
          );
        }
      }

      // Atomically claim SLEEPING → STARTING for every sleeping instance before launching
      // background work. Concurrent wake requests will fail this transition for instances
      // already claimed and simply skip them below.
      const claimed: InstanceState[] = [];
      for (const instance of sleeping) {
        try {
          await deps.lifecycle.transition(
            modelName,
            instance.instanceId,
            ModelLifecycleState.STARTING,
          );
          claimed.push(instance);
        } catch {
          // Lost the race on this instance — another concurrent wake claimed it first.
        }
      }
      await refreshModelRoutingState(deps.lifecycle, deps.routingMap, modelName);

      deps.notifications
        .createNotification({
          title: 'Model wake initiated',
          description: `${modelName} is waking up (${claimed.length} instance(s))`,
          variant: 'info',
          source: { type: 'model', name: modelName },
        })
        .catch((err: unknown) => {
          app.log.debug({ err, modelName }, 'Failed to create wake notification');
        });

      const record = await deps.modelRepository.findByName(modelName);
      const requiredMemory = record?.requiredMemory ?? 0;

      for (const instance of claimed) {
        if (requiredMemory > 0 && instance.workerId) {
          const workerBudget = deps.memoryBudget.getWorkerBudget(instance.workerId);
          const totalAvailable = workerBudget
            ? workerBudget.devices.reduce((sum, d) => sum + d.availableBytes, 0)
            : 0;

          if (totalAvailable < requiredMemory) {
            const allInstances = await deps.lifecycle.getAllInstances();
            const inferenceTs = await deps.lifecycle.getLastInferenceTimestamps(
              allInstances.map((s) => s.modelName),
            );
            for (const s of allInstances) {
              s.lastInferenceAt = inferenceTs.get(s.modelName) ?? s.lastInferenceAt;
            }
            const allRecords = await deps.modelRepository.findAll();
            const pinnedModels = new Set(allRecords.filter((r) => r.pinned).map((r) => r.name));
            pinnedModels.add(modelName);
            const memoryByModel = new Map(
              allRecords
                .filter((r) => r.requiredMemory !== null)
                .map((r) => [r.name, r.requiredMemory!]),
            );

            const victims = deps.eviction.selectVictims(
              allInstances,
              pinnedModels,
              requiredMemory,
              new Set([instance.workerId]),
              memoryByModel,
            );

            // Isolated per victim, same rationale as deployFromRecord's eviction loop: one
            // victim's teardown failure must not throw out of this synchronous handler and
            // strand the remaining `claimed` instances (whose wakeModel dispatch below would
            // then never run, leaving them stuck in STARTING until reconciliation times out).
            const victimResults = await Promise.allSettled(
              victims.map(async (victim) => {
                const vs = await deps.lifecycle.getInstance(victim.modelName, victim.instanceId);
                const ok = await teardownInstance(
                  app,
                  deps,
                  victim.modelName,
                  {
                    instanceId: victim.instanceId,
                    runnerHost: vs?.runnerHost ?? null,
                    runnerPort: vs?.runnerPort ?? null,
                  },
                  'Eviction (wake capacity reclamation)',
                );
                if (ok) deps.eviction.recordEviction('wake');
                return ok;
              }),
            );
            const victimFailures = victimResults.filter(
              (r) => r.status === 'rejected' || r.value === false,
            ).length;
            if (victimFailures > 0) {
              app.log.error(
                {
                  modelName,
                  instanceId: instance.instanceId,
                  victimFailures,
                  totalVictims: victims.length,
                },
                'Some eviction victims failed teardown during wake capacity reclamation',
              );
            }
          }
        }

        const runnerClient = deps.createRunnerClient(instance.runnerHost!, instance.runnerPort!);
        deps.sleepWake
          .wakeModel(modelName, instance.instanceId, runnerClient)
          .catch((err: unknown) => {
            app.log.error(
              { err, modelName, instanceId: instance.instanceId },
              'Background wake failed',
            );
          });
      }

      return reply.code(202).send({
        modelName,
        state: ModelLifecycleState.STARTING,
        previousState: ModelLifecycleState.SLEEPING,
        message: `Wake initiated for ${claimed.length} instance(s)`,
      });
    },
  );

  app.post<{ Params: { modelName: string } }>(
    '/api/v1/models/:modelName/stop',
    async (request, reply) => {
      if (!deps.leaderElection.isLeader) {
        throw ControlPlaneError.notLeader();
      }

      const { modelName } = request.params;
      assertValidModelName(modelName);
      assertNoMove(modelName, 'stop');

      const instances = await deps.lifecycle.getInstancesForModel(modelName);
      if (instances.length === 0) {
        // No runtime state = nothing to stop. Mirrors sleep/wake. A record with no
        // instances is already "stopped"; use start or delete on it instead.
        throw ControlPlaneError.modelNotFound(modelName);
      }

      const aggregateState = deriveAggregateState(instances);
      if (!instances.some((i) => STOPPABLE_STATES.has(i.state))) {
        throw ControlPlaneError.invalidState(modelName, aggregateState, 'stop');
      }

      if (stoppingInFlight.has(modelName)) {
        throw ControlPlaneError.invalidState(modelName, aggregateState, 'stop');
      }
      stoppingInFlight.add(modelName);

      const stoppable = instances.filter((i) => STOPPABLE_STATES.has(i.state));

      deps.notifications
        .createNotification({
          title: 'Model stop initiated',
          description: `${modelName} is stopping (${stoppable.length} instance(s))`,
          variant: 'info',
          source: { type: 'model', name: modelName },
        })
        .catch((err: unknown) => {
          app.log.debug({ err, modelName }, 'Failed to create stop notification');
        });

      void (async () => {
        try {
          // Isolated per instance (Promise.allSettled over teardownInstance, which never
          // throws) — one instance's teardown failure must not leave the rest running and
          // holding VRAM the budget no longer accounts for. Record deliberately retained — this
          // is Stop, not Delete (see #121).
          const results = await Promise.allSettled(
            stoppable.map((instance) => teardownInstance(app, deps, modelName, instance, 'Stop')),
          );
          const failures = results.filter(
            (r) => r.status === 'rejected' || r.value === false,
          ).length;
          if (failures > 0) {
            app.log.error(
              { modelName, failures, total: stoppable.length },
              'Some instances failed teardown during model stop',
            );
          } else {
            app.log.info({ modelName, count: stoppable.length }, 'Model instances stopped');
          }
        } finally {
          stoppingInFlight.delete(modelName);
        }
      })();

      return reply.code(202).send({
        modelName,
        state: ModelLifecycleState.STOPPING,
        previousState: aggregateState,
        message: `Stop initiated for ${stoppable.length} instance(s)`,
      });
    },
  );

  app.post<{ Params: { modelName: string } }>(
    '/api/v1/models/:modelName/start',
    async (request, reply) => {
      if (!deps.leaderElection.isLeader) {
        throw ControlPlaneError.notLeader();
      }

      const { modelName } = request.params;
      assertValidModelName(modelName);

      const [instances, record] = await Promise.all([
        deps.lifecycle.getInstancesForModel(modelName),
        deps.modelRepository.findByName(modelName),
      ]);

      if (!record) {
        throw ControlPlaneError.modelNotFound(modelName);
      }

      if (instances.length > 0) {
        // Instances exist — the model is running or transitioning, not stopped. Use
        // POST /api/v1/models/{modelName}/instances to add a replica instead.
        throw ControlPlaneError.invalidState(modelName, deriveAggregateState(instances), 'start');
      }

      const instanceId = mintInstanceId();
      const { state: newState, message } = await deployFromRecord(
        app,
        deps,
        claims,
        record,
        instanceId,
      );

      return reply.code(202).send({
        modelName,
        instanceId,
        state: newState,
        previousState: ModelLifecycleState.STOPPED,
        message,
      });
    },
  );

  app.delete<{ Params: { modelName: string; instanceId: string } }>(
    '/api/v1/models/:modelName/instances/:instanceId',
    async (request, reply) => {
      if (!deps.leaderElection.isLeader) {
        throw ControlPlaneError.notLeader();
      }

      const { modelName, instanceId } = request.params;
      assertValidModelName(modelName);
      assertNoMove(modelName, 'delete an instance for');

      const instance = await deps.lifecycle.getInstance(modelName, instanceId);
      if (!instance) {
        throw ControlPlaneError.modelNotFound(`${modelName}/${instanceId}`);
      }

      if (TRANSIENT_FOR_DELETE.has(instance.state)) {
        throw ControlPlaneError.invalidState(
          `${modelName}/${instanceId}`,
          instance.state,
          'delete',
        );
      }

      const claimKey = `${modelName}:${instanceId}`;
      if (instanceOpInFlight.has(claimKey)) {
        throw ControlPlaneError.invalidState(
          `${modelName}/${instanceId}`,
          instance.state,
          'delete',
        );
      }
      instanceOpInFlight.add(claimKey);

      const previousState = instance.state;

      deps.notifications
        .createNotification({
          title: 'Model instance removal initiated',
          description: `${modelName} (${instanceId})`,
          variant: 'info',
          source: { type: 'model', name: modelName },
        })
        .catch((err: unknown) => {
          app.log.debug({ err, modelName, instanceId }, 'Failed to create notification');
        });

      void (async () => {
        try {
          const ok = await teardownInstance(app, deps, modelName, instance, 'Instance delete');
          if (ok) {
            app.log.info({ modelName, instanceId }, 'Model instance removed');
          }
        } finally {
          instanceOpInFlight.delete(claimKey);
        }
      })();

      return reply.code(202).send({
        modelName,
        instanceId,
        state: ModelLifecycleState.STOPPING,
        previousState,
        message: 'Instance removal initiated',
      });
    },
  );

  app.post<{ Params: { modelName: string; instanceId: string } }>(
    '/api/v1/models/:modelName/instances/:instanceId/sleep',
    async (request, reply) => {
      if (!deps.leaderElection.isLeader) {
        throw ControlPlaneError.notLeader();
      }

      const { modelName, instanceId } = request.params;
      assertValidModelName(modelName);
      assertNoMove(modelName, 'sleep an instance for');

      const instance = await deps.lifecycle.getInstance(modelName, instanceId);
      if (!instance) {
        throw ControlPlaneError.modelNotFound(`${modelName}/${instanceId}`);
      }

      if (instance.state !== ModelLifecycleState.ACTIVE) {
        throw ControlPlaneError.invalidState(`${modelName}/${instanceId}`, instance.state, 'sleep');
      }

      if (!instance.runnerHost || !instance.runnerPort) {
        throw new ControlPlaneError(
          500,
          'INTERNAL_ERROR',
          `Instance ${instanceId} of ${modelName} has no runner endpoint`,
        );
      }

      const claimKey = `${modelName}:${instanceId}`;
      if (instanceOpInFlight.has(claimKey)) {
        throw ControlPlaneError.invalidState(`${modelName}/${instanceId}`, instance.state, 'sleep');
      }
      instanceOpInFlight.add(claimKey);

      try {
        await deps.lifecycle.transition(modelName, instanceId, ModelLifecycleState.DRAINING);
        await refreshModelRoutingState(deps.lifecycle, deps.routingMap, modelName);
      } catch (err) {
        instanceOpInFlight.delete(claimKey);
        throw err;
      }

      deps.notifications
        .createNotification({
          title: 'Model instance sleep initiated',
          description: `${modelName} (${instanceId}) is draining`,
          variant: 'info',
          source: { type: 'model', name: modelName },
        })
        .catch((err: unknown) => {
          app.log.debug({ err, modelName, instanceId }, 'Failed to create sleep notification');
        });

      const runnerClient = deps.createRunnerClient(instance.runnerHost, instance.runnerPort);

      deps.sleepWake
        .sleepModel(modelName, instanceId, runnerClient)
        .catch((err: unknown) => {
          app.log.error({ err, modelName, instanceId }, 'Background sleep failed');
        })
        .finally(() => {
          instanceOpInFlight.delete(claimKey);
        });

      return reply.code(202).send({
        modelName,
        instanceId,
        state: ModelLifecycleState.DRAINING,
        previousState: ModelLifecycleState.ACTIVE,
        message: 'Sleep initiated',
      });
    },
  );

  app.post<{ Params: { modelName: string; instanceId: string } }>(
    '/api/v1/models/:modelName/instances/:instanceId/wake',
    async (request, reply) => {
      if (!deps.leaderElection.isLeader) {
        throw ControlPlaneError.notLeader();
      }

      const { modelName, instanceId } = request.params;
      assertValidModelName(modelName);
      assertNoMove(modelName, 'wake an instance for');

      const instance = await deps.lifecycle.getInstance(modelName, instanceId);
      if (!instance) {
        throw ControlPlaneError.modelNotFound(`${modelName}/${instanceId}`);
      }

      if (instance.state === ModelLifecycleState.STARTING) {
        return reply.code(202).send({
          modelName,
          instanceId,
          state: ModelLifecycleState.STARTING,
          previousState: ModelLifecycleState.STARTING,
          message: 'Instance is already waking up',
        });
      }

      if (instance.state !== ModelLifecycleState.SLEEPING) {
        throw ControlPlaneError.invalidState(`${modelName}/${instanceId}`, instance.state, 'wake');
      }

      if (!instance.runnerHost || !instance.runnerPort) {
        throw new ControlPlaneError(
          500,
          'INTERNAL_ERROR',
          `Instance ${instanceId} of ${modelName} has no runner endpoint`,
        );
      }

      const claimKey = `${modelName}:${instanceId}`;
      if (instanceOpInFlight.has(claimKey)) {
        throw ControlPlaneError.invalidState(`${modelName}/${instanceId}`, instance.state, 'wake');
      }
      instanceOpInFlight.add(claimKey);

      try {
        await deps.lifecycle.transition(modelName, instanceId, ModelLifecycleState.STARTING);
        await refreshModelRoutingState(deps.lifecycle, deps.routingMap, modelName);
      } catch (err) {
        instanceOpInFlight.delete(claimKey);
        throw err;
      }

      deps.notifications
        .createNotification({
          title: 'Model instance wake initiated',
          description: `${modelName} (${instanceId}) is waking up`,
          variant: 'info',
          source: { type: 'model', name: modelName },
        })
        .catch((err: unknown) => {
          app.log.debug({ err, modelName, instanceId }, 'Failed to create wake notification');
        });

      const runnerClient = deps.createRunnerClient(instance.runnerHost, instance.runnerPort);

      deps.sleepWake
        .wakeModel(modelName, instanceId, runnerClient)
        .catch((err: unknown) => {
          app.log.error({ err, modelName, instanceId }, 'Background wake failed');
        })
        .finally(() => {
          instanceOpInFlight.delete(claimKey);
        });

      return reply.code(202).send({
        modelName,
        instanceId,
        state: ModelLifecycleState.STARTING,
        previousState: ModelLifecycleState.SLEEPING,
        message: 'Wake initiated',
      });
    },
  );
}
