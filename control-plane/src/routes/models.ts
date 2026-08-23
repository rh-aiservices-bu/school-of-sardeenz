import type { FastifyInstance } from 'fastify';
import { ModelLifecycleState, ModelState } from '@sardeenz/types';

import type { RouteDeps } from './deps.js';
import { ControlPlaneError } from '../errors.js';
import { isContainedIn } from '../utils/path-containment.js';
import type { ModelRecord } from '../services/model-repository.js';

interface DeployBody {
  modelName: string;
  runnerType: string;
  modelPath: string;
  requiredMemory: number;
  deviceType?: string;
  tensorParallel?: number;
  engineConfig?: Record<string, unknown>;
  runtimeModule?: string;
  pinned?: boolean;
}

// Mirrors the worker-agent contract's runtimeModule pattern; it becomes a SIF filename segment.
const RUNTIME_MODULE_PATTERN = /^[A-Za-z0-9_.-]+$/;

// Mirrors ModelDeploymentRequest.modelName in packages/contracts/specs/control-plane.yaml.
const MODEL_NAME_PATTERN = /^[A-Za-z0-9._/-]{1,200}$/;

// Stop is only valid from these settled states. Every other state (PENDING, STARTING, DRAINING,
// STOPPING, and the synthetic STOPPED) is transient or already-terminal background work in
// flight — interrupting it would race the fire-and-forget deploy/start/wake orchestration and
// leave an orphaned runner holding VRAM the budget no longer accounts for. ERROR is included
// deliberately: the dashboard offers Stop from it, and sleepWake.stopModel already knows how to
// tear an ERROR-state model down (see VALID_TRANSITIONS in model-lifecycle.ts).
const STOPPABLE_STATES: ReadonlySet<ModelLifecycleState> = new Set([
  ModelLifecycleState.ACTIVE,
  ModelLifecycleState.SLEEPING,
  ModelLifecycleState.ERROR,
]);

/**
 * Runs the placement → reserve → transition → dispatch pipeline for a stored model record.
 * Shared by `POST /api/v1/models` (record just created) and `POST /api/v1/models/:modelName/start`
 * (record already existed, no runtime state). Owns only the Redis state it creates — on synchronous
 * failure it removes that Redis key, but never touches the Postgres row; the caller decides what
 * happens to the row.
 */
