// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { registerMetricsRoutes } from '../../routes/metrics.js';
import { authPlugin } from '../../plugins/auth.js';
import { BffError } from '../../errors.js';
import type { RouteDeps } from '../../routes/deps.js';
import type { Config } from '../../config.js';

const mockConfig: Config = {
  listenAddr: '0.0.0.0',
  listenPort: 4000,
  logLevel: 'silent',
  controlPlaneUrl: 'http://cp.test',
  redisUrl: 'redis://localhost:6379',
  redisKeyPrefix: 'sardeenz',
  prometheusUrl: 'http://prom.test',
  inferenceUrl: 'http://inference.test',
  maxConcurrentInferenceRequestsPerUser: 4,
  authMode: 'none',
  adminUsername: 'admin',
  adminPassword: '',
  jwtSecret: '',
  jwtExpirationHours: 8,
  oauthClientId: 'sardeenz',
  oauthClientSecret: '',
  oauthIssuerUrl: '',
  k8sApiUrl: '',
  namespace: 'sardeenz',
  controlPlaneApiToken: '',
  publicUrl: '',
};

const queryRangeFn = vi.fn();
const queryInstantFn = vi.fn();

function buildDeps(): RouteDeps {
  return {
    config: mockConfig,
    controlPlane: {
      proxyRequest: vi.fn(),
      listModels: vi.fn(),
      getModel: vi.fn(),
      deployModel: vi.fn(),
      deleteModel: vi.fn(),
      sleepModel: vi.fn(),
      wakeModel: vi.fn(),
      listWorkers: vi.fn(),
      getWorker: vi.fn(),
      getClusterStatus: vi.fn(),
      getClusterMemory: vi.fn(),
      isHealthy: vi.fn(),
    } as unknown as RouteDeps['controlPlane'],
    redis: {
      listModels: vi.fn(),
      getModel: vi.fn(),
      getModelNames: vi.fn(),
      listWorkers: vi.fn(),
      getClusterStatus: vi.fn(),
      createSubscriber: vi.fn(),
      isHealthy: vi.fn(),
      keyPrefix: 'sardeenz',
      close: vi.fn(),
    } as unknown as RouteDeps['redis'],
    prometheus: {
      queryRange: queryRangeFn,
      queryInstant: queryInstantFn,
      isHealthy: vi.fn(),
    } as unknown as RouteDeps['prometheus'],
    inference: {
      chatCompletions: vi.fn(),
      isHealthy: vi.fn(),
    } as unknown as RouteDeps['inference'],
  };
}

async function buildApp(deps: RouteDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof BffError) {
      return reply.code(error.statusCode).send(error.toResponse());
    }
    return reply.code(500).send({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });
  await app.register(authPlugin, { config: mockConfig });
  registerMetricsRoutes(app, deps);
  await app.ready();
  return app;
}

describe('GET /api/metrics/memory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('queries sardeenz_control_plane_device_memory_bytes — not the old misnamed metric', async () => {
    queryInstantFn.mockResolvedValue({
      status: 'success',
      data: { resultType: 'vector', result: [] },
    });

    const app = await buildApp(buildDeps());
    await app.inject({ method: 'GET', url: '/api/metrics/memory' });
    await app.close();

    // The query must use the control-plane-prefixed name that the control plane actually exports.
    // The old bug used 'sardeenz_device_memory_bytes' which does not exist in the control plane.
    expect(queryInstantFn).toHaveBeenCalledWith('sardeenz_control_plane_device_memory_bytes');
    expect(queryInstantFn).not.toHaveBeenCalledWith('sardeenz_device_memory_bytes');
  });

  it('returns the Prometheus response body to the caller', async () => {
    const promResponse = {
      status: 'success',
      data: { resultType: 'vector', result: [{ metric: {}, value: [1, '1024'] }] },
    };
    queryInstantFn.mockResolvedValue(promResponse);

    const app = await buildApp(buildDeps());
    const res = await app.inject({ method: 'GET', url: '/api/metrics/memory' });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(promResponse);
  });

  it('returns 502 when Prometheus is unreachable', async () => {
    queryInstantFn.mockRejectedValue(
      new BffError(502, 'PROMETHEUS_ERROR', 'Prometheus unreachable'),
    );

    const app = await buildApp(buildDeps());
    const res = await app.inject({ method: 'GET', url: '/api/metrics/memory' });
    await app.close();

    expect(res.statusCode).toBe(502);
  });
});

