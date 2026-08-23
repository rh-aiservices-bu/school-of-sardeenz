import type { FastifyInstance } from 'fastify';
import { ModelLifecycleState } from '@sardeenz/types';

import type { RouteDeps } from './deps.js';
import { ControlPlaneError } from '../errors.js';
import { deriveAggregateState } from '../services/model-lifecycle.js';
import { refreshModelRoutingState } from '../services/sleep-wake.js';
import { assertValidModelName } from '../utils/model-name.js';

export function registerInternalRoutes(app: FastifyInstance, deps: RouteDeps): void {
  app.post<{ Body: { modelName: string } }>('/api/v1/wake', async (request, reply) => {
    // Leader gate: only the leader instance should orchestrate wake operations.
    if (!deps.leaderElection.isLeader) {
      throw ControlPlaneError.notLeader();
    }

    const { modelName } = request.body ?? {};
    if (!modelName || typeof modelName !== 'string') {
      throw ControlPlaneError.invalidRequest('modelName is required');
    }
    assertValidModelName(modelName);

    const instances = await deps.lifecycle.getInstancesForModel(modelName);
    if (instances.length === 0) {
      throw ControlPlaneError.modelNotFound(modelName);
    }

    // Minimal multi-instance wake-on-request policy (#120 non-goal: load-aware fan-out is M8+):
    // if any instance is already serving or already waking, this trigger is satisfied without
    // touching anything else. Otherwise wake exactly one instance — the most-recently-active
    // SLEEPING one (max lastInferenceAt, tiebreak max stateChangedAt) — never all of them.
    if (instances.some((i) => i.state === ModelLifecycleState.ACTIVE)) {
      return reply.code(200).send({
        accepted: true,
        modelName,
        currentState: ModelLifecycleState.ACTIVE,
        message: 'Model is already active',
      });
    }

    if (instances.some((i) => i.state === ModelLifecycleState.STARTING)) {
      return reply.code(202).send({
        accepted: true,
        modelName,
        currentState: ModelLifecycleState.STARTING,
        message: 'Model is already waking up',
      });
    }

    const sleeping = instances.filter((i) => i.state === ModelLifecycleState.SLEEPING);
    if (sleeping.length === 0) {
      throw ControlPlaneError.invalidState(modelName, deriveAggregateState(instances), 'wake');
    }

    const target = [...sleeping].sort((a, b) => {
      const byInference = (b.lastInferenceAt ?? '').localeCompare(a.lastInferenceAt ?? '');
      if (byInference !== 0) return byInference;
      return b.stateChangedAt.localeCompare(a.stateChangedAt);
    })[0];

    if (!target.runnerHost || !target.runnerPort) {
      throw new ControlPlaneError(
        500,
        'INTERNAL_ERROR',
        `Instance ${target.instanceId} of ${modelName} has no runner endpoint`,
      );
    }

    // Atomically claim SLEEPING → STARTING before launching background work.
    // The CAS transition (Lua script) ensures only one concurrent request wins this instance;
    // a losing concurrent request will find it in STARTING and return 202 above.
    await deps.lifecycle.transition(modelName, target.instanceId, ModelLifecycleState.STARTING);
    await refreshModelRoutingState(deps.lifecycle, deps.routingMap, modelName);

    const runnerClient = deps.createRunnerClient(target.runnerHost, target.runnerPort);

    deps.sleepWake.wakeModel(modelName, target.instanceId, runnerClient).catch((err: unknown) => {
      app.log.error({ err, modelName, instanceId: target.instanceId }, 'Background wake failed');
    });

    return reply.code(202).send({
      accepted: true,
      modelName,
      currentState: ModelLifecycleState.STARTING,
      message: 'Wake initiated',
    });
  });

  app.get('/api/v1/routing-map', async (_request, reply) => {
    const routingMap = await deps.routingMap.getRoutingMap();
    return reply.code(200).send(routingMap);
  });
}
