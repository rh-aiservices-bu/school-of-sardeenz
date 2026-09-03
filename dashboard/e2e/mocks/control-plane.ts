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
  displayName?: string;
  servedModelName?: string;
  state: string;
  runnerType: string;
  requiredMemory: number;
  currentMemory?: number;
  /** Unambiguous only when the model has exactly one instance — mirrors the real contract. */
  workerId?: string;
  instanceCount?: number;
  pinned?: boolean;
  createdAt?: string;
  lastInferenceAt?: string;
}

/** One instance (replica) of a mock model — #120's ModelDetail.instances[] shape. */
export interface MockInstanceInfo {
  instanceId: string;
  state: string;
  workerId?: string;
  runnerEndpoint?: { host: string; port: number };
  createdAt?: string;
  /** NVML-measured device memory for this instance (#163). Absent when unmeasured. */
  currentMemory?: number;
}

// memoryUsedBytes IS the NVML measurement now (doctrine: measured memory is the only number,
// #163) — no more memoryReservedBytes/memoryMeasuredUsedBytes fields to carry.
export interface MockDeviceInfo {
  deviceIndex: number;
  deviceType: string;
  memoryTotalBytes: number;
  memoryUsedBytes: number;
  memoryAvailableBytes: number;
  /** Device product name from NVML. Absent when the worker cannot query it. */
  deviceName?: string;
  /** GPU utilization percentage at report time. Absent when unavailable. */
  utilizationPercent?: number;
  /** GPU temperature in °C at report time. Absent when unavailable. */
  temperatureC?: number;
}

/** Mirrors WorkerModelInfo (per-instance placement summary) for ClusterMemory.workers[].models. */
export interface MockWorkerModelInfo {
  modelName: string;
  displayName?: string;
  instanceId?: string;
  state: string;
  memoryUsedBytes?: number;
  deviceIndices?: number[];
}

export interface MockWorkerInfo {
  workerId: string;
  status: string;
  devices: MockDeviceInfo[];
  modelCount?: number;
  lastHeartbeatAt?: string;
}

export interface MockWorkerDetail extends MockWorkerInfo {
  models: MockWorkerModelInfo[];
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
    models?: MockWorkerModelInfo[];
  }>;
  summary?: {
    totalBytes: number;
    usedBytes: number;
    availableBytes: number;
  };
}

/** Minimal RunnerCatalogView (control-plane.yaml) for the deploy form's Runtime Module dropdown. */
export interface MockCatalogItem {
  entry: {
    id: string;
    title: string;
    description: string;
    engine?: string;
    runnerType: string;
    version: string;
    image: string;
    sifName: string;
    protocol: 'openai' | 'oip';
  };
  status: { id: string; state: 'NOT_IMPORTED' | 'IMPORTING' | 'IMPORTED' | 'FAILED' };
  updateAvailable: boolean;
}