describe('GET /api/metrics/latency', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('queries sardeenz_proxy_request_duration_seconds_bucket — matching the Rust proxy export', async () => {
    queryRangeFn.mockResolvedValue({
      status: 'success',
      data: { resultType: 'matrix', result: [] },
    });

    const app = await buildApp(buildDeps());
    await app.inject({ method: 'GET', url: '/api/metrics/latency' });
    await app.close();

    // The Rust proxy describes 'sardeenz_proxy_request_duration_seconds' as a histogram.
    // Prometheus appends _bucket/_count/_sum suffixes, so the PromQL query must reference
    // sardeenz_proxy_request_duration_seconds_bucket for histogram_quantile.
    const [query] = queryRangeFn.mock.calls[0] as [string, ...unknown[]];
    expect(query).toContain('sardeenz_proxy_request_duration_seconds_bucket');
    expect(query).toContain('histogram_quantile');
  });

  it('passes start, end, step query params to Prometheus', async () => {
    queryRangeFn.mockResolvedValue({
      status: 'success',
      data: { resultType: 'matrix', result: [] },
    });

    const app = await buildApp(buildDeps());
    await app.inject({
      method: 'GET',
      url: '/api/metrics/latency?start=2026-01-01T00:00:00Z&end=2026-01-01T01:00:00Z&step=30s',
    });
    await app.close();

    const [, start, end, step] = queryRangeFn.mock.calls[0] as [string, string, string, string];
    expect(start).toBe('2026-01-01T00:00:00Z');
    expect(end).toBe('2026-01-01T01:00:00Z');
    expect(step).toBe('30s');
  });

  it('uses default time range and step when query params are absent', async () => {
    queryRangeFn.mockResolvedValue({
      status: 'success',
      data: { resultType: 'matrix', result: [] },
    });

    const app = await buildApp(buildDeps());
    await app.inject({ method: 'GET', url: '/api/metrics/latency' });
    await app.close();

    const [, , , step] = queryRangeFn.mock.calls[0] as [string, string, string, string];
    expect(step).toBe('15s');
  });

  it('returns 502 when Prometheus is unreachable', async () => {
    queryRangeFn.mockRejectedValue(new BffError(502, 'PROMETHEUS_ERROR', 'Prometheus unreachable'));

    const app = await buildApp(buildDeps());
    const res = await app.inject({ method: 'GET', url: '/api/metrics/latency' });
    await app.close();

    expect(res.statusCode).toBe(502);
  });
});

describe('GET /api/metrics/throughput', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('queries sardeenz_proxy_requests_total — matching the Rust proxy export', async () => {
    queryRangeFn.mockResolvedValue({
      status: 'success',
      data: { resultType: 'matrix', result: [] },
    });

    const app = await buildApp(buildDeps());
    await app.inject({ method: 'GET', url: '/api/metrics/throughput' });
    await app.close();

    // The Rust proxy exports 'sardeenz_proxy_requests_total' as a counter.
    // The BFF wraps it in rate() to produce a per-second throughput.
    const [query] = queryRangeFn.mock.calls[0] as [string, ...unknown[]];
    expect(query).toContain('sardeenz_proxy_requests_total');
    expect(query).toContain('rate(');
  });

  it('passes start, end, step query params to Prometheus', async () => {
    queryRangeFn.mockResolvedValue({
      status: 'success',
      data: { resultType: 'matrix', result: [] },
    });

    const app = await buildApp(buildDeps());
    await app.inject({
      method: 'GET',
      url: '/api/metrics/throughput?start=2026-06-01T00:00:00Z&end=2026-06-01T02:00:00Z&step=60s',
    });
    await app.close();

    const [, start, end, step] = queryRangeFn.mock.calls[0] as [string, string, string, string];
    expect(start).toBe('2026-06-01T00:00:00Z');
    expect(end).toBe('2026-06-01T02:00:00Z');
    expect(step).toBe('60s');
  });

  it('returns the Prometheus response body to the caller', async () => {
    const promResponse = { status: 'success', data: { resultType: 'matrix', result: [] } };
    queryRangeFn.mockResolvedValue(promResponse);

    const app = await buildApp(buildDeps());
    const res = await app.inject({ method: 'GET', url: '/api/metrics/throughput' });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(promResponse);
  });

  it('returns 502 when Prometheus is unreachable', async () => {
    queryRangeFn.mockRejectedValue(new BffError(502, 'PROMETHEUS_ERROR', 'Prometheus unreachable'));

    const app = await buildApp(buildDeps());
    const res = await app.inject({ method: 'GET', url: '/api/metrics/throughput' });
    await app.close();

    expect(res.statusCode).toBe(502);
  });
});

