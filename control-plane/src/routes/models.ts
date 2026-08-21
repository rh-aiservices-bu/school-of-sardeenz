import type { FastifyInstance } from 'fastify';
import { ModelLifecycleState, ModelState } from '@sardeenz/types';

import type { RouteDeps } from './deps.js';
import { ControlPlaneError } from '../errors.js';

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

export function registerModelRoutes(app: FastifyInstance, deps: RouteDeps): void {
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

    let dbCreated = false;
    let redisCreated = false;

    try {
      await deps.modelRepository.create({
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
      dbCreated = true;
    } catch (err) {
      if (err instanceof Error && err.message.includes('unique')) {
        throw ControlPlaneError.modelAlreadyExists(body.modelName);
      }
      throw err;
    }

    try {
      await deps.lifecycle.createModel(body.modelName);
      redisCreated = true;

      const workers = deps.workerPool.getAllWorkers();
      const budgets = new Map(deps.memoryBudget.getAllBudgets().map((b) => [b.workerId, b]));

      const placementRequest = {
        modelName: body.modelName,
        runnerType: body.runnerType,
        requiredMemory: body.requiredMemory,
        deviceType: body.deviceType,
        tensorParallel: body.tensorParallel ?? 1,
      };

      const result = deps.placement.place(placementRequest, workers, budgets);

      if (result) {
        for (const device of result.devices) {
          deps.memoryBudget.reserveCapacity(
            result.workerId,
            device.deviceIndex,
            body.modelName,
            body.requiredMemory / (body.tensorParallel ?? 1),
          );
        }

        await deps.lifecycle.transition(body.modelName, ModelLifecycleState.STARTING, {
          workerId: result.workerId,
          deviceIndices: result.devices.map((d) => d.deviceIndex),
        });

        deps.deployOrchestration
          .deployModel({
            modelName: body.modelName,
            workerId: result.workerId,
            runnerType: body.runnerType,
            modelPath: body.modelPath,
            requiredMemory: body.requiredMemory,
            deviceType: body.deviceType,
            tensorParallel: body.tensorParallel ?? 1,
            engineConfig: body.engineConfig,
            runtimeModule: body.runtimeModule,
            devices: result.devices,
          })
          .catch((err: unknown) => {
            app.log.error(
              { err, modelName: body.modelName },
              'Background deploy orchestration failed',
            );
          });

        return reply.code(202).send({
          modelName: body.modelName,
          state: ModelLifecycleState.STARTING,
          message: `Placed on worker ${result.workerId}`,
        });
      }

      const eligibleWorkerIds = deps.placement.eligibleWorkerIds(placementRequest, workers);
      if (eligibleWorkerIds.size === 0) {
        throw ControlPlaneError.placementFailed(
          body.modelName,
          'No worker with sufficient capacity',
        );
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
        body.requiredMemory,
        eligibleWorkerIds,
        memoryByModel,
      );

      if (victims.length === 0) {
        throw ControlPlaneError.placementFailed(
          body.modelName,
          'No worker with sufficient capacity',
        );
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
              body.modelName,
              'No worker with sufficient capacity after capacity reclamation',
            );
          }

          for (const device of reclaimed.devices) {
            deps.memoryBudget.reserveCapacity(
              reclaimed.workerId,
              device.deviceIndex,
              body.modelName,
              body.requiredMemory / (body.tensorParallel ?? 1),
            );
          }

          await deps.lifecycle.transition(body.modelName, ModelLifecycleState.STARTING, {
            workerId: reclaimed.workerId,
            deviceIndices: reclaimed.devices.map((d) => d.deviceIndex),
          });

          deps.deployOrchestration
            .deployModel({
              modelName: body.modelName,
              workerId: reclaimed.workerId,
              runnerType: body.runnerType,
              modelPath: body.modelPath,
              requiredMemory: body.requiredMemory,
              deviceType: body.deviceType,
              tensorParallel: body.tensorParallel ?? 1,
              engineConfig: body.engineConfig,
              runtimeModule: body.runtimeModule,
              devices: reclaimed.devices,
            })
            .catch((err: unknown) => {
              app.log.error(
                { err, modelName: body.modelName },
                'Background deploy orchestration failed',
              );
            });
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          app.log.error(
            { err, modelName: body.modelName },
            'Background capacity reclamation failed',
          );

          try {
            await deps.lifecycle.transition(body.modelName, ModelLifecycleState.ERROR, {
              errorMessage: message,
            });
            await deps.routingMap.setModelState(body.modelName, ModelState.ERROR);
          } catch {
            // Intentionally swallowed — do not mask the original error.
          }

          deps.notifications
            .createNotification({
              title: 'Model deployment failed',
              description: `${body.modelName}: ${message}`,
              variant: 'danger',
              source: { type: 'model', name: body.modelName },
            })
            .catch((notifyErr: unknown) => {
              app.log.debug(
                { err: notifyErr, modelName: body.modelName },
                'Failed to create failure notification',
              );
            });
        }
      })();

      return reply.code(202).send({
        modelName: body.modelName,
        state: ModelLifecycleState.PENDING,
        message: 'Capacity reclamation in progress',
      });
    } catch (err) {
      if (redisCreated) {
        await deps.lifecycle.removeModel(body.modelName).catch(() => {});
      }
      if (dbCreated) {
        await deps.modelRepository.delete(body.modelName).catch(() => {});
      }
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
}
