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
  record: ModelRecord,
  instanceId: string,
): Promise<{ instanceId: string; state: ModelLifecycleState; message: string }> {
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

    const workers = deps.workerPool.getAllWorkers();
    const budgets = new Map(deps.memoryBudget.getAllBudgets().map((b) => [b.workerId, b]));

    const placementRequest = {
      modelName: record.name,
      runnerType: record.runnerType,
      requiredMemory,
      deviceType: record.deviceType ?? undefined,
      tensorParallel,
    };

    const result = deps.placement.place(placementRequest, workers, budgets);

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

      deps.deployOrchestration
        .deployModel({
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
        })
        .catch((err: unknown) => {
          app.log.error(
            { err, modelName: record.name, instanceId },
            'Background deploy orchestration failed',
          );
        });

      return {
        instanceId,
        state: ModelLifecycleState.STARTING,
        message: `Placed on worker ${result.workerId}`,
      };
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
      const { state, message } = await deployFromRecord(app, deps, record, instanceId);
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
      const { state, message } = await deployFromRecord(app, deps, record, instanceId);

      return reply.code(202).send({ modelName, instanceId, state, message });
    },
  );

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

    const models = [];

    for (const name of modelNames) {
      const instances = instancesByModel.get(name) ?? [];
      const record = recordMap.get(name);

      const currentState = deriveAggregateState(instances);
      if (stateFilter && currentState !== stateFilter) continue;

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
          toInstanceDetail(instance, createdAtByInstance.get(instance.instanceId)),
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

      if (instances.some((i) => i.state === ModelLifecycleState.STOPPING)) {
        throw ControlPlaneError.invalidState(modelName, ModelLifecycleState.STOPPING, 'delete');
      }

      const aggregateState = deriveAggregateState(instances);

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
        // Isolated per instance (Promise.allSettled over teardownInstance, which never throws) —
        // one instance's teardown failure must not strand the others, and the model row / routing
        // map cleanup below must still run so the record doesn't survive a partial delete.
        const results = await Promise.allSettled(
          instances.map((instance) => teardownInstance(app, deps, modelName, instance, 'Delete')),
        );
        const failures = results.filter((r) => r.status === 'rejected' || r.value === false).length;
        if (failures > 0) {
          app.log.error(
            { modelName, failures, total: instances.length },
            'Some instances failed teardown during model delete',
          );
        }

        try {
          // CASCADE on the FK cleans up any instance rows this loop didn't reach (e.g. one
          // created concurrently after the snapshot above, or one whose teardown failed above).
          await deps.modelRepository.delete(modelName);
          await deps.routingMap.removeModel(modelName);
          app.log.info({ modelName }, 'Model removed');
        } catch (err: unknown) {
          app.log.error({ err, modelName }, 'Background model deletion failed');
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
      const { state: newState, message } = await deployFromRecord(app, deps, record, instanceId);

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

      const instance = await deps.lifecycle.getInstance(modelName, instanceId);
      if (!instance) {
        throw ControlPlaneError.modelNotFound(`${modelName}/${instanceId}`);
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