describe('GET /api/metrics/latency (multi-quantile)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('queries p50, p95, and p99 quantiles in parallel and returns combined object', async () => {
    const promResponse = { status: 'success', data: { resultType: 'matrix', result: [] } };
    queryRangeFn.mockResolvedValue(promResponse);

    const app = await buildApp(buildDeps());
    const res = await app.inject({ method: 'GET', url: '/api/metrics/latency' });
    await app.close();

    expect(res.statusCode).toBe(200);
    // Three parallel queries should have been made
    expect(queryRangeFn).toHaveBeenCalledTimes(3);
    const queries = (queryRangeFn.mock.calls as [string, ...unknown[]][]).map(([q]) => q);
    expect(queries.some((q) => q.includes('0.50'))).toBe(true);
    expect(queries.some((q) => q.includes('0.95'))).toBe(true);
    expect(queries.some((q) => q.includes('0.99'))).toBe(true);
    // Response must be an object with p50/p95/p99 keys
    expect(res.json()).toHaveProperty('p50');
    expect(res.json()).toHaveProperty('p95');
    expect(res.json()).toHaveProperty('p99');
  });

  it('passes start, end, step to each quantile query', async () => {
    queryRangeFn.mockResolvedValue({
      status: 'success',
      data: { resultType: 'matrix', result: [] },
    });

    const app = await buildApp(buildDeps());
    await app.inject({
      method: 'GET',
      url: '/api/metrics/latency?start=2026-01-01T00:00:00Z&end=2026-01-01T01:00:00Z&step=30s',
    });
    await app.close();

    for (const call of queryRangeFn.mock.calls as [string, string, string, string][]) {
      const [, start, end, step] = call;
      expect(start).toBe('2026-01-01T00:00:00Z');
      expect(end).toBe('2026-01-01T01:00:00Z');
      expect(step).toBe('30s');
    }
  });

  it('returns 502 when any Prometheus query fails', async () => {
    queryRangeFn.mockRejectedValue(new BffError(502, 'PROMETHEUS_ERROR', 'Prometheus unreachable'));

    const app = await buildApp(buildDeps());
    const res = await app.inject({ method: 'GET', url: '/api/metrics/latency' });
    await app.close();

    expect(res.statusCode).toBe(502);
  });
});

describe('GET /api/metrics/connections', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('queries sardeenz_proxy_active_connections and sardeenz_proxy_parked_connections', async () => {
    queryRangeFn.mockResolvedValue({
      status: 'success',
      data: { resultType: 'matrix', result: [] },
    });

    const app = await buildApp(buildDeps());
    await app.inject({ method: 'GET', url: '/api/metrics/connections' });
    await app.close();

    const queries = (queryRangeFn.mock.calls as [string, ...unknown[]][]).map(([q]) => q);
    expect(queries.some((q) => q.includes('sardeenz_proxy_active_connections'))).toBe(true);
    expect(queries.some((q) => q.includes('sardeenz_proxy_parked_connections'))).toBe(true);
  });

  it('passes start, end, step query params to Prometheus', async () => {
    queryRangeFn.mockResolvedValue({
      status: 'success',
      data: { resultType: 'matrix', result: [] },
    });

    const app = await buildApp(buildDeps());
    await app.inject({
      method: 'GET',
      url: '/api/metrics/connections?start=2026-01-01T00:00:00Z&end=2026-01-01T01:00:00Z&step=30s',
    });
    await app.close();

    for (const call of queryRangeFn.mock.calls as [string, string, string, string][]) {
      const [, start, end, step] = call;
      expect(start).toBe('2026-01-01T00:00:00Z');
      expect(end).toBe('2026-01-01T01:00:00Z');
      expect(step).toBe('30s');
    }
  });

  it('returns 502 when Prometheus is unreachable', async () => {
    queryRangeFn.mockRejectedValue(new BffError(502, 'PROMETHEUS_ERROR', 'Prometheus unreachable'));

    const app = await buildApp(buildDeps());
    const res = await app.inject({ method: 'GET', url: '/api/metrics/connections' });
    await app.close();

    expect(res.statusCode).toBe(502);
  });
});

