/**
 * Mock Control Plane server for E2E tests.
 *
 * Starts a lightweight Fastify server on a random port that returns
 * configurable responses for all endpoints the BFF ControlPlaneClient calls.
 * Also exposes an SSE endpoint that can push events on demand.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import { EventEmitter } from 'node:events';

// ---------------------------------------------------------------------------
// Types mirroring the shapes the BFF and frontend expect
// ---------------------------------------------------------------------------

export interface MockModelInfo {
  modelName: string;
  state: string;
  runnerType: string;
  requiredMemory: number;
  currentMemory?: number;
  workerId?: string;
  pinned?: boolean;
  createdAt?: string;
  lastInferenceAt?: string;
}

export interface MockDeviceInfo {
  deviceIndex: number;
  deviceType: string;
  memoryTotalBytes: number;
  memoryUsedBytes: number;
  memoryAvailableBytes: number;
  memoryReservedBytes?: number;
}

export interface MockWorkerInfo {
  workerId: string;
  status: string;
  devices: MockDeviceInfo[];
  modelCount?: number;
  lastHeartbeatAt?: string;
}

export interface MockWorkerDetail extends MockWorkerInfo {
  models: Array<{ modelName: string; state: string; memoryUsedBytes?: number }>;
  runnerCapabilities?: Array<{
    runnerType: string;
    engineName: string;
    supportedModelTypes: string[];
    supportedDeviceTypes: string[];
  }>;
  joinedAt?: string;
}

export interface MockClusterStatus {
  workerCount: number;
  workersOnline: number;
  modelCounts: {
    total: number;
    active?: number;
    sleeping?: number;
    starting?: number;
    error?: number;
    other?: number;
  };
  memory: {
    totalBytes: number;
    usedBytes: number;
    availableBytes: number;
  };
}

export interface MockClusterMemory {
  workers: Array<{
    workerId: string;
    devices: MockDeviceInfo[];
  }>;
}

export interface MockSseEvent {
  type: string;
  timestamp: string;
  modelName?: string;
  workerId?: string;
  state?: string;
  message?: string;
}

// ---------------------------------------------------------------------------
// State store
// ---------------------------------------------------------------------------

interface MockState {
  models: MockModelInfo[];
  workers: MockWorkerInfo[];
  workerDetails: Record<string, MockWorkerDetail>;
  clusterStatus: MockClusterStatus;
  clusterMemory: MockClusterMemory;
  healthy: boolean;
  apiError: boolean;
}

// ---------------------------------------------------------------------------
// MockControlPlane
// ---------------------------------------------------------------------------

export class MockControlPlane {
  private app: FastifyInstance;
  private sseEmitter = new EventEmitter();
  private state: MockState;
  private _port = 0;

  constructor() {
    this.app = Fastify({ logger: false });
    this.state = MockControlPlane.defaultState();
    this.registerRoutes();
  }

  private static defaultState(): MockState {
    return {
      models: [],
      workers: [],
      workerDetails: {},
      clusterStatus: {
        workerCount: 0,
        workersOnline: 0,
        modelCounts: { total: 0, active: 0, sleeping: 0, starting: 0, error: 0, other: 0 },
        memory: { totalBytes: 0, usedBytes: 0, availableBytes: 0 },
      },
      clusterMemory: { workers: [] },
      healthy: true,
      apiError: false,
    };
  }

  // ---------------------------------------------------------------------------
  // Route registration
  // ---------------------------------------------------------------------------

  private registerRoutes(): void {
    const app = this.app;

    app.get('/healthz', async (_req, reply) => {
      if (!this.state.healthy) return reply.code(503).send({ error: 'unhealthy' });
      return reply.send({ status: 'ok' });
    });

    // API error simulation — returns 503 on all /api/v1/* routes
    app.addHook('onRequest', async (req, reply) => {
      if (this.state.apiError && req.url.startsWith('/api/v1/')) {
        return reply.code(503).send({ error: 'service unavailable' });
      }
    });

    // Models
    app.get('/api/v1/models', async (req, reply) => {
      const query = req.query as Record<string, string>;
      const stateFilter = query['state'];
      const models = stateFilter
        ? this.state.models.filter((m) => m.state === stateFilter)
        : this.state.models;
      return reply.send({ models });
    });

    app.get<{ Params: { name: string } }>('/api/v1/models/:name', async (req, reply) => {
      const model = this.state.models.find((m) => m.modelName === req.params.name);
      if (!model) return reply.code(404).send({ error: 'not found' });
      return reply.send(model);
    });

    app.post('/api/v1/models', async (req, reply) => {
      const body = req.body as MockModelInfo;
      const existing = this.state.models.find((m) => m.modelName === body.modelName);
      if (existing) return reply.code(409).send({ error: 'already exists' });
      const newModel: MockModelInfo = {
        modelName: body.modelName,
        state: 'PENDING',
        runnerType: body.runnerType ?? 'vllm',
        requiredMemory: body.requiredMemory ?? 0,
        currentMemory: 0,
        createdAt: new Date().toISOString(),
      };
      this.state.models.push(newModel);
      return reply.code(201).send(newModel);
    });

    app.delete<{ Params: { name: string } }>('/api/v1/models/:name', async (req, reply) => {
      const idx = this.state.models.findIndex((m) => m.modelName === req.params.name);
      if (idx === -1) return reply.code(404).send({ error: 'not found' });
      this.state.models.splice(idx, 1);
      return reply.code(204).send();
    });

    app.post<{ Params: { name: string } }>('/api/v1/models/:name/sleep', async (req, reply) => {
      const model = this.state.models.find((m) => m.modelName === req.params.name);
      if (!model) return reply.code(404).send({ error: 'not found' });
      model.state = 'SLEEPING';
      return reply.send(model);
    });

    app.post<{ Params: { name: string } }>('/api/v1/models/:name/wake', async (req, reply) => {
      const model = this.state.models.find((m) => m.modelName === req.params.name);
      if (!model) return reply.code(404).send({ error: 'not found' });
      model.state = 'STARTING';
      return reply.send(model);
    });

    // Workers
    app.get('/api/v1/workers', async (_req, reply) => {
      return reply.send({ workers: this.state.workers });
    });

    app.get<{ Params: { id: string } }>('/api/v1/workers/:id', async (req, reply) => {
      const detail = this.state.workerDetails[req.params.id];
      if (!detail) return reply.code(404).send({ error: 'not found' });
      return reply.send(detail);
    });

    // Cluster
    app.get('/api/v1/cluster/status', async (_req, reply) => {
      return reply.send(this.state.clusterStatus);
    });

    app.get('/api/v1/cluster/memory', async (_req, reply) => {
      return reply.send(this.state.clusterMemory);
    });

    // SSE — push events from sseEmitter
    app.get('/api/v1/events', async (req, reply) => {
      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      reply.raw.flushHeaders();

      const listener = (event: MockSseEvent) => {
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      };

      this.sseEmitter.on('event', listener);

      let cleanedUp = false;
      const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        this.sseEmitter.off('event', listener);
        reply.raw.end();
      };

      req.raw.on('close', cleanup);
      req.raw.on('error', cleanup);

      await new Promise<void>((resolve) => {
        req.raw.on('close', resolve);
        req.raw.on('error', resolve);
      });
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

  /** Replace the full model list. */
  setModels(models: MockModelInfo[]): void {
    this.state.models = models.map((m) => ({
      ...m,
      createdAt: m.createdAt ?? new Date().toISOString(),
    }));
    this.syncClusterStatus();
  }

  /** Replace the full worker list. Also updates cluster status. */
  setWorkers(workers: MockWorkerInfo[], details?: Record<string, MockWorkerDetail>): void {
    this.state.workers = workers;
    if (details) {
      this.state.workerDetails = details;
    } else {
      // Auto-generate minimal details
      for (const w of workers) {
        this.state.workerDetails[w.workerId] = {
          ...w,
          models: [],
        };
      }
    }
    this.syncClusterStatus();
  }

  /** Directly override cluster status. */
  setClusterStatus(status: MockClusterStatus): void {
    this.state.clusterStatus = status;
  }

  /** Set cluster memory snapshot. */
  setClusterMemory(memory: MockClusterMemory): void {
    this.state.clusterMemory = memory;
  }

  /** Mark the health endpoint as healthy or unhealthy. */
  setHealthy(healthy: boolean): void {
    this.state.healthy = healthy;
  }

  /** Make all /api/v1/* endpoints return 503 (simulates CP unavailability). */
  setApiError(enabled: boolean): void {
    this.state.apiError = enabled;
  }

  /** Push an SSE event to all connected clients. */
  pushEvent(event: MockSseEvent): void {
    this.sseEmitter.emit('event', event);
  }

  /** Reset to default empty state. */
  reset(): void {
    this.state = MockControlPlane.defaultState();
  }

  /** Sync cluster status from current workers/models. */
  private syncClusterStatus(): void {
    const models = this.state.models;
    const workers = this.state.workers;

    const counts = {
      total: models.length,
      active: models.filter((m) => m.state === 'ACTIVE').length,
      sleeping: models.filter((m) => m.state === 'SLEEPING').length,
      starting: models.filter((m) => m.state === 'STARTING').length,
      error: models.filter((m) => m.state === 'ERROR').length,
      other: models.filter(
        (m) => !['ACTIVE', 'SLEEPING', 'STARTING', 'ERROR'].includes(m.state),
      ).length,
    };

    const workersOnline = workers.filter((w) => w.status === 'ONLINE').length;
    let totalBytes = 0;
    let usedBytes = 0;
    let availableBytes = 0;
    for (const w of workers) {
      for (const d of w.devices) {
        totalBytes += d.memoryTotalBytes;
        usedBytes += d.memoryUsedBytes;
        availableBytes += d.memoryAvailableBytes;
      }
    }

    this.state.clusterStatus = {
      workerCount: workers.length,
      workersOnline,
      modelCounts: counts,
      memory: { totalBytes, usedBytes, availableBytes },
    };
  }
}
