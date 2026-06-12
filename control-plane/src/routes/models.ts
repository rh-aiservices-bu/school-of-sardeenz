import type { FastifyInstance } from 'fastify';
import { ModelLifecycleState } from '@sardeenz/types';

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
  pinned?: boolean;
}

export function registerModelRoutes(app: FastifyInstance, deps: RouteDeps): void {
  app.post<{ Body: DeployBody }>('/api/v1/models', async (request, reply) => {
    if (!deps.leaderElection.isLeader) {
      throw ControlPlaneError.notLeader();
    }

    const body = request.body;
    if (!body?.modelName || !body.runnerType || !body.modelPath || !body.requiredMemory) {
      throw ControlPlaneError.invalidRequest(
        'modelName, runnerType, modelPath, and requiredMemory are required',
      );
    }

    const existing = await deps.modelRepository.findByName(body.modelName);
    if (existing) {
      throw ControlPlaneError.modelAlreadyExists(body.modelName);
    }

    await deps.modelRepository.create({
      name: body.modelName,
      runnerType: body.runnerType,
      modelPath: body.modelPath,
      requiredMemory: body.requiredMemory,
      deviceType: body.deviceType,
      tensorParallel: body.tensorParallel,
      engineConfig: body.engineConfig,
      pinned: body.pinned,
    });

    await deps.lifecycle.createModel(body.modelName);

    const workers = deps.workerPool.getAllWorkers();
    const budgets = new Map(deps.memoryBudget.getAllBudgets().map((b) => [b.workerId, b]));

    const result = deps.placement.place(
      {
        modelName: body.modelName,
        runnerType: body.runnerType,
        requiredMemory: body.requiredMemory,
        deviceType: body.deviceType,
        tensorParallel: body.tensorParallel ?? 1,
      },
      workers,
      budgets,
    );

    if (!result) {
      throw ControlPlaneError.placementFailed(body.modelName, 'No worker with sufficient capacity');
    }

    for (const device of result.devices) {
      deps.memoryBudget.reserveCapacity(
        result.workerId,
        device.deviceIndex,
        body.requiredMemory / (body.tensorParallel ?? 1),
      );
    }

    await deps.lifecycle.transition(body.modelName, ModelLifecycleState.STARTING, {
      workerId: result.workerId,
    });

    return reply.code(202).send({
      modelName: body.modelName,
      state: ModelLifecycleState.STARTING,
      message: `Placed on worker ${result.workerId}`,
    });
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
        pinned: record?.pinned ?? false,
        workerId: state?.workerId ?? undefined,
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

      const state = await deps.lifecycle.getState(modelName);
      if (!state) {
        throw ControlPlaneError.modelNotFound(modelName);
      }

      if (
        state.state === ModelLifecycleState.STOPPING ||
        state.state === ModelLifecycleState.STOPPED
      ) {
        throw ControlPlaneError.invalidState(modelName, state.state, 'delete');
      }

      const runnerClient =
        state.runnerHost && state.runnerPort
          ? deps.createRunnerClient(state.runnerHost, state.runnerPort)
          : null;

      deps.sleepWake.stopModel(modelName, runnerClient).then(
        async () => {
          await deps.lifecycle.removeModel(modelName);
          await deps.modelRepository.delete(modelName);
          app.log.info({ modelName }, 'Model removed');
        },
        (err: unknown) => {
          app.log.error({ err, modelName }, 'Background model deletion failed');
        },
      );

      return reply.code(202).send({
        modelName,
        state: ModelLifecycleState.STOPPING,
        previousState: state.state,
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