describe('GET /api/metrics/parking-duration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('queries sardeenz_proxy_parking_duration_seconds_bucket with histogram_quantile', async () => {
    queryRangeFn.mockResolvedValue({
      status: 'success',
      data: { resultType: 'matrix', result: [] },
    });

    const app = await buildApp(buildDeps());
    await app.inject({ method: 'GET', url: '/api/metrics/parking-duration' });
    await app.close();

    const queries = (queryRangeFn.mock.calls as [string, ...unknown[]][]).map(([q]) => q);
    expect(queries.every((q) => q.includes('sardeenz_proxy_parking_duration_seconds_bucket'))).toBe(
      true,
    );
    expect(queries.every((q) => q.includes('histogram_quantile'))).toBe(true);
    expect(queries.some((q) => q.includes('0.50'))).toBe(true);
    expect(queries.some((q) => q.includes('0.95'))).toBe(true);
  });

  it('passes start, end, step query params to Prometheus', async () => {
    queryRangeFn.mockResolvedValue({
      status: 'success',
      data: { resultType: 'matrix', result: [] },
    });

    const app = await buildApp(buildDeps());
    await app.inject({
      method: 'GET',
      url: '/api/metrics/parking-duration?start=2026-01-01T00:00:00Z&end=2026-01-01T01:00:00Z&step=30s',
    });
    await app.close();

    for (const call of queryRangeFn.mock.calls as [string, string, string, string][]) {
      const [, start, end, step] = call;
      expect(start).toBe('2026-01-01T00:00:00Z');
      expect(end).toBe('2026-01-01T01:00:00Z');
      expect(step).toBe('30s');
    }
  });

  it('returns 502 when Prometheus is unreachable', async () => {
    queryRangeFn.mockRejectedValue(new BffError(502, 'PROMETHEUS_ERROR', 'Prometheus unreachable'));

    const app = await buildApp(buildDeps());
    const res = await app.inject({ method: 'GET', url: '/api/metrics/parking-duration' });
    await app.close();

    expect(res.statusCode).toBe(502);
  });
});

describe('GET /api/metrics/wake-triggers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('queries sardeenz_control_plane_wake_triggers_total with rate()', async () => {
    queryRangeFn.mockResolvedValue({
      status: 'success',
      data: { resultType: 'matrix', result: [] },
    });

    const app = await buildApp(buildDeps());
    await app.inject({ method: 'GET', url: '/api/metrics/wake-triggers' });
    await app.close();

    const [query] = queryRangeFn.mock.calls[0] as [string];
    expect(query).toContain('sardeenz_control_plane_wake_triggers_total');
    expect(query).toContain('rate(');
  });

  it('passes start, end, step query params to Prometheus', async () => {
    queryRangeFn.mockResolvedValue({
      status: 'success',
      data: { resultType: 'matrix', result: [] },
    });

    const app = await buildApp(buildDeps());
    await app.inject({
      method: 'GET',
      url: '/api/metrics/wake-triggers?start=2026-01-01T00:00:00Z&end=2026-01-01T01:00:00Z&step=30s',
    });
    await app.close();

    const [, start, end, step] = queryRangeFn.mock.calls[0] as [string, string, string, string];
    expect(start).toBe('2026-01-01T00:00:00Z');
    expect(end).toBe('2026-01-01T01:00:00Z');
    expect(step).toBe('30s');
  });

  it('returns 502 when Prometheus is unreachable', async () => {
    queryRangeFn.mockRejectedValue(new BffError(502, 'PROMETHEUS_ERROR', 'Prometheus unreachable'));

    const app = await buildApp(buildDeps());
    const res = await app.inject({ method: 'GET', url: '/api/metrics/wake-triggers' });
    await app.close();

    expect(res.statusCode).toBe(502);
  });
});

