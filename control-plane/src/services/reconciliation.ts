import { ClusterEventType, ModelLifecycleState, WorkerStatus } from '@sardeenz/types';
import type { ControlPlaneComponents } from '@sardeenz/types';

import type { Redis } from '../clients/redis.js';
import { redisKey } from '../clients/redis.js';
import type { ModelLifecycleService } from './model-lifecycle.js';
import type { WorkerPoolService } from './worker-pool.js';
import type { MemoryBudgetService } from './memory-budget.js';
import type { RoutingMapService } from './routing-map.js';
import type { NotificationService } from './notification.js';
import type { InstanceRepository } from './instance-repository.js';
import type { ModelRepository } from './model-repository.js';
import type { StartupLogCaptureService } from './startup-log-capture.js';
import { refreshModelRoutingState } from './sleep-wake.js';
import type { WorkerClient } from '../clients/worker.js';
import type { MoveOrchestrationService } from './move-orchestration.js';
import { WorkerHttpError } from '../clients/worker.js';
import {
  reconciliationTicksTotal,
  reconciliationStuckModelsTotal,
  reconciliationDeadWorkersTotal,
  reconciliationMissingRunnersTotal,
  reconciliationTickDuration,
  reconciliationErrors,
  modelsTotal,
  workersTotal,
  deviceMemoryBytes,
} from '../health/metrics.js';

export interface ReconciliationLogger {
  debug(obj: Record<string, unknown>, msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface ReconciliationConfig {
  readonly reconciliationIntervalSecs: number;
  readonly deployTimeoutSecs: number;
  readonly sleepTimeoutSecs: number;
  /**
   * How long a STARTING instance whose worker cannot be reached may go unprobed before
   * `reconcileMissingRunners` treats the miss as confirmed. STARTING instances are probed only
   * after this grace window — a fresh cold-start is a live operation on the worker (POST /runners
   * still in flight) that would be wrongly killed by an immediate reap; only a long-lived miss
   * (worker restarted blank, runner never recorded) is actionable here. A missed ACTIVE instance
   * is always confirmed immediately — it no longer serves anything, and the fast-fail stop path
   * (sleep-wake) already treats an unreachable runner as a one-poll-interval failure.
   */
  readonly missingRunnerProbeGraceSecs: number;
}

type ClusterEvent = ControlPlaneComponents['schemas']['ClusterEvent'];

const CLUSTER_EVENTS_CHANNEL = 'cluster-events';

const TRANSITIONAL_STATES: ReadonlyMap<ModelLifecycleState, 'deploy' | 'sleep'> = new Map([
  [ModelLifecycleState.STARTING, 'deploy'],
  [ModelLifecycleState.DRAINING, 'sleep'],
  [ModelLifecycleState.STOPPING, 'sleep'],
]);

export class ReconciliationService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private wasLeader = false;
  private running = false;
  private legacyPruneDone = false;
  private readonly clusterEventsChannel: string;

  constructor(
    private readonly lifecycle: ModelLifecycleService,
    private readonly workerPool: WorkerPoolService,
    private readonly memoryBudget: MemoryBudgetService,
    private readonly routingMap: RoutingMapService,
    private readonly leaderElection: { readonly isLeader: boolean },
    private readonly config: ReconciliationConfig,
    private readonly logger: ReconciliationLogger,
    private readonly redis: Redis,
    keyPrefix: string,
    private readonly notifications?: NotificationService,
    private readonly instanceRepository?: InstanceRepository,
    private readonly modelRepository?: ModelRepository,
    // #157 round-3: lets reapOrphanedInstances reach the owning worker and terminate an orphan's
    // runner process before dropping its Redis record, instead of silently leaking it. Optional
    // (like instanceRepository/modelRepository above) so existing tests that don't wire it are
    // unaffected — reapOrphanedInstances itself already no-ops without modelRepository.
    private readonly createWorkerClient?: (baseUrl: string) => WorkerClient,
    private readonly moveOrchestration?: MoveOrchestrationService,
    private readonly startupLogCapture?: StartupLogCaptureService,
  ) {
    this.clusterEventsChannel = redisKey(keyPrefix, CLUSTER_EVENTS_CHANNEL);
  }

  start(): void {
    if (this.timer) return;
    const intervalMs = this.config.reconciliationIntervalSecs * 1000;
    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMs);
    this.logger.info(
      { intervalSecs: this.config.reconciliationIntervalSecs },
      'Reconciliation loop started',
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.logger.info({}, 'Reconciliation loop stopped');
    }
  }