export interface MockRunnerCatalog {
  source?: string;
  fetchedAt?: string;
  runners: MockCatalogItem[];
  unmanagedModules: string[];
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
  /** modelName -> instances (#120). Auto-populated for models set via setModels() that don't
   * already have an entry, so existing single-instance test fixtures keep working unmodified. */
  modelInstances: Record<string, MockInstanceInfo[]>;
  workers: MockWorkerInfo[];
  workerDetails: Record<string, MockWorkerDetail>;
  clusterStatus: MockClusterStatus;
  clusterMemory: MockClusterMemory;
  catalog: MockRunnerCatalog;
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
      modelInstances: {},
      workers: [],
      workerDetails: {},
      clusterStatus: {
        workerCount: 0,
        workersOnline: 0,
        modelCounts: { total: 0, active: 0, sleeping: 0, starting: 0, error: 0, other: 0 },
        memory: { totalBytes: 0, usedBytes: 0, availableBytes: 0 },
      },
      clusterMemory: { workers: [] },
      catalog: MockControlPlane.defaultCatalog(),
      healthy: true,
      apiError: false,
    };
  }

  private static defaultCatalog(): MockRunnerCatalog {
    return {
      source: 'mock://runners.yaml',
      fetchedAt: new Date().toISOString(),
      runners: [
        {
          entry: {
            id: 'vllm-0.21',
            title: 'vLLM 0.21',
            description: 'vLLM reference runner (mock).',
            engine: 'vLLM',
            runnerType: 'vllm',
            version: '0.21',
            image: 'oras://quay.io/sardeenz/runner-vllm:0.21',
            sifName: 'vllm-0.21',
            protocol: 'openai',
          },
          status: { id: 'vllm-0.21', state: 'IMPORTED' },
          updateAvailable: false,
        },
      ],
      unmanagedModules: [],
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
        // Non-JSON body: the BFF ControlPlaneClient.request() calls res.json(), which throws on
        // this, raising a BffError so the routes take their Redis-fallback path (source:
        // 'redis-fallback'). A JSON 503 would be passed straight through and never trigger fallback.
        return reply.code(503).type('text/plain').send('service unavailable');
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
      const instances = this.instancesFor(model.modelName);
      return reply.send({ ...model, instances });
    });

    app.post('/api/v1/models', async (req, reply) => {
      const body = req.body as MockModelInfo;
      const existing = this.state.models.find((m) => m.modelName === body.modelName);
      if (existing) return reply.code(409).send({ error: 'already exists' });
      const newModel: MockModelInfo = {
        modelName: body.modelName,
        displayName: body.displayName,
        servedModelName: body.servedModelName,
        state: 'PENDING',
        runnerType: body.runnerType ?? 'vllm',
        requiredMemory: body.requiredMemory ?? 0,
        // currentMemory intentionally absent (not 0) — mirrors the real contract, where it's
        // only populated once the worker reports a measurement (#163).
        instanceCount: 1,
        createdAt: new Date().toISOString(),
      };
      this.state.models.push(newModel);
      this.state.modelInstances[newModel.modelName] = [this.newInstance(newModel)];
      return reply.code(201).send(newModel);
    });

    app.delete<{ Params: { name: string } }>('/api/v1/models/:name', async (req, reply) => {
      const idx = this.state.models.findIndex((m) => m.modelName === req.params.name);
      if (idx === -1) return reply.code(404).send({ error: 'not found' });
      this.state.models.splice(idx, 1);
      delete this.state.modelInstances[req.params.name];
      return reply.code(204).send();
    });

    app.post<{ Params: { name: string } }>('/api/v1/models/:name/sleep', async (req, reply) => {
      const model = this.state.models.find((m) => m.modelName === req.params.name);
      if (!model) return reply.code(404).send({ error: 'not found' });
      model.state = 'SLEEPING';
      for (const inst of this.instancesFor(model.modelName)) inst.state = 'SLEEPING';
      return reply.send(model);
    });

    app.post<{ Params: { name: string } }>('/api/v1/models/:name/wake', async (req, reply) => {
      const model = this.state.models.find((m) => m.modelName === req.params.name);
      if (!model) return reply.code(404).send({ error: 'not found' });
      model.state = 'STARTING';
      for (const inst of this.instancesFor(model.modelName)) inst.state = 'STARTING';
      return reply.send(model);
    });

    app.post<{ Params: { name: string } }>('/api/v1/models/:name/stop', async (req, reply) => {
      const model = this.state.models.find((m) => m.modelName === req.params.name);
      if (!model) return reply.code(404).send({ error: 'not found' });
      model.state = 'STOPPED';
      this.state.modelInstances[model.modelName] = [];
      model.instanceCount = 0;
      return reply.send(model);
    });

    app.post<{ Params: { name: string } }>('/api/v1/models/:name/start', async (req, reply) => {
      const model = this.state.models.find((m) => m.modelName === req.params.name);
      if (!model) return reply.code(404).send({ error: 'not found' });
      model.state = 'STARTING';
      this.state.modelInstances[model.modelName] = [this.newInstance(model)];
      model.instanceCount = 1;
      return reply.send(model);
    });

    // Instances (#120)
    app.post<{ Params: { name: string } }>('/api/v1/models/:name/instances', async (req, reply) => {
      const model = this.state.models.find((m) => m.modelName === req.params.name);
      if (!model) return reply.code(404).send({ error: 'not found' });
      const instances = this.instancesFor(model.modelName);
      const instance = this.newInstance(model);
      instances.push(instance);
      model.instanceCount = instances.length;
      model.workerId = instances.length === 1 ? instance.workerId : undefined;
      return reply.code(202).send({
        modelName: model.modelName,
        instanceId: instance.instanceId,
        state: instance.state,
      });
    });

    app.delete<{ Params: { name: string; instanceId: string } }>(
      '/api/v1/models/:name/instances/:instanceId',
      async (req, reply) => {
        const model = this.state.models.find((m) => m.modelName === req.params.name);
        if (!model) return reply.code(404).send({ error: 'not found' });
        const instances = this.instancesFor(model.modelName);
        const idx = instances.findIndex((i) => i.instanceId === req.params.instanceId);
        if (idx === -1) return reply.code(404).send({ error: 'not found' });
        instances.splice(idx, 1);
        model.instanceCount = instances.length;
        model.workerId = instances.length === 1 ? instances[0].workerId : undefined;
        return reply.code(202).send({
          modelName: model.modelName,
          instanceId: req.params.instanceId,
          state: 'STOPPING',
        });
      },
    );

    app.post<{ Params: { name: string; instanceId: string } }>(
      '/api/v1/models/:name/instances/:instanceId/sleep',
      async (req, reply) => {
        const model = this.state.models.find((m) => m.modelName === req.params.name);
        if (!model) return reply.code(404).send({ error: 'not found' });
        const instance = this.instancesFor(model.modelName).find(
          (i) => i.instanceId === req.params.instanceId,
        );
        if (!instance) return reply.code(404).send({ error: 'not found' });
        instance.state = 'SLEEPING';
        return reply.code(202).send({
          modelName: model.modelName,
          instanceId: instance.instanceId,
          state: instance.state,
        });
      },
    );

    app.post<{ Params: { name: string; instanceId: string } }>(
      '/api/v1/models/:name/instances/:instanceId/wake',
      async (req, reply) => {
        const model = this.state.models.find((m) => m.modelName === req.params.name);
        if (!model) return reply.code(404).send({ error: 'not found' });
        const instance = this.instancesFor(model.modelName).find(
          (i) => i.instanceId === req.params.instanceId,
        );
        if (!instance) return reply.code(404).send({ error: 'not found' });
        instance.state = 'STARTING';
        return reply.code(202).send({
          modelName: model.modelName,
          instanceId: instance.instanceId,
          state: instance.state,
        });
      },
    );

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

    // Runner catalog (#155) — merged catalog + import state the deploy form reads.
    app.get('/api/v1/catalog', async (_req, reply) => {
      return reply.send(this.state.catalog);
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

  /**
   * Return (creating if absent) the instance list for a model. Models set via setModels() that
   * don't already have an entry in modelInstances get one instance auto-derived from the model's
   * own state/workerId, so existing single-instance test fixtures need no changes for #120.
   */
  private instancesFor(modelName: string): MockInstanceInfo[] {
    if (!this.state.modelInstances[modelName]) {
      const model = this.state.models.find((m) => m.modelName === modelName);
      this.state.modelInstances[modelName] =
        model && model.state !== 'STOPPED' ? [this.newInstance(model)] : [];
    }
    return this.state.modelInstances[modelName];
  }

  private instanceCounter = 0;

  private newInstance(model: MockModelInfo): MockInstanceInfo {
    this.instanceCounter += 1;
    return {
      instanceId: `inst-mock${this.instanceCounter.toString().padStart(4, '0')}`,
      state: model.state,
      workerId: model.workerId,
      createdAt: new Date().toISOString(),
    };
  }

  /** Replace the full model list. */
  setModels(models: MockModelInfo[]): void {
    this.state.models = models.map((m) => ({
      ...m,
      instanceCount: m.instanceCount ?? (m.state === 'STOPPED' ? 0 : 1),
      createdAt: m.createdAt ?? new Date().toISOString(),
    }));
    // Reset auto-derived instances; instancesFor() lazily rebuilds them from the new model state.
    this.state.modelInstances = {};
    this.syncClusterStatus();
  }

  /** Explicitly set the instances for a model (for tests exercising multi-instance scenarios). */
  setInstances(modelName: string, instances: MockInstanceInfo[]): void {
    this.state.modelInstances[modelName] = instances;
    const model = this.state.models.find((m) => m.modelName === modelName);
    if (model) {
      model.instanceCount = instances.length;
      model.workerId = instances.length === 1 ? instances[0].workerId : undefined;
    }
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
    if (memory.summary) {
      this.state.clusterMemory = memory;
      return;
    }
    // Auto-compute the summary when the caller didn't supply one — mirrors the real
    // MemoryBudgetService.getClusterSummary() aggregation so tests don't need to hand-roll it.
    let totalBytes = 0;
    let usedBytes = 0;
    let availableBytes = 0;
    for (const w of memory.workers) {
      for (const d of w.devices) {
        totalBytes += d.memoryTotalBytes;
        usedBytes += d.memoryUsedBytes;
        availableBytes += d.memoryAvailableBytes;
      }
    }
    this.state.clusterMemory = { ...memory, summary: { totalBytes, usedBytes, availableBytes } };
  }

  /** Replace the mock runner catalog (deploy form's Runtime Module source). */
  setCatalog(catalog: MockRunnerCatalog): void {
    this.state.catalog = catalog;
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
      other: models.filter((m) => !['ACTIVE', 'SLEEPING', 'STARTING', 'ERROR'].includes(m.state))
        .length,
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
