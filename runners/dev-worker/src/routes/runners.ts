import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { ConflictError, NotFoundError, type RunnerManager } from '../runner-manager.js';
import { isEntrypointAllowed, type EntrypointAllowlist } from '../entrypoint-allowlist.js';

export function registerRunnerRoutes(
  app: FastifyInstance,
  runnerManager: RunnerManager,
  entrypointAllowlist: EntrypointAllowlist,
): void {
  app.post<{
    Body: {
      modelName: string;
      instanceId?: string;
      runnerType: string;
      modelPath: string;
      requiredMemory: number;
      deviceType?: string;
      tensorParallel: number;
      runtimeModule?: string;
      engineConfig?: Record<string, unknown>;
      engineArgs?: string[];
      servedModelName?: string;
      entrypoint?: string[];
      devices: { deviceIndex: number; deviceType: string }[];
    };
  }>('/runners', async (req, reply) => {
    const body = req.body;
    // Log receipt up front (Fastify runs with logger:false) so operators can confirm the start
    // command actually reached this worker — the earliest guaranteed point, before any validation.
    console.log(
      `[worker] POST /runners received: model=${body?.modelName ?? '?'} ` +
        `instance=${body?.instanceId ?? '-'} runner=${body?.runnerType ?? '?'} ` +
        `module=${body?.runtimeModule ?? '-'} devices=${body?.devices?.length ?? 0}`,
    );

    if (!body?.modelName || !body?.runnerType || !body?.modelPath || !body?.devices) {
      console.warn('[worker] POST /runners rejected: missing required fields');
      return reply.status(400).send({
        error: 'Missing required fields: modelName, runnerType, modelPath, devices',
        code: 'BAD_REQUEST',
      });
    }

    // Defense-in-depth at the worker's own edge (#238): the CP sources `entrypoint` from trusted
    // catalog metadata, but anything reaching exec must be a known shim invocation. Absent/empty
    // is accepted (the launcher falls back to the configured SARDEENZ_RUNNER_ENTRYPOINT).
    if (!isEntrypointAllowed(entrypointAllowlist, body.entrypoint)) {
      console.warn(
        `[worker] POST /runners rejected: entrypoint argv not allowed: ${JSON.stringify(body.entrypoint)}`,
      );
      return reply.status(400).send({
        error:
          'entrypoint must equal the worker-configured SARDEENZ_RUNNER_ENTRYPOINT verbatim, or (when that vector has the <exec> -m <module> shape) be a <exec> -m <known-shim-module> invocation',
        code: 'BAD_REQUEST',
      });
    }

    // instanceId is optional/back-compat in the contract — the control plane always sends one,
    // but a fallback keeps older callers (and manual testing) working.
    const instanceId = body.instanceId ?? `inst-${randomUUID().replace(/-/g, '').slice(0, 12)}`;

    try {
      const result = await runnerManager.startRunner({
        modelName: body.modelName,
        instanceId,
        runnerType: body.runnerType,
        modelPath: body.modelPath,
        requiredMemory: body.requiredMemory ?? 0,
        deviceType: body.deviceType,
        tensorParallel: body.tensorParallel ?? 1,
        runtimeModule: body.runtimeModule,
        engineConfig: body.engineConfig,
        engineArgs: body.engineArgs,
        servedModelName: body.servedModelName,
        entrypoint: body.entrypoint,
        devices: body.devices,
      });
      // 201 only when *this* request spawned a process; a READY reuse or an in-flight join answers
      // 200 with the same endpoint and `reused: true` (#288).
      return reply.status(result.reused ? 200 : 201).send(result);
    } catch (err) {
      if (err instanceof ConflictError) {
        console.warn(`[worker] POST /runners conflict for instance ${instanceId}: ${err.message}`);
        return reply.status(409).send({ error: err.message, code: 'CONFLICT' });
      }
      // Surface launcher failures (SIF missing, apptainer verify/exec error, health timeout, …) —
      // otherwise they vanish into a 500 with no worker-side trace.
      console.error(`[worker] Failed to start runner for ${body.modelName}/${instanceId}:`, err);
      throw err;
    }
  });

  // Registry enumeration (#286): the control plane's reverse reconciliation lists this worker's
  // runners to find ones whose instance record it has lost. READY + STARTING, see
  // RunnerManager.getAllRunnerSummaries. Auth is the server's global onRequest hook — no change.
  app.get('/runners', (_req, reply) => {
    return reply.status(200).send({ runners: runnerManager.getAllRunnerSummaries() });
  });

  // Recovery lookup for an ambiguous POST /runners outcome. `instanceRunners` is populated
  // before the launcher is awaited, while `runners` is populated only after startup succeeds,
  // so the two maps distinguish a still-running cold start (202) from a ready runner (200)
  // without guessing from timing.
  app.get<{ Params: { instanceId: string } }>(
    '/runners/by-instance/:instanceId/status',
    (req, reply) => {
      // A failed launch whose process could not be confirmed dead (#288) outranks both registry
      // lookups: the instance slot was rolled back, so without this the control plane would see
      // STARTING (sealed log buffer) and then 404 while the process may still hold VRAM. Only the
      // ids are returned — there is no endpoint to recover, and the caller must DELETE the runner.
      const retained = runnerManager.getRetainedLaunchForInstance(req.params.instanceId);
      if (retained) {
        return reply.status(200).send({
          instanceId: req.params.instanceId,
          runnerId: retained.runnerId,
          state: 'FAILED',
        });
      }

      const runnerId = runnerManager.getRunnerIdForInstance(req.params.instanceId);
      if (!runnerId) {
        return reply.status(404).send({
          error: `Runner for instance ${req.params.instanceId} not found`,
          code: 'NOT_FOUND',
        });
      }

      const record = runnerManager.getRunner(runnerId);
      if (!record) {
        return reply.status(202).send({
          instanceId: req.params.instanceId,
          runnerId,
          state: 'STARTING',
        });
      }

      return reply.status(200).send({
        instanceId: record.instanceId,
        runnerId: record.runnerId,
        state: 'READY',
        host: record.host,
        port: record.port,
        enginePort: record.enginePort,
      });
    },
  );

  // Liveness probe for one runner (worker-agent contract `getRunner`, issue #166): the control
  // plane's reconciliation calls this to detect an instance whose record still claims a runner
  // the worker no longer hosts (e.g. a blank worker restart under the same workerId). Liveness
  // only — presence/absence of the record, no state or health assertions, so a healthy runner is
  // never flagged.
  app.get<{ Params: { runnerId: string } }>('/runners/:runnerId', (req, reply) => {
    const record = runnerManager.getRunner(req.params.runnerId);
    if (!record) {
      return reply
        .status(404)
        .send({ error: `Runner ${req.params.runnerId} not found`, code: 'NOT_FOUND' });
    }
    return reply.status(200).send({ runnerId: record.runnerId, instanceId: record.instanceId });
  });

  app.delete<{ Params: { runnerId: string } }>('/runners/:runnerId', async (req, reply) => {
    try {
      await runnerManager.stopRunner(req.params.runnerId);
      return reply.status(204).send();
    } catch (err) {
      if (err instanceof NotFoundError) {
        return reply.status(404).send({ error: err.message, code: 'NOT_FOUND' });
      }
      throw err;
    }
  });
}