  async tick(): Promise<void> {
    if (!this.leaderElection.isLeader) {
      this.wasLeader = false;
      return;
    }

    if (this.running) return;
    this.running = true;

    try {
      const startedAt = Date.now();

      if (!this.wasLeader) {
        this.logger.info({}, 'Leader promotion detected — running full state rebuild');
      }
      this.wasLeader = true;

      reconciliationTicksTotal.inc();

      const workerIdsBefore = new Set(this.workerPool.getAllWorkers().map((w) => w.workerId));

      await this.safeStep('discoverWorkers', () => this.workerPool.discoverWorkers());
      await this.safeStep('checkHeartbeats', () => this.workerPool.checkHeartbeats());

      await this.safeStep('publishWorkerJoinEvents', async () => {
        for (const w of this.workerPool.getAllWorkers()) {
          if (!workerIdsBefore.has(w.workerId)) {
            await this.publishClusterEvent({
              type: ClusterEventType.WORKER_JOINED,
              workerId: w.workerId,
              timestamp: new Date().toISOString(),
              message: `Worker ${w.workerId} joined the cluster`,
            });
            this.notifications
              ?.createNotification({
                title: 'Worker joined',
                description: `Worker ${w.workerId} joined the cluster`,
                variant: 'info',
                source: { type: 'worker', name: w.workerId },
              })
              .catch(() => {});
          }
        }
      });

      await this.safeStep('handleDeadWorkers', () => this.handleDeadWorkers());
      if (!this.legacyPruneDone) {
        await this.safeStep('pruneLegacyInstanceKeys', () => this.pruneLegacyInstanceKeys());
        this.legacyPruneDone = true;
      }
      await this.safeStep('refreshMemoryBudgets', () => this.memoryBudget.refreshAll());

      await this.safeStep('publishMemoryUpdateEvent', async () => {
        const budgets = this.memoryBudget.getAllBudgets();
        if (budgets.length > 0) {
          await this.publishClusterEvent({
            type: ClusterEventType.WORKER_MEMORY_UPDATED,
            timestamp: new Date().toISOString(),
            data: { workerCount: budgets.length },
          });
        }
      });

      await this.safeStep(
        'resumeMoves',
        () => this.moveOrchestration?.resumeAll() ?? Promise.resolve(),
      );
      await this.safeStep(
        'resumeStartupLogCapture',
        () => this.startupLogCapture?.resumeIncomplete() ?? Promise.resolve(),
      );
      await this.safeStep('recoverStuckInstances', () => this.recoverStuckInstances());
      await this.safeStep('recoverAmbiguousStarts', () => this.recoverAmbiguousStarts());
      await this.safeStep('reconcileMissingRunners', () => this.reconcileMissingRunners());
      await this.safeStep('reconcileInstanceTable', () => this.reconcileInstanceTable());
      await this.safeStep('reapOrphanedInstances', () => this.reapOrphanedInstances());
      await this.safeStep('refreshMetrics', () => this.refreshMetrics());

      reconciliationTickDuration.observe((Date.now() - startedAt) / 1000);
    } finally {
      this.running = false;
    }
  }