describe('GET /api/metrics/state-transitions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('queries sardeenz_control_plane_state_transitions_total with rate()', async () => {
    queryRangeFn.mockResolvedValue({
      status: 'success',
      data: { resultType: 'matrix', result: [] },
    });

    const app = await buildApp(buildDeps());
    await app.inject({ method: 'GET', url: '/api/metrics/state-transitions' });
    await app.close();

    const [query] = queryRangeFn.mock.calls[0] as [string];
    expect(query).toContain('sardeenz_control_plane_state_transitions_total');
    expect(query).toContain('rate(');
  });

  it('passes start, end, step query params to Prometheus', async () => {
    queryRangeFn.mockResolvedValue({
      status: 'success',
      data: { resultType: 'matrix', result: [] },
    });

    const app = await buildApp(buildDeps());
    await app.inject({
      method: 'GET',
      url: '/api/metrics/state-transitions?start=2026-01-01T00:00:00Z&end=2026-01-01T01:00:00Z&step=30s',
    });
    await app.close();

    const [, start, end, step] = queryRangeFn.mock.calls[0] as [string, string, string, string];
    expect(start).toBe('2026-01-01T00:00:00Z');
    expect(end).toBe('2026-01-01T01:00:00Z');
    expect(step).toBe('30s');
  });

  it('returns 502 when Prometheus is unreachable', async () => {
    queryRangeFn.mockRejectedValue(new BffError(502, 'PROMETHEUS_ERROR', 'Prometheus unreachable'));

    const app = await buildApp(buildDeps());
    const res = await app.inject({ method: 'GET', url: '/api/metrics/state-transitions' });
    await app.close();

    expect(res.statusCode).toBe(502);
  });
});

describe('GET /api/metrics/evictions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('queries sardeenz_control_plane_evictions_total with rate()', async () => {
    queryRangeFn.mockResolvedValue({
      status: 'success',
      data: { resultType: 'matrix', result: [] },
    });

    const app = await buildApp(buildDeps());
    await app.inject({ method: 'GET', url: '/api/metrics/evictions' });
    await app.close();

    const [query] = queryRangeFn.mock.calls[0] as [string];
    expect(query).toContain('sardeenz_control_plane_evictions_total');
    expect(query).toContain('rate(');
  });

  it('passes start, end, step query params to Prometheus', async () => {
    queryRangeFn.mockResolvedValue({
      status: 'success',
      data: { resultType: 'matrix', result: [] },
    });

    const app = await buildApp(buildDeps());
    await app.inject({
      method: 'GET',
      url: '/api/metrics/evictions?start=2026-01-01T00:00:00Z&end=2026-01-01T01:00:00Z&step=30s',
    });
    await app.close();

    const [, start, end, step] = queryRangeFn.mock.calls[0] as [string, string, string, string];
    expect(start).toBe('2026-01-01T00:00:00Z');
    expect(end).toBe('2026-01-01T01:00:00Z');
    expect(step).toBe('30s');
  });

  it('returns 502 when Prometheus is unreachable', async () => {
    queryRangeFn.mockRejectedValue(new BffError(502, 'PROMETHEUS_ERROR', 'Prometheus unreachable'));

    const app = await buildApp(buildDeps());
    const res = await app.inject({ method: 'GET', url: '/api/metrics/evictions' });
    await app.close();

    expect(res.statusCode).toBe(502);
  });
});

