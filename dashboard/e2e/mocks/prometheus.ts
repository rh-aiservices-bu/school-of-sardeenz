/**
 * Mock Prometheus server for E2E tests.
 *
 * Returns canned metric data for `/api/v1/query_range` and `/api/v1/query`.
 * The BFF PrometheusClient calls these endpoints.
 */

import Fastify, { type FastifyInstance } from 'fastify';

// ---------------------------------------------------------------------------
// Canonical Prometheus response shapes
// ---------------------------------------------------------------------------

export interface PrometheusRangeSeries {
  metric: Record<string, string>;
  values: Array<[number, string]>;
}

export interface PrometheusRangeResponse {
  status: 'success' | 'error';
  data: {
    resultType: 'matrix';
    result: PrometheusRangeSeries[];
  };
}

export interface PrometheusInstantSeries {
  metric: Record<string, string>;
  value: [number, string];
}

export interface PrometheusInstantResponse {
  status: 'success' | 'error';
  data: {
    resultType: 'vector';
    result: PrometheusInstantSeries[];
  };
}

// ---------------------------------------------------------------------------
// MockPrometheus
// ---------------------------------------------------------------------------

type RangeResponseFactory = (query: string) => PrometheusRangeResponse;
type InstantResponseFactory = (query: string) => PrometheusInstantResponse;

export class MockPrometheus {
  private app: FastifyInstance;
  private _port = 0;

  private rangeFactory: RangeResponseFactory = () => MockPrometheus.emptyRangeResponse();
  private instantFactory: InstantResponseFactory = () => MockPrometheus.emptyInstantResponse();
  private errorMode = false;

  constructor() {
    this.app = Fastify({ logger: false });
    this.registerRoutes();
  }

  // ---------------------------------------------------------------------------
  // Default canned responses
  // ---------------------------------------------------------------------------

  static emptyRangeResponse(): PrometheusRangeResponse {
    return { status: 'success', data: { resultType: 'matrix', result: [] } };
  }

  static emptyInstantResponse(): PrometheusInstantResponse {
    return { status: 'success', data: { resultType: 'vector', result: [] } };
  }

  /**
   * Build a simple range response with a single series of linearly increasing values.
   */
  static buildRangeSeries(
    metric: Record<string, string>,
    startTs: number,
    count: number,
    stepSeconds: number,
    startValue = 0.5,
  ): PrometheusRangeSeries {
    const values: Array<[number, string]> = [];
    for (let i = 0; i < count; i++) {
      values.push([startTs + i * stepSeconds, (startValue + i * 0.01).toFixed(4)]);
    }
    return { metric, values };
  }

  /**
   * Factory that returns a range response with one latency series per model label.
   */
  static latencyRangeFactory(models: string[]): RangeResponseFactory {
    return (): PrometheusRangeResponse => {
      const now = Math.floor(Date.now() / 1000);
      const result = models.map((model) =>
        MockPrometheus.buildRangeSeries({ model }, now - 900, 10, 90, 0.1),
      );
      return { status: 'success', data: { resultType: 'matrix', result } };
    };
  }

  /**
   * Factory that returns an instant response with memory usage per device.
   */
  static memoryInstantFactory(
    devices: Array<{ label: string; bytes: number }>,
  ): InstantResponseFactory {
    return (): PrometheusInstantResponse => {
      const now = Math.floor(Date.now() / 1000);
      const result: PrometheusInstantSeries[] = devices.map(({ label, bytes }) => ({
        metric: { device: label },
        value: [now, bytes.toString()],
      }));
      return { status: 'success', data: { resultType: 'vector', result } };
    };
  }

  // ---------------------------------------------------------------------------
  // Route registration
  // ---------------------------------------------------------------------------

  private registerRoutes(): void {
    const app = this.app;

    app.get('/-/healthy', async (_req, reply) => {
      if (this.errorMode) return reply.code(503).send('Service Unavailable');
      return reply.send('Prometheus is Healthy.\n');
    });

    app.get('/api/v1/query_range', async (req, reply) => {
      if (this.errorMode) return reply.code(503).send({ error: 'service unavailable' });
      const query = (req.query as Record<string, string>)['query'] ?? '';
      return reply.send(this.rangeFactory(query));
    });

    app.get('/api/v1/query', async (req, reply) => {
      if (this.errorMode) return reply.code(503).send({ error: 'service unavailable' });
      const query = (req.query as Record<string, string>)['query'] ?? '';
      return reply.send(this.instantFactory(query));
    });
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async start(): Promise<number> {
    await this.app.listen({ host: '127.0.0.1', port: 0 });
    const address = this.app.server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Unexpected server address');
    }
    this._port = address.port;
    return this._port;
  }

  async stop(): Promise<void> {
    await this.app.close();
  }

  get port(): number {
    return this._port;
  }

  get url(): string {
    return `http://127.0.0.1:${this._port}`;
  }

  // ---------------------------------------------------------------------------
  // Test helpers
  // ---------------------------------------------------------------------------

  /** Respond with the given canned range response for all queries. */
  setRangeResponse(response: PrometheusRangeResponse): void {
    this.rangeFactory = () => response;
  }

  /** Respond with the given canned instant response for all queries. */
  setInstantResponse(response: PrometheusInstantResponse): void {
    this.instantFactory = () => response;
  }

  /** Use a factory function for fine-grained per-query control. */
  setRangeFactory(factory: RangeResponseFactory): void {
    this.rangeFactory = factory;
  }

  /** Use a factory function for fine-grained per-query control. */
  setInstantFactory(factory: InstantResponseFactory): void {
    this.instantFactory = factory;
  }

  /** Simulate Prometheus being unreachable. */
  setErrorMode(error: boolean): void {
    this.errorMode = error;
  }

  /** Reset to default (empty) responses. */
  reset(): void {
    this.rangeFactory = () => MockPrometheus.emptyRangeResponse();
    this.instantFactory = () => MockPrometheus.emptyInstantResponse();
    this.errorMode = false;
  }
}