async function deployFromRecord(
  app: FastifyInstance,
  deps: RouteDeps,
  record: ModelRecord,
): Promise<{ state: ModelLifecycleState; message: string }> {
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

  let redisCreated = false;
  try {
    await deps.lifecycle.createModel(record.name);
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
          record.name,
          requiredMemory / tensorParallel,
        );
      }

      await deps.lifecycle.transition(record.name, ModelLifecycleState.STARTING, {
        workerId: result.workerId,
        deviceIndices: result.devices.map((d) => d.deviceIndex),
      });

      deps.deployOrchestration
        .deployModel({
          modelName: record.name,
          workerId: result.workerId,
          runnerType: record.runnerType,
          modelPath: record.modelPath,
          requiredMemory,
          deviceType: record.deviceType ?? undefined,
          tensorParallel,
          engineConfig: record.engineConfig ?? undefined,
          runtimeModule: record.runtimeModule ?? undefined,
          devices: result.devices,
        })
        .catch((err: unknown) => {
          app.log.error({ err, modelName: record.name }, 'Background deploy orchestration failed');
        });

      return { state: ModelLifecycleState.STARTING, message: `Placed on worker ${result.workerId}` };
    }

    const eligibleWorkerIds = deps.placement.eligibleWorkerIds(placementRequest, workers);
    if (eligibleWorkerIds.size === 0) {
      throw ControlPlaneError.placementFailed(record.name, 'No worker with sufficient capacity');
    }

    const allStates = await deps.lifecycle.getAllStates();
    const inferenceTs = await deps.lifecycle.getLastInferenceTimestamps(
      allStates.map((s) => s.modelName),
    );
    for (const s of allStates) {
      s.lastInferenceAt = inferenceTs.get(s.modelName) ?? s.lastInferenceAt;
    }
    const allRecords = await deps.modelRepository.findAll();
    const pinnedModels = new Set(allRecords.filter((r) => r.pinned).map((r) => r.name));
    const memoryByModel = new Map(
      allRecords.filter((r) => r.requiredMemory !== null).map((r) => [r.name, r.requiredMemory!]),
    );

    const victims = deps.eviction.selectVictims(
      allStates,
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
        for (const victim of victims) {
          const victimState = await deps.lifecycle.getState(victim.modelName);
          const victimRunner =
            victimState?.runnerHost && victimState.runnerPort
              ? deps.createRunnerClient(victimState.runnerHost, victimState.runnerPort)
              : null;
          await deps.sleepWake.stopModel(victim.modelName, victimRunner);
          // Registry semantics: DB row kept; only Redis lifecycle cleared (see #121).
          await deps.lifecycle.removeModel(victim.modelName);
          deps.eviction.recordEviction('capacity');
        }
        stopTimer();

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
            record.name,
            requiredMemory / tensorParallel,
          );
        }

        await deps.lifecycle.transition(record.name, ModelLifecycleState.STARTING, {
          workerId: reclaimed.workerId,
          deviceIndices: reclaimed.devices.map((d) => d.deviceIndex),
        });

        deps.deployOrchestration
          .deployModel({
            modelName: record.name,
            workerId: reclaimed.workerId,
            runnerType: record.runnerType,
            modelPath: record.modelPath,
            requiredMemory,
            deviceType: record.deviceType ?? undefined,
            tensorParallel,
            engineConfig: record.engineConfig ?? undefined,
            runtimeModule: record.runtimeModule ?? undefined,
            devices: reclaimed.devices,
          })
          .catch((err: unknown) => {
            app.log.error(
              { err, modelName: record.name },
              'Background deploy orchestration failed',
            );
          });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        app.log.error({ err, modelName: record.name }, 'Background capacity reclamation failed');

        try {
          await deps.lifecycle.transition(record.name, ModelLifecycleState.ERROR, {
            errorMessage: message,
          });
          await deps.routingMap.setModelState(record.name, ModelState.ERROR);
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

    return { state: ModelLifecycleState.PENDING, message: 'Capacity reclamation in progress' };
  } catch (err) {
    if (redisCreated) {
      await deps.lifecycle.removeModel(record.name).catch(() => {});
    }
    throw err;
  }
}

