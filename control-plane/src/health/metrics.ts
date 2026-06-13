import { Registry, Gauge, Counter, Histogram, collectDefaultMetrics } from 'prom-client';
import type { FastifyInstance } from 'fastify';

export const registry = new Registry();

collectDefaultMetrics({ register: registry });

export const modelsTotal = new Gauge({
  name: 'sardeenz_control_plane_models_total',
  help: 'Number of models by state',
  labelNames: ['state'] as const,
  registers: [registry],
});

export const workersTotal = new Gauge({
  name: 'sardeenz_control_plane_workers_total',
  help: 'Number of registered workers by status',
  labelNames: ['status'] as const,
  registers: [registry],
});

export const deviceMemoryBytes = new Gauge({
  name: 'sardeenz_control_plane_device_memory_bytes',
  help: 'Device memory by worker and state',
  labelNames: ['worker_id', 'state'] as const,
  registers: [registry],
});

export const placementDuration = new Histogram({
  name: 'sardeenz_control_plane_placement_duration_seconds',
  help: 'Time to complete placement pipeline',
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export const evictionsTotal = new Counter({
  name: 'sardeenz_control_plane_evictions_total',
  help: 'Evictions triggered',
  labelNames: ['reason'] as const,
  registers: [registry],
});

export const evictionDuration = new Histogram({
  name: 'sardeenz_control_plane_eviction_duration_seconds',
  help: 'Time to complete eviction cycle',
  buckets: [0.1, 0.5, 1, 5, 10, 30, 60],
  registers: [registry],
});

export const sleepDuration = new Histogram({
  name: 'sardeenz_control_plane_sleep_duration_seconds',
  help: 'Time for runner sleep operation',
  buckets: [0.5, 1, 5, 10, 30, 60, 120, 300],
  registers: [registry],
});

export const wakeDuration = new Histogram({
  name: 'sardeenz_control_plane_wake_duration_seconds',
  help: 'Time for runner wake operation',
  buckets: [0.5, 1, 5, 10, 30, 60, 120, 300],
  registers: [registry],
});

export const deployDuration = new Histogram({
  name: 'sardeenz_control_plane_deploy_duration_seconds',
  help: 'Time for full deploy orchestration (start runner to ACTIVE)',
  buckets: [1, 5, 10, 30, 60, 120, 300, 600],
  registers: [registry],
});

export const deployTriggersTotal = new Counter({
  name: 'sardeenz_control_plane_deploy_triggers_total',
  help: 'Deploy orchestrations initiated',
  registers: [registry],
});

export const wakeTriggersTotal = new Counter({
  name: 'sardeenz_control_plane_wake_triggers_total',
  help: 'Wake triggers received from proxy',
  registers: [registry],
});

export const stateTransitionsTotal = new Counter({
  name: 'sardeenz_control_plane_state_transitions_total',
  help: 'Model state transitions',
  labelNames: ['from', 'to'] as const,
  registers: [registry],
});

export const leaderIsLeader = new Gauge({
  name: 'sardeenz_control_plane_leader_is_leader',
  help: '1 if this instance is the leader, 0 otherwise',
  registers: [registry],
});

export const runnerHealthCheckErrorsTotal = new Counter({
  name: 'sardeenz_control_plane_runner_health_check_errors_total',
  help: 'Failed runner health checks',
  registers: [registry],
});

export const reconciliationTicksTotal = new Counter({
  name: 'sardeenz_control_plane_reconciliation_ticks_total',
  help: 'Total reconciliation ticks executed',
  registers: [registry],
});

export const reconciliationDeadWorkersTotal = new Counter({
  name: 'sardeenz_control_plane_reconciliation_dead_workers_total',
  help: 'Dead workers cleaned up by reconciliation',
  registers: [registry],
});

export const reconciliationStuckModelsTotal = new Counter({
  name: 'sardeenz_control_plane_reconciliation_stuck_models_total',
  help: 'Stuck models recovered by reconciliation',
  registers: [registry],
});

export const reconciliationErrors = new Counter({
  name: 'sardeenz_control_plane_reconciliation_errors_total',
  help: 'Reconciliation step errors',
  labelNames: ['step'] as const,
  registers: [registry],
});

export const reconciliationTickDuration = new Histogram({
  name: 'sardeenz_control_plane_reconciliation_tick_duration_seconds',
  help: 'Time for a single reconciliation tick',
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export function registerMetricsRoute(app: FastifyInstance): void {
  app.get('/metrics', async (_req, reply) => {
    const metrics = await registry.metrics();
    return reply.header('Content-Type', registry.contentType).send(metrics);
  });
}
