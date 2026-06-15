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
  // GET /api/metrics/latency — p95 proxy request latency over the selected range
  app.get('/api/metrics/latency', async (request, reply) => {
    const q = request.query as Record<string, string>;
    const result = await deps.prometheus.queryRange(
      'histogram_quantile(0.95, rate(sardeenz_proxy_request_duration_seconds_bucket[5m]))',
      q['start'] ?? defaultStart(),
      q['end'] ?? defaultEnd(),
      q['step'] ?? DEFAULT_STEP,
    );
    return reply.send(result);
  });

  // GET /api/metrics/throughput — request rate over the selected range
  app.get('/api/metrics/throughput', async (request, reply) => {
    const q = request.query as Record<string, string>;
    const result = await deps.prometheus.queryRange(
      'rate(sardeenz_proxy_requests_total[5m])',
      q['start'] ?? defaultStart(),
      q['end'] ?? defaultEnd(),
      q['step'] ?? DEFAULT_STEP,
    );
    return reply.send(result);
  });

  // GET /api/metrics/memory — current device memory usage (instant query)
  app.get('/api/metrics/memory', async (_request, reply) => {
    const result = await deps.prometheus.queryInstant('sardeenz_control_plane_device_memory_bytes');
    return reply.send(result);
  });
}
