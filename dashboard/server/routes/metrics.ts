import type { FastifyInstance } from 'fastify';
import { BffError } from '../errors.js';
import type { RouteDeps } from './deps.js';

const DEFAULT_STEP = '15s';
const ONE_HOUR_MS = 3_600_000;
const MIN_OPERATIONS_WINDOW_SECONDS = 60;

const OPERATIONS = ['deploy', 'sleep', 'wake', 'eviction', 'placement'] as const;
type Operation = (typeof OPERATIONS)[number];

interface OperationDuration {
  operation: Operation;
  averageSeconds: number | null;
  count: number;
}

function defaultStart(): string {
  return new Date(Date.now() - ONE_HOUR_MS).toISOString();
}

function defaultEnd(): string {
  return new Date().toISOString();
}

/** Parses a scalar value out of an instant-query vector result; absent → 0. */
function scalarFromInstant(data: unknown): number {
  if (typeof data !== 'object' || data === null) return 0;
  const d = data as Record<string, unknown>;
  const result = (d['data'] as Record<string, unknown> | undefined)?.['result'];
  if (!Array.isArray(result) || result.length === 0) return 0;
  const first = result[0] as Record<string, unknown> | undefined;
  const value = first?.['value'];
  if (!Array.isArray(value) || value.length < 2) return 0;
  const parsed = parseFloat(String(value[1]));
  return Number.isFinite(parsed) ? parsed : 0;
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
          'histogram_quantile(0.50, sum by (le) (rate(sardeenz_proxy_request_duration_seconds_bucket[5m])))',
          start,
          end,
          step,
        ),
        deps.prometheus.queryRange(
          'histogram_quantile(0.95, sum by (le) (rate(sardeenz_proxy_request_duration_seconds_bucket[5m])))',
          start,
          end,
          step,
        ),
        deps.prometheus.queryRange(
          'histogram_quantile(0.99, sum by (le) (rate(sardeenz_proxy_request_duration_seconds_bucket[5m])))',
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
          'histogram_quantile(0.50, sum by (le) (rate(sardeenz_proxy_parking_duration_seconds_bucket[5m])))',
          start,
          end,
          step,
        ),
        deps.prometheus.queryRange(
          'histogram_quantile(0.95, sum by (le) (rate(sardeenz_proxy_parking_duration_seconds_bucket[5m])))',
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

  // GET /api/metrics/operations — average duration and count for deploy/sleep/wake/eviction/placement
  app.get(
    '/api/metrics/operations',
    { preHandler: [app.authenticate, app.requireRole('admin-readonly')] },
    async (request, reply) => {
      const q = request.query as Record<string, string>;
      const startStr = q['start'] ?? defaultStart();
      const endStr = q['end'] ?? defaultEnd();
      const startMs = Date.parse(startStr);
      const endMs = Date.parse(endStr);
      if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
        throw BffError.invalidRequest('start and end must be valid dates');
      }
      const windowSeconds = Math.max(
        Math.round((endMs - startMs) / 1000),
        MIN_OPERATIONS_WINDOW_SECONDS,
      );
      const window = `${windowSeconds.toString()}s`;

      const results = await Promise.all(
        OPERATIONS.map(async (operation) => {
          const [sumResult, countResult] = await Promise.all([
            deps.prometheus.queryInstant(
              `sum(increase(sardeenz_control_plane_${operation}_duration_seconds_sum[${window}]))`,
              endStr,
            ),
            deps.prometheus.queryInstant(
              `sum(increase(sardeenz_control_plane_${operation}_duration_seconds_count[${window}]))`,
              endStr,
            ),
          ]);
          const sum = scalarFromInstant(sumResult);
          // increase() extrapolates over the window, so the count can be fractional; the
          // average uses the raw ratio while the reported count is a whole number of operations.
          const rawCount = scalarFromInstant(countResult);
          const operationDuration: OperationDuration = {
            operation,
            averageSeconds: rawCount > 0 ? sum / rawCount : null,
            count: rawCount > 0 ? Math.max(1, Math.round(rawCount)) : 0,
          };
          return operationDuration;
        }),
      );

      return reply.send({ operations: results });
    },
  );
}