  private async safeStep(name: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      reconciliationErrors.inc({ step: name });
      this.logger.error(
        { step: name, err: err instanceof Error ? err.message : String(err) },
        'Reconciliation step failed',
      );
    }
  }

  private async handleDeadWorkers(): Promise<void> {
    const deadWorkers = this.workerPool.getDeadWorkers();
    if (deadWorkers.length === 0) return;

    this.logger.warn(
      { count: deadWorkers.length, workerIds: deadWorkers.map((w) => w.workerId) },
      'Dead workers detected',
    );

    const allInstances = await this.lifecycle.getAllInstances();

    for (const worker of deadWorkers) {
      const workerInstances = allInstances.filter(
        (i) => i.workerId === worker.workerId && this.isActiveOrTransitional(i.state),
      );

      for (const instance of workerInstances) {
        try {
          await this.lifecycle.transition(
            instance.modelName,
            instance.instanceId,
            ModelLifecycleState.ERROR,
            { errorMessage: `Worker ${worker.workerId} is dead` },
          );
          // Remove only this instance's endpoint — other instances of the same model on a live
          // worker must keep serving traffic. removeEndpoint no-ops if the instance never had an
          // endpoint registered (e.g. it died mid-STARTING).
          if (instance.runnerHost && instance.runnerPort) {
            await this.routingMap.removeEndpoint(
              instance.modelName,
              instance.runnerHost,
              instance.runnerEnginePort ?? instance.runnerPort,
            );
          }
          await refreshModelRoutingState(this.lifecycle, this.routingMap, instance.modelName);
          await this.lifecycle.removeInstance(instance.modelName, instance.instanceId);
          await this.instanceRepository?.delete(instance.instanceId);
          this.memoryBudget.releaseInstanceReservations(instance.instanceId);
          reconciliationDeadWorkersTotal.inc();
          this.logger.info(
            {
              modelName: instance.modelName,
              instanceId: instance.instanceId,
              workerId: worker.workerId,
            },
            'Removed instance on dead worker',
          );
          this.notifications
            ?.createNotification({
              title: 'Model failed — worker lost',
              description: `${instance.modelName} (${instance.instanceId}) on ${worker.workerId}`,
              variant: 'danger',
              source: { type: 'model', name: instance.modelName },
            })
            .catch(() => {});
        } catch (err) {
          this.logger.error(
            {
              modelName: instance.modelName,
              instanceId: instance.instanceId,
              workerId: worker.workerId,
              err: err instanceof Error ? err.message : String(err),
            },
            'Failed to handle instance on dead worker',
          );
        }
      }

      await this.publishClusterEvent({
        type: ClusterEventType.WORKER_LEFT,
        workerId: worker.workerId,
        timestamp: new Date().toISOString(),
        message: `Worker ${worker.workerId} left the cluster (dead)`,
      });
      this.notifications
        ?.createNotification({
          title: 'Worker lost',
          description: `Worker ${worker.workerId} left the cluster`,
          variant: 'warning',
          source: { type: 'worker', name: worker.workerId },
        })
        .catch(() => {});
      this.workerPool.removeWorker(worker.workerId);
      this.memoryBudget.clearWorkerReservations(worker.workerId);
    }
  }

  private async recoverStuckInstances(): Promise<void> {
    const allInstances = await this.lifecycle.getAllInstances();
    const now = Date.now();

    for (const instance of allInstances) {
      const timeoutType = TRANSITIONAL_STATES.get(instance.state);
      if (timeoutType === undefined) continue;

      const timeoutSecs =
        timeoutType === 'deploy' ? this.config.deployTimeoutSecs : this.config.sleepTimeoutSecs;
      const timeoutMs = timeoutSecs * 1000;

      const stateAge = now - new Date(instance.stateChangedAt).getTime();
      if (stateAge <= timeoutMs) continue;

      try {
        await this.lifecycle.transition(
          instance.modelName,
          instance.instanceId,
          ModelLifecycleState.ERROR,
          {
            errorMessage: `Stuck in ${instance.state} for ${Math.round(stateAge / 1000)}s (timeout: ${timeoutSecs}s)`,
          },
        );
        // As with dead-worker handling: remove only this instance's endpoint, then recompute the
        // model-level aggregate — a healthy sibling replica must keep serving.
        if (instance.runnerHost && instance.runnerPort) {
          await this.routingMap.removeEndpoint(
            instance.modelName,
            instance.runnerHost,
            instance.runnerEnginePort ?? instance.runnerPort,
          );
        }
        await refreshModelRoutingState(this.lifecycle, this.routingMap, instance.modelName);
        reconciliationStuckModelsTotal.inc();
        this.logger.warn(
          {
            modelName: instance.modelName,
            instanceId: instance.instanceId,
            state: instance.state,
            stateAgeSecs: Math.round(stateAge / 1000),
            timeoutSecs,
          },
          'Recovered stuck instance',
        );
        this.notifications
          ?.createNotification({
            title: 'Model timed out',
            description: `${instance.modelName} (${instance.instanceId}) stuck in ${instance.state}`,
            variant: 'danger',
            source: { type: 'model', name: instance.modelName },
          })
          .catch(() => {});
      } catch (err) {
        this.logger.error(
          {
            modelName: instance.modelName,
            instanceId: instance.instanceId,
            state: instance.state,
            err: err instanceof Error ? err.message : String(err),
          },
          'Failed to recover stuck instance',
        );
      }
    }
  }

  /**
   * Self-heal for a control plane upgraded in place over pre-#120 Redis state: the old lifecycle
   * key shape (`{prefix}:models:{modelName}`, no instance segment) is invisible to every read
   * path now that `getAllInstances` requires a second `:`-delimited segment (see ADR-019), so it
   * would otherwise sit forever, silently disagreeing with per-model detail reads. Logs once per
   * key removed.
   */
  private async pruneLegacyInstanceKeys(): Promise<void> {
    const removed = await this.lifecycle.pruneLegacyInstanceKeys();
    for (const modelName of removed) {
      this.logger.warn(
        { modelName },
        'Removed orphaned pre-#120 Redis lifecycle key (single-segment, no instanceId) — see ADR-019',
      );
    }
  }

  /**
   * Heal divergence between the Postgres `instances` ledger and Redis runtime state. Synchronous
   * create/delete (routes/models.ts) are the primary writers of the Postgres table, so this only
   * needs to catch leaks: a Postgres row whose Redis lifecycle key no longer exists (the instance
   * was removed from Redis — by a stop, an eviction, or dead-worker/stuck-instance recovery above
   * — but its Postgres row survived, e.g. a crash between the two deletes). No-ops when the
   * repository isn't wired (older test harnesses that don't need Postgres coverage).
   */
  private async reconcileInstanceTable(): Promise<void> {
    if (!this.instanceRepository) return;

    const [pgInstances, redisInstances] = await Promise.all([
      this.instanceRepository.findAll(),
      this.lifecycle.getAllInstances(),
    ]);
    const redisIds = new Set(redisInstances.map((i) => i.instanceId));

    for (const row of pgInstances) {
      if (redisIds.has(row.instanceId)) continue;
      try {
        await this.instanceRepository.delete(row.instanceId);
        this.logger.info(
          { instanceId: row.instanceId, modelName: row.modelName },
          'Pruned orphaned instance row (no matching Redis state)',
        );
      } catch (err) {
        this.logger.error(
          {
            instanceId: row.instanceId,
            modelName: row.modelName,
            err: err instanceof Error ? err.message : String(err),
          },
          'Failed to prune orphaned instance row',
        );
      }
    }
  }

  /**
   * Heal the opposite direction of `reconcileInstanceTable`: a Redis instance whose logical
   * model has no Postgres `models` row at all. This happens when a model Delete (or Stop) leaves
   * an instance behind after its teardown fails partway through — `stopModel`'s catch transitions
   * the instance to ERROR (never reaching `removeInstance`) before rethrowing, but the model-level
   * cleanup proceeds regardless (isolated per-instance, see `teardownInstance`), so the model row
   * (and, via CASCADE, its Postgres instance row) is gone while the Redis key and VRAM reservation
   * survive. Left alone, the orphan resurfaces the deleted model in `GET /models` (state ERROR)
   * forever. Every deploy path creates the Postgres `models` row before the Redis instance
   * (`routes/models.ts` — `modelRepository.create` runs before `deployFromRecord`'s
   * `lifecycle.createInstance`), and a synchronous deploy failure rolls back in the same order
   * (Redis instance removed inside `deployFromRecord`'s catch before the model row is deleted by
   * its caller) — so a Redis instance can never legitimately exist ahead of its model row *at any
   * single instant*. But this method's two reads are not a single instant: reading both stores
   * concurrently (`Promise.all`) would let an unrelated, in-flight deploy interleave between them
   * — its Postgres row could commit and its Redis instance be written entirely inside the window
   * between the two reads, in either order relative to them, producing a false orphan (a live,
   * mid-deploy instance reaped out from under a deploy that is still running). To make the
   * instantaneous write-ordering invariant above actually apply to a two-read comparison, the reads
   * must be sequential and ordered opposite to the writes: Redis (the *last*-written store) first,
   * then Postgres (the *first*-written store) second. Any instance observed in the Redis read has
   * necessarily had its model row committed *before* that Redis write, i.e. before the Redis read
   * even started — so the later Postgres read, which starts after the Redis read completes, is
   * guaranteed to see it. Belt-and-braces: a per-candidate `findByName` re-check immediately before
   * reaping catches the row even if this ordering invariant is ever broken by future code.
   *
   * Round-3 review (#157, Medium): dropping the Redis record here is not just bookkeeping — it's
   * also the last chance to terminate the runner process. `teardownInstance` (routes/models.ts)
   * already attempts this itself and retains the record on a non-404 failure specifically so this
   * method gets another shot; when `createWorkerClient` is wired, each candidate's `stopRunner` is
   * best-effort re-attempted before its record is dropped, and a non-404 failure here skips the
   * whole cleanup for that candidate (record retained, retried next tick) rather than dropping the
   * bookkeeping while the process stays alive and VRAM stays held.
   */
  private async reapOrphanedInstances(): Promise<void> {
    if (!this.modelRepository) return;
    const modelRepository = this.modelRepository;

    const allInstances = await this.lifecycle.getAllInstances();
    const allModels = await modelRepository.findAll();
    const modelNames = new Set(allModels.map((m) => m.name));
    const orphans = allInstances.filter((i) => !modelNames.has(i.modelName));

    for (const instance of orphans) {
      try {
        // Re-check right before reaping: closes the race even if a deploy's model row committed
        // after the sequential reads above but before we get here.
        const stillOrphaned = (await modelRepository.findByName(instance.modelName)) === null;
        if (!stillOrphaned) {
          this.logger.debug(
            { modelName: instance.modelName, instanceId: instance.instanceId },
            'Skipping reap: model row now exists (race with concurrent deploy)',
          );
          continue;
        }

        // Round-3 review (Medium): before dropping this orphan's record, best-effort terminate
        // its runner process — teardownInstance's own reap can fail non-404 and retain the
        // record for exactly this step to retry, and reconciliation was previously the dead end
        // where that retained record silently vanished next tick with the process still alive.
        if (instance.workerId && instance.runnerId && this.createWorkerClient) {
          const worker = this.workerPool.getWorker(instance.workerId);
          if (worker) {
            try {
              await this.createWorkerClient(worker.managementUrl).stopRunner(instance.runnerId);
            } catch (stopErr) {
              if (stopErr instanceof WorkerHttpError && stopErr.status === 404) {
                // Already gone — fall through to the usual cleanup below.
              } else {
                this.logger.warn(
                  {
                    modelName: instance.modelName,
                    instanceId: instance.instanceId,
                    workerId: instance.workerId,
                    err: stopErr instanceof Error ? stopErr.message : String(stopErr),
                  },
                  'Failed to reap orphan runner process — retaining record for retry next tick',
                );
                continue;
              }
            }
          } else {
            this.logger.debug(
              {
                modelName: instance.modelName,
                instanceId: instance.instanceId,
                workerId: instance.workerId,
              },
              'Cannot reap orphan runner process; worker not in pool — dropping record anyway',
            );
          }
        }

        this.memoryBudget.releaseInstanceReservations(instance.instanceId);
        if (instance.runnerHost && instance.runnerPort) {
          await this.routingMap.removeEndpoint(
            instance.modelName,
            instance.runnerHost,
            instance.runnerEnginePort ?? instance.runnerPort,
          );
        }
        await this.lifecycle.removeInstance(instance.modelName, instance.instanceId);
        this.logger.info(
          { modelName: instance.modelName, instanceId: instance.instanceId },
          'Reaped orphaned Redis instance with no matching model row',
        );
      } catch (err) {
        this.logger.error(
          {
            modelName: instance.modelName,
            instanceId: instance.instanceId,
            err: err instanceof Error ? err.message : String(err),
          },
          'Failed to reap orphaned instance',
        );
      }
    }
  }

  /**
   * Runner-level reconciliation (#166): catch instances whose record still claims a runner that
   * the hosting worker no longer runs. Worker-level reconciliation (handleDeadWorkers) only sees
   * the worker's heartbeat — a worker that restarts blank under the same `workerId` stays
   * ONLINE, so a ghost ACTIVE instance on it would otherwise linger as "running" (and burn the
   * full drain timeout when stopped) until the worker finally goes OFFLINE. This step probes
   * the runner itself via the worker management API (`GET /runners/{runnerId}`) and reaps
   * instances whose runner is absent.
   *
   * Probing policy (liveness-only — no state/health assertions, so a healthy worker + live
   * runner is never flagged):
   * - worker OFFLINE or not in the pool → never probe here; handleDeadWorkers (this tick) or
   *   later ticks own OFFLINE workers. Keeps the two paths from double-cleaning the same
   *   instance and from racing each other.
   * - worker reachable, probe 404 → runner genuinely absent → full reap (same cleanup as
   *   handleDeadWorkers).
   * - worker reachable, probe failed (network / 5xx) → inconclusive (the worker API is up but
   *   something is wrong asking it) → skip, retry next tick. Reaping on a failed probe would
   *   kill genuinely live instances during a blip.
   * - instance without a `runnerId` (fresh STARTING whose startRunner has not returned yet) →
   *   skip: there is nothing to address the probe by, and the address would appear on its own
   *   once the runner is up.
   * - STARTING instances additionally get a grace window (`missingRunnerProbeGraceSecs`): a
   *   long cold-start with the worker momentarily unreachable must not be killed on the first
   *   tick after STARTING; ACTIVE instances are reaped on the first confirmed miss — a
   *   confirmed-miss ACTIVE instance serves nothing, so waiting only prolongs the wrong
   *   dashboard state.
   */
  private async reconcileMissingRunners(): Promise<void> {
    if (!this.createWorkerClient) return;
    const createWorkerClient = this.createWorkerClient;

    const allInstances = await this.lifecycle.getAllInstances();
    const candidates = allInstances.filter((i) => {
      if (!i.runnerId || !i.workerId) return false;
      if (i.state !== ModelLifecycleState.ACTIVE && i.state !== ModelLifecycleState.STARTING) {
        return false;
      }
      const worker = this.workerPool.getWorker(i.workerId);
      // OFFLINE / unknown workers are the dead-worker path's jurisdiction — see doc comment.
      if (!worker || worker.status === WorkerStatus.OFFLINE) return false;
      return true;
    });
    if (candidates.length === 0) return;

    const graceMs = this.config.missingRunnerProbeGraceSecs * 1000;
    const now = Date.now();

    for (const instance of candidates) {
      // Grace window for STARTING: a confirmed miss is only actionable once the start has had
      // its full deploy budget to be a problem (fresh cold-starts skip entirely until then).
      if (
        instance.state === ModelLifecycleState.STARTING &&
        now - new Date(instance.stateChangedAt).getTime() <= graceMs
      ) {
        continue;
      }

      try {
        const workerId = instance.workerId;
        const runnerId = instance.runnerId;
        // Re-narrow: the `candidates` filter above already excluded null workerId/runnerId, but
        // that narrowing does not survive the loop, so guard again before use.
        if (!workerId || !runnerId) continue;
        const worker = this.workerPool.getWorker(workerId)!;
        let present: boolean;
        try {
          present = await createWorkerClient(worker.managementUrl).getRunner(runnerId);
        } catch (probeErr) {
          // Inconclusive — the worker's management API answered (it is ONLINE) but the probe
          // itself failed. Treat "could not ask" as not-yet-confirmed and retry next tick.
          this.logger.warn(
            {
              modelName: instance.modelName,
              instanceId: instance.instanceId,
              workerId: instance.workerId,
              runnerId: instance.runnerId,
              err: probeErr instanceof Error ? probeErr.message : String(probeErr),
            },
            'Runner liveness probe failed — skipping reap, will retry next tick',
          );
          continue;
        }
        if (present) continue;

        this.logger.warn(
          {
            modelName: instance.modelName,
            instanceId: instance.instanceId,
            workerId: instance.workerId,
            runnerId: instance.runnerId,
            state: instance.state,
          },
          'Runner no longer hosted by its worker — reaping instance record',
        );

        await this.lifecycle.transition(
          instance.modelName,
          instance.instanceId,
          ModelLifecycleState.ERROR,
          {
            errorMessage: `Runner ${instance.runnerId} no longer hosted by worker ${instance.workerId}`,
          },
        );
        if (instance.runnerHost && instance.runnerPort) {
          await this.routingMap.removeEndpoint(
            instance.modelName,
            instance.runnerHost,
            instance.runnerEnginePort ?? instance.runnerPort,
          );
        }
        await refreshModelRoutingState(this.lifecycle, this.routingMap, instance.modelName);
        await this.lifecycle.removeInstance(instance.modelName, instance.instanceId);
        await this.instanceRepository?.delete(instance.instanceId);
        this.memoryBudget.releaseInstanceReservations(instance.instanceId);
        reconciliationMissingRunnersTotal.inc();
        this.logger.info(
          {
            modelName: instance.modelName,
            instanceId: instance.instanceId,
            workerId: instance.workerId,
            runnerId: instance.runnerId,
          },
          'Removed instance whose runner is missing on a live worker',
        );
        this.notifications
          ?.createNotification({
            title: 'Model failed — runner lost',
            description: `${instance.modelName} (${instance.instanceId}) on ${instance.workerId}`,
            variant: 'danger',
            source: { type: 'model', name: instance.modelName },
          })
          .catch(() => {});
      } catch (err) {
        // Per-instance isolation: one failed cleanup must not stop the rest of the tick — and
        // the instance stays for the next tick, so a transient Redis error is self-healing.
        this.logger.error(
          {
            modelName: instance.modelName,
            instanceId: instance.instanceId,
            workerId: instance.workerId,
            runnerId: instance.runnerId,
            err: err instanceof Error ? err.message : String(err),
          },
          'Failed to handle instance with missing runner',
        );
      }
    }
  }

  /**
   * Resolve POST /runners transport failures by the stable control-plane instance id. Capacity
   * stays held during the full deploy grace only when the worker reports ABSENT: an early 404
   * could merely mean the worker has not entered its handler yet. READY is explicitly stopped as
   * soon as it is discoverable; STARTING and inconclusive probes remain for the next tick.
   */
  private async recoverAmbiguousStarts(): Promise<void> {
    if (!this.createWorkerClient) return;
    const graceMs = this.config.missingRunnerProbeGraceSecs * 1000;
    const now = Date.now();
    const candidates = (await this.lifecycle.getAllInstances()).filter(
      (instance) =>
        instance.state === ModelLifecycleState.ERROR &&
        instance.runnerStartAmbiguous === true &&
        instance.workerId !== null,
    );

    for (const instance of candidates) {
      try {
        const worker = this.workerPool.getWorker(instance.workerId!);
        if (!worker || worker.status === WorkerStatus.OFFLINE) continue;
        const client = this.createWorkerClient(worker.managementUrl);
        const lookup = await client.getRunnerByInstance(instance.instanceId);
        if (lookup.status === 'starting') continue;
        if (
          lookup.status === 'absent' &&
          now - new Date(instance.stateChangedAt).getTime() <= graceMs
        ) {
          continue;
        }
        if (lookup.status === 'ready') {
          try {
            await client.stopRunner(lookup.runnerId);
          } catch (err) {
            if (!(err instanceof WorkerHttpError && err.status === 404)) throw err;
          }
        }

        if (instance.runnerHost && instance.runnerPort) {
          await this.routingMap.removeEndpoint(
            instance.modelName,
            instance.runnerHost,
            instance.runnerEnginePort ?? instance.runnerPort,
          );
        }
        await this.lifecycle.removeInstance(instance.modelName, instance.instanceId);
        await this.instanceRepository?.delete(instance.instanceId);
        this.memoryBudget.releaseInstanceReservations(instance.instanceId);
        await refreshModelRoutingState(this.lifecycle, this.routingMap, instance.modelName);
        this.logger.info(
          {
            modelName: instance.modelName,
            instanceId: instance.instanceId,
            workerId: instance.workerId,
            recoveredStatus: lookup.status,
          },
          'Reconciled ambiguous runner start',
        );
      } catch (err) {
        this.logger.warn(
          {
            modelName: instance.modelName,
            instanceId: instance.instanceId,
            workerId: instance.workerId,
            err: err instanceof Error ? err.message : String(err),
          },
          'Ambiguous runner start remains unresolved; retaining capacity for retry',
        );
      }
    }
  }

  private async refreshMetrics(): Promise<void> {
    const allInstances = await this.lifecycle.getAllInstances();
    const stateCounts = new Map<string, number>();
    for (const state of Object.values(ModelLifecycleState)) {
      stateCounts.set(state, 0);
    }
    for (const instance of allInstances) {
      stateCounts.set(instance.state, (stateCounts.get(instance.state) ?? 0) + 1);
    }
    for (const [state, count] of stateCounts) {
      // Counts are now per-instance rather than per-logical-model (#120): a model with two ACTIVE
      // replicas contributes 2 to the ACTIVE count, not 1.
      modelsTotal.set({ state }, count);
    }

    const allWorkers = this.workerPool.getAllWorkers();
    const statusCounts = new Map<string, number>();
    for (const status of Object.values(WorkerStatus)) {
      statusCounts.set(status, 0);
    }
    for (const worker of allWorkers) {
      statusCounts.set(worker.status, (statusCounts.get(worker.status) ?? 0) + 1);
    }
    for (const [status, count] of statusCounts) {
      workersTotal.set({ status }, count);
    }

    const allBudgets = this.memoryBudget.getAllBudgets();
    for (const budget of allBudgets) {
      if (budget.stale) continue;
      for (const device of budget.devices) {
        const deviceIndex = String(device.deviceIndex);
        deviceMemoryBytes.set(
          { worker_id: budget.workerId, device_index: deviceIndex, state: 'total' },
          device.totalBytes,
        );
        deviceMemoryBytes.set(
          { worker_id: budget.workerId, device_index: deviceIndex, state: 'used' },
          device.usedBytes,
        );
        deviceMemoryBytes.set(
          { worker_id: budget.workerId, device_index: deviceIndex, state: 'available' },
          device.availableBytes,
        );
      }
    }
  }

  private async publishClusterEvent(event: ClusterEvent): Promise<void> {
    try {
      await this.redis.publish(this.clusterEventsChannel, JSON.stringify(event));
    } catch (err) {
      this.logger.error(
        { eventType: event.type, err: err instanceof Error ? err.message : String(err) },
        'Failed to publish cluster event',
      );
    }
  }

  private isActiveOrTransitional(state: ModelLifecycleState): boolean {
    return state !== ModelLifecycleState.STOPPED && state !== ModelLifecycleState.ERROR;
  }
}