describe('GET /api/metrics/memory-history', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('queries sardeenz_control_plane_device_memory_bytes as a range query', async () => {
    queryRangeFn.mockResolvedValue({
      status: 'success',
      data: { resultType: 'matrix', result: [] },
    });

    const app = await buildApp(buildDeps());
    await app.inject({ method: 'GET', url: '/api/metrics/memory-history' });
    await app.close();

    const [query] = queryRangeFn.mock.calls[0] as [string];
    expect(query).toContain('sardeenz_control_plane_device_memory_bytes');
  });

  it('passes start, end, step query params to Prometheus', async () => {
    queryRangeFn.mockResolvedValue({
      status: 'success',
      data: { resultType: 'matrix', result: [] },
    });

    const app = await buildApp(buildDeps());
    await app.inject({
      method: 'GET',
      url: '/api/metrics/memory-history?start=2026-01-01T00:00:00Z&end=2026-01-01T01:00:00Z&step=30s',
    });
    await app.close();

    const [, start, end, step] = queryRangeFn.mock.calls[0] as [string, string, string, string];
    expect(start).toBe('2026-01-01T00:00:00Z');
    expect(end).toBe('2026-01-01T01:00:00Z');
    expect(step).toBe('30s');
  });

  it('returns 502 when Prometheus is unreachable', async () => {
    queryRangeFn.mockRejectedValue(new BffError(502, 'PROMETHEUS_ERROR', 'Prometheus unreachable'));

    const app = await buildApp(buildDeps());
    const res = await app.inject({ method: 'GET', url: '/api/metrics/memory-history' });
    await app.close();

    expect(res.statusCode).toBe(502);
  });
});

describe('GET /api/metrics/operations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('queries p95 of deploy, sleep, wake, eviction, and placement duration histograms', async () => {
    queryRangeFn.mockResolvedValue({
      status: 'success',
      data: { resultType: 'matrix', result: [] },
    });

    const app = await buildApp(buildDeps());
    const res = await app.inject({ method: 'GET', url: '/api/metrics/operations' });
    await app.close();

    expect(res.statusCode).toBe(200);
    // 5 parallel queries
    expect(queryRangeFn).toHaveBeenCalledTimes(5);
    const queries = (queryRangeFn.mock.calls as [string, ...unknown[]][]).map(([q]) => q);
    expect(
      queries.some((q) => q.includes('sardeenz_control_plane_deploy_duration_seconds_bucket')),
    ).toBe(true);
    expect(
      queries.some((q) => q.includes('sardeenz_control_plane_sleep_duration_seconds_bucket')),
    ).toBe(true);
    expect(
      queries.some((q) => q.includes('sardeenz_control_plane_wake_duration_seconds_bucket')),
    ).toBe(true);
    expect(
      queries.some((q) => q.includes('sardeenz_control_plane_eviction_duration_seconds_bucket')),
    ).toBe(true);
    expect(
      queries.some((q) => q.includes('sardeenz_control_plane_placement_duration_seconds_bucket')),
    ).toBe(true);
    expect(queries.every((q) => q.includes('0.95'))).toBe(true);
    // Response must have all operation keys
    expect(res.json()).toHaveProperty('deploy');
    expect(res.json()).toHaveProperty('sleep');
    expect(res.json()).toHaveProperty('wake');
    expect(res.json()).toHaveProperty('eviction');
    expect(res.json()).toHaveProperty('placement');
  });

  it('passes start, end, step query params to each Prometheus query', async () => {
    queryRangeFn.mockResolvedValue({
      status: 'success',
      data: { resultType: 'matrix', result: [] },
    });

    const app = await buildApp(buildDeps());
    await app.inject({
      method: 'GET',
      url: '/api/metrics/operations?start=2026-01-01T00:00:00Z&end=2026-01-01T01:00:00Z&step=30s',
    });
    await app.close();

    for (const call of queryRangeFn.mock.calls as [string, string, string, string][]) {
      const [, start, end, step] = call;
      expect(start).toBe('2026-01-01T00:00:00Z');
      expect(end).toBe('2026-01-01T01:00:00Z');
      expect(step).toBe('30s');
    }
  });

  it('returns 502 when Prometheus is unreachable', async () => {
    queryRangeFn.mockRejectedValue(new BffError(502, 'PROMETHEUS_ERROR', 'Prometheus unreachable'));

    const app = await buildApp(buildDeps());
    const res = await app.inject({ method: 'GET', url: '/api/metrics/operations' });
    await app.close();

    expect(res.statusCode).toBe(502);
  });
});
