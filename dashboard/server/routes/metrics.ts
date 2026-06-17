import type { FastifyInstance } from 'fastify';
import type { RouteDeps } from './deps.js';

const DEFAULT_STEP = '15s';
const ONE_HOUR_MS = 3_600_000;

function defaultStart(): string {
  return new Date(Date.now() - ONE_HOUR_MS).toISOString();
}

function defaultEnd(): string {
  return new Date().toISOString();
}

export function registerMetricsRoutes(app: FastifyInstance, deps: RouteDeps): void {
  // GET /api/metrics/latency — p50/p95/p99 proxy request latency over the selected range
  app.get(
    '/api/metrics/latency',
    { preHandler: [app.authenticate, app.requireRole('admin-readonly')] },
    async (request, reply) => {
      const q = request.query as Record<string, string>;
      const start = q['start'] ?? defaultStart();
      const end = q['end'] ?? defaultEnd();
      const step = q['step'] ?? DEFAULT_STEP;
      const [p50, p95, p99] = await Promise.all([
        deps.prometheus.queryRange(
          'histogram_quantile(0.50, rate(sardeenz_proxy_request_duration_seconds_bucket[5m]))',
          start,
          end,
          step,
        ),
        deps.prometheus.queryRange(
          'histogram_quantile(0.95, rate(sardeenz_proxy_request_duration_seconds_bucket[5m]))',
          start,
          end,
          step,
        ),
        deps.prometheus.queryRange(
          'histogram_quantile(0.99, rate(sardeenz_proxy_request_duration_seconds_bucket[5m]))',
          start,
          end,
          step,
        ),
      ]);
      return reply.send({ p50, p95, p99 });
    },
  );

  // GET /api/metrics/throughput — request rate over the selected range
  app.get(
    '/api/metrics/throughput',
    { preHandler: [app.authenticate, app.requireRole('admin-readonly')] },
    async (request, reply) => {
      const q = request.query as Record<string, string>;
      const result = await deps.prometheus.queryRange(
        'rate(sardeenz_proxy_requests_total[5m])',
        q['start'] ?? defaultStart(),
        q['end'] ?? defaultEnd(),
        q['step'] ?? DEFAULT_STEP,
      );
      return reply.send(result);
    },
  );

  // GET /api/metrics/memory — current device memory usage (instant query)
  app.get(
    '/api/metrics/memory',
    { preHandler: [app.authenticate, app.requireRole('admin-readonly')] },
    async (_request, reply) => {
      const result = await deps.prometheus.queryInstant(
        'sardeenz_control_plane_device_memory_bytes',
      );
      return reply.send(result);
    },
  );

  // GET /api/metrics/connections — active and parked connection gauges over time
  app.get(
    '/api/metrics/connections',
    { preHandler: [app.authenticate, app.requireRole('admin-readonly')] },
    async (request, reply) => {
      const q = request.query as Record<string, string>;
      const start = q['start'] ?? defaultStart();
      const end = q['end'] ?? defaultEnd();
      const step = q['step'] ?? DEFAULT_STEP;
      const [active, parked] = await Promise.all([
        deps.prometheus.queryRange('sardeenz_proxy_active_connections', start, end, step),
        deps.prometheus.queryRange('sardeenz_proxy_parked_connections', start, end, step),
      ]);
      return reply.send({ active, parked });
    },
  );

  // GET /api/metrics/parking-duration — p50/p95 parking wait time
  app.get(
    '/api/metrics/parking-duration',
    { preHandler: [app.authenticate, app.requireRole('admin-readonly')] },
    async (request, reply) => {
      const q = request.query as Record<string, string>;
      const start = q['start'] ?? defaultStart();
      const end = q['end'] ?? defaultEnd();
      const step = q['step'] ?? DEFAULT_STEP;
      const [p50, p95] = await Promise.all([
        deps.prometheus.queryRange(
          'histogram_quantile(0.50, rate(sardeenz_proxy_parking_duration_seconds_bucket[5m]))',
          start,
          end,
          step,
        ),
        deps.prometheus.queryRange(
          'histogram_quantile(0.95, rate(sardeenz_proxy_parking_duration_seconds_bucket[5m]))',
          start,
          end,
          step,
        ),
      ]);
      return reply.send({ p50, p95 });
    },
  );

  // GET /api/metrics/wake-triggers — rate of wake triggers from the control plane
  app.get(
    '/api/metrics/wake-triggers',
    { preHandler: [app.authenticate, app.requireRole('admin-readonly')] },
    async (request, reply) => {
      const q = request.query as Record<string, string>;
      const result = await deps.prometheus.queryRange(
        'rate(sardeenz_control_plane_wake_triggers_total[5m])',
        q['start'] ?? defaultStart(),
        q['end'] ?? defaultEnd(),
        q['step'] ?? DEFAULT_STEP,
      );
      return reply.send(result);
    },
  );

  // GET /api/metrics/state-transitions — rate of model state transitions
  app.get(
    '/api/metrics/state-transitions',
    { preHandler: [app.authenticate, app.requireRole('admin-readonly')] },
    async (request, reply) => {
      const q = request.query as Record<string, string>;
      const result = await deps.prometheus.queryRange(
        'rate(sardeenz_control_plane_state_transitions_total[5m])',
        q['start'] ?? defaultStart(),
        q['end'] ?? defaultEnd(),
        q['step'] ?? DEFAULT_STEP,
      );
      return reply.send(result);
    },
  );

  // GET /api/metrics/evictions — rate of evictions by reason
  app.get(
    '/api/metrics/evictions',
    { preHandler: [app.authenticate, app.requireRole('admin-readonly')] },
    async (request, reply) => {
      const q = request.query as Record<string, string>;
      const result = await deps.prometheus.queryRange(
        'rate(sardeenz_control_plane_evictions_total[5m])',
        q['start'] ?? defaultStart(),
        q['end'] ?? defaultEnd(),
        q['step'] ?? DEFAULT_STEP,
      );
      return reply.send(result);
    },
  );

  // GET /api/metrics/memory-history — device memory bytes over time (range query)
  app.get(
    '/api/metrics/memory-history',
    { preHandler: [app.authenticate, app.requireRole('admin-readonly')] },
    async (request, reply) => {
      const q = request.query as Record<string, string>;
      const result = await deps.prometheus.queryRange(
        'sardeenz_control_plane_device_memory_bytes',
        q['start'] ?? defaultStart(),
        q['end'] ?? defaultEnd(),
        q['step'] ?? DEFAULT_STEP,
      );
      return reply.send(result);
    },
  );

  // GET /api/metrics/operations — p95 duration for deploy/sleep/wake/eviction/placement
  app.get(
    '/api/metrics/operations',
    { preHandler: [app.authenticate, app.requireRole('admin-readonly')] },
    async (request, reply) => {
      const q = request.query as Record<string, string>;
      const start = q['start'] ?? defaultStart();
      const end = q['end'] ?? defaultEnd();
      const step = q['step'] ?? DEFAULT_STEP;
      const [deploy, sleep, wake, eviction, placement] = await Promise.all([
        deps.prometheus.queryRange(
          'histogram_quantile(0.95, rate(sardeenz_control_plane_deploy_duration_seconds_bucket[5m]))',
          start,
          end,
          step,
        ),
        deps.prometheus.queryRange(
          'histogram_quantile(0.95, rate(sardeenz_control_plane_sleep_duration_seconds_bucket[5m]))',
          start,
          end,
          step,
        ),
        deps.prometheus.queryRange(
          'histogram_quantile(0.95, rate(sardeenz_control_plane_wake_duration_seconds_bucket[5m]))',
          start,
          end,
          step,
        ),
        deps.prometheus.queryRange(
          'histogram_quantile(0.95, rate(sardeenz_control_plane_eviction_duration_seconds_bucket[5m]))',
          start,
          end,
          step,
        ),
        deps.prometheus.queryRange(
          'histogram_quantile(0.95, rate(sardeenz_control_plane_placement_duration_seconds_bucket[5m]))',
          start,
          end,
          step,
        ),
      ]);
      return reply.send({ deploy, sleep, wake, eviction, placement });
    },
  );
}