export function registerModelRoutes(app: FastifyInstance, deps: RouteDeps): void {
  // Model names with a Stop synchronously claimed but not yet backgrounded-complete. Closes the
  // double-Stop race: two concurrent Stop calls can both read the same settled state before
  // either mutates anything, since Stop's teardown is fully backgrounded and none of ACTIVE/
  // SLEEPING/ERROR has a uniform valid edge straight to STOPPING in VALID_TRANSITIONS (only
  // SLEEPING and DRAINING do — see model-lifecycle.ts), so a synchronous state transition can't
  // serve as the claim for all three. This in-process set does instead; it never touches
  // VALID_TRANSITIONS. Only the leader instance runs mutating routes, so per-process state is
  // sufficient — no cross-instance coordination needed.
  const stoppingInFlight = new Set<string>();

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

    if (!MODEL_NAME_PATTERN.test(body.modelName)) {
      throw ControlPlaneError.invalidRequest('modelName must match ^[A-Za-z0-9._/-]{1,200}$');
    }

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
        runtimeModule: body.runtimeModule,
        pinned: body.pinned,
      });
    } catch (err) {
      if (err instanceof Error && err.message.includes('unique')) {
        throw ControlPlaneError.modelAlreadyExists(body.modelName);
      }
      throw err;
    }

    try {
      const { state, message } = await deployFromRecord(app, deps, record);
      return reply.code(202).send({ modelName: record.name, state, message });
    } catch (err) {
      // Placement failed synchronously — roll back the DB row so the name is free to retry.
      await deps.modelRepository.delete(record.name).catch(() => {});
      throw err;
    }
  });

  app.get<{ Querystring: { state?: string } }>('/api/v1/models', async (request, reply) => {
    const stateFilter = request.query.state as ModelLifecycleState | undefined;

    if (stateFilter && !Object.values(ModelLifecycleState).includes(stateFilter)) {
      throw ControlPlaneError.invalidRequest(`Invalid state filter: ${stateFilter}`);
    }

    const [allStates, allRecords] = await Promise.all([
      deps.lifecycle.getAllStates(),
      deps.modelRepository.findAll(),
    ]);

    const stateMap = new Map(allStates.map((s) => [s.modelName, s]));
    const recordMap = new Map(allRecords.map((r) => [r.name, r]));

    const modelNames = new Set([
      ...allStates.map((s) => s.modelName),
      ...allRecords.map((r) => r.name),
    ]);

    const models = [];

    for (const name of modelNames) {
      const state = stateMap.get(name);
      const record = recordMap.get(name);

      const currentState = state?.state ?? ModelLifecycleState.STOPPED;
      if (stateFilter && currentState !== stateFilter) continue;

      models.push({
        modelName: name,
        state: currentState,
        runnerType: record?.runnerType ?? 'unknown',
        workerId: state?.workerId ?? undefined,
        requiredMemory: record?.requiredMemory ?? undefined,
        lastInferenceAt: state?.lastInferenceAt ?? undefined,
        pinned: record?.pinned ?? false,
        createdAt: record?.createdAt?.toISOString() ?? state?.stateChangedAt ?? undefined,
      });
    }

    return reply.code(200).send({ models });
  });

  app.get<{ Params: { modelName: string } }>(
    '/api/v1/models/:modelName',
    async (request, reply) => {
      const { modelName } = request.params;

      const [state, record] = await Promise.all([
        deps.lifecycle.getState(modelName),
        deps.modelRepository.findByName(modelName),
      ]);

      if (!state && !record) {
        throw ControlPlaneError.modelNotFound(modelName);
      }

      const detail = {
        modelName,
        state: state?.state ?? ModelLifecycleState.STOPPED,
        runnerType: record?.runnerType ?? 'unknown',
        modelPath: record?.modelPath ?? '',
        requiredMemory: record?.requiredMemory ?? 0,
        deviceType: record?.deviceType ?? undefined,
        tensorParallel: record?.tensorParallel ?? 1,
        engineConfig: record?.engineConfig ?? undefined,
        runtimeModule: record?.runtimeModule ?? undefined,
        pinned: record?.pinned ?? false,
        workerId: state?.workerId ?? undefined,
        deviceIndices: state?.deviceIndices ?? undefined,
        runnerEndpoint:
          state?.runnerHost && state?.runnerPort
            ? { host: state.runnerHost, port: state.runnerPort }
            : undefined,
        lastInferenceAt: state?.lastInferenceAt ?? undefined,
        stateChangedAt: state?.stateChangedAt ?? undefined,
        errorMessage: state?.errorMessage ?? undefined,
        createdAt: record?.createdAt?.toISOString() ?? state?.stateChangedAt ?? '',
        updatedAt: record?.updatedAt?.toISOString() ?? state?.stateChangedAt ?? '',
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

      const [state, record] = await Promise.all([
        deps.lifecycle.getState(modelName),
        deps.modelRepository.findByName(modelName),
      ]);

      if (!state && !record) {
        throw ControlPlaneError.modelNotFound(modelName);
      }

      if (!state && record) {
        await deps.modelRepository.delete(modelName);
        return reply.code(202).send({
          modelName,
          state: ModelLifecycleState.STOPPED,
          previousState: ModelLifecycleState.STOPPED,
          message: 'Model record removed',
        });
      }

      if (state!.state === ModelLifecycleState.STOPPING) {
        throw ControlPlaneError.invalidState(modelName, state!.state, 'delete');
      }

      const runnerClient =
        state!.runnerHost && state!.runnerPort
          ? deps.createRunnerClient(state!.runnerHost, state!.runnerPort)
          : null;

      deps.notifications
        .createNotification({
          title: 'Model deleted',
          description: `${modelName} removal initiated`,
          variant: 'info',
          source: { type: 'model', name: modelName },
        })
        .catch((err: unknown) => {
          app.log.debug({ err, modelName }, 'Failed to create delete notification');
        });

      void (async () => {
        try {
          await deps.sleepWake.stopModel(modelName, runnerClient);
          await deps.lifecycle.removeModel(modelName);
          await deps.modelRepository.delete(modelName);
          app.log.info({ modelName }, 'Model removed');
        } catch (err: unknown) {
          app.log.error({ err, modelName }, 'Background model deletion failed');
        }
      })();

      return reply.code(202).send({
        modelName,
        state: ModelLifecycleState.STOPPING,
        previousState: state!.state,
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

      const state = await deps.lifecycle.getState(modelName);
      if (!state) {
        throw ControlPlaneError.modelNotFound(modelName);
      }

      if (state.state !== ModelLifecycleState.ACTIVE) {
        throw ControlPlaneError.invalidState(modelName, state.state, 'sleep');
      }

      if (!state.runnerHost || !state.runnerPort) {
        throw new ControlPlaneError(
          500,
          'INTERNAL_ERROR',
          `Model ${modelName} has no runner endpoint`,
        );
      }

      // Atomically claim ACTIVE → DRAINING before launching background work.
      await deps.lifecycle.transition(modelName, ModelLifecycleState.DRAINING);

      deps.notifications
        .createNotification({
          title: 'Model sleep initiated',
          description: `${modelName} is draining`,
          variant: 'info',
          source: { type: 'model', name: modelName },
        })
        .catch((err: unknown) => {
          app.log.debug({ err, modelName }, 'Failed to create sleep notification');
        });

      const runnerClient = deps.createRunnerClient(state.runnerHost, state.runnerPort);

      deps.sleepWake.sleepModel(modelName, runnerClient).catch((err: unknown) => {
        app.log.error({ err, modelName }, 'Background sleep failed');
      });

      return reply.code(202).send({
        modelName,
        state: ModelLifecycleState.DRAINING,
        previousState: ModelLifecycleState.ACTIVE,
        message: 'Sleep initiated',
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

      const state = await deps.lifecycle.getState(modelName);
      if (!state) {
        throw ControlPlaneError.modelNotFound(modelName);
      }

      if (state.state === ModelLifecycleState.STARTING) {
        return reply.code(202).send({
          modelName,
          state: ModelLifecycleState.STARTING,
          previousState: ModelLifecycleState.STARTING,
          message: 'Model is already waking up',
        });
      }

      if (state.state !== ModelLifecycleState.SLEEPING) {
        throw ControlPlaneError.invalidState(modelName, state.state, 'wake');
      }

      if (!state.runnerHost || !state.runnerPort) {
        throw new ControlPlaneError(
          500,
          'INTERNAL_ERROR',
          `Model ${modelName} has no runner endpoint`,
        );
      }

      // Atomically claim SLEEPING → STARTING before launching background work.
      // Concurrent wake requests will fail this transition and get "already waking".
      await deps.lifecycle.transition(modelName, ModelLifecycleState.STARTING);

      deps.notifications
        .createNotification({
          title: 'Model wake initiated',
          description: `${modelName} is waking up`,
          variant: 'info',
          source: { type: 'model', name: modelName },
        })
        .catch((err: unknown) => {
          app.log.debug({ err, modelName }, 'Failed to create wake notification');
        });

      const record = await deps.modelRepository.findByName(modelName);
      const requiredMemory = record?.requiredMemory ?? 0;

      if (requiredMemory > 0 && state.workerId) {
        const workerBudget = deps.memoryBudget.getWorkerBudget(state.workerId);
        const totalAvailable = workerBudget
          ? workerBudget.devices.reduce((sum, d) => sum + d.availableBytes, 0)
          : 0;

        if (totalAvailable < requiredMemory) {
          const allStates = await deps.lifecycle.getAllStates();
          const inferenceTs = await deps.lifecycle.getLastInferenceTimestamps(
            allStates.map((s) => s.modelName),
          );
          for (const s of allStates) {
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
            allStates,
            pinnedModels,
            requiredMemory,
            new Set([state.workerId]),
            memoryByModel,
          );

          for (const victim of victims) {
            const vs = await deps.lifecycle.getState(victim.modelName);
            const vr =
              vs?.runnerHost && vs.runnerPort
                ? deps.createRunnerClient(vs.runnerHost, vs.runnerPort)
                : null;
            await deps.sleepWake.stopModel(victim.modelName, vr);
            // Registry semantics: DB row kept; only Redis lifecycle cleared (see #121).
            await deps.lifecycle.removeModel(victim.modelName);
            deps.eviction.recordEviction('wake');
          }
        }
      }

      const runnerClient = deps.createRunnerClient(state.runnerHost, state.runnerPort);

      deps.sleepWake.wakeModel(modelName, runnerClient).catch((err: unknown) => {
        app.log.error({ err, modelName }, 'Background wake failed');
      });

      return reply.code(202).send({
        modelName,
        state: ModelLifecycleState.STARTING,
        previousState: ModelLifecycleState.SLEEPING,
        message: 'Wake initiated',
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

      const state = await deps.lifecycle.getState(modelName);
      if (!state) {
        // No runtime state = nothing to stop. Mirrors sleep/wake. A record with no
        // runtime state is already "stopped"; use start or delete on it instead.
        throw ControlPlaneError.modelNotFound(modelName);
      }

      if (!STOPPABLE_STATES.has(state.state)) {
        throw ControlPlaneError.invalidState(modelName, state.state, 'stop');
      }

      if (stoppingInFlight.has(modelName)) {
        throw ControlPlaneError.invalidState(modelName, state.state, 'stop');
      }
      stoppingInFlight.add(modelName);

      const runnerClient =
        state.runnerHost && state.runnerPort
          ? deps.createRunnerClient(state.runnerHost, state.runnerPort)
          : null;

      deps.notifications
        .createNotification({
          title: 'Model stop initiated',
          description: `${modelName} is stopping`,
          variant: 'info',
          source: { type: 'model', name: modelName },
        })
        .catch((err: unknown) => {
          app.log.debug({ err, modelName }, 'Failed to create stop notification');
        });

      void (async () => {
        try {
          await deps.sleepWake.stopModel(modelName, runnerClient);
          await deps.lifecycle.removeModel(modelName);
          // Record deliberately retained — this is Stop, not Delete (see #121).
          app.log.info({ modelName }, 'Model stopped');
        } catch (err: unknown) {
          app.log.error({ err, modelName }, 'Background model stop failed');
        } finally {
          stoppingInFlight.delete(modelName);
        }
      })();

      return reply.code(202).send({
        modelName,
        state: ModelLifecycleState.STOPPING,
        previousState: state.state,
        message: 'Stop initiated',
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

      const [state, record] = await Promise.all([
        deps.lifecycle.getState(modelName),
        deps.modelRepository.findByName(modelName),
      ]);

      if (!record) {
        throw ControlPlaneError.modelNotFound(modelName);
      }

      if (state) {
        // Runtime state exists — the model is running or transitioning, not stopped.
        throw ControlPlaneError.invalidState(modelName, state.state, 'start');
      }

      const { state: newState, message } = await deployFromRecord(app, deps, record);

      return reply.code(202).send({
        modelName,
        state: newState,
        previousState: ModelLifecycleState.STOPPED,
        message,
      });
    },
  );
}
