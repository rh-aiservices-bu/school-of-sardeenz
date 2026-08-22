// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { ModelLifecycleState, CatalogItemState } from '@sardeenz/types';
import { registerCatalogRoutes } from '../catalog.js';
import type { RouteDeps } from '../deps.js';
import type { CatalogEntry, CatalogSnapshot } from '../../services/catalog-service.js';

const ENTRY: CatalogEntry = {
  id: 'vllm-0.21',
  title: 'vLLM 0.21',
  description: 'd',
  runnerType: 'vllm',
  version: '0.21',
  image: 'oras://quay.io/x/vllm:0.21',
  sifName: 'vllm-0.21',
  maxTensorParallelism: 1,
  kvCacheElasticSharing: false,
};

const SNAPSHOT: CatalogSnapshot = {
  source: 'test',
  fetchedAt: '2026-01-01T00:00:00Z',
  entries: [ENTRY],
};

interface Overrides {
  isLeader?: boolean;
  importedStems?: Set<string>;
  activeStates?: { modelName: string; state: ModelLifecycleState }[];
  modelRecords?: {
    name: string;
    runnerType: string;
    engineConfig: Record<string, unknown> | null;
  }[];
}

function buildApp(over: Overrides = {}): {
  app: FastifyInstance;
  moduleStore: Record<string, ReturnType<typeof vi.fn>>;
} {
  const moduleStore = {
    listImportedStems: vi.fn(() => Promise.resolve(over.importedStems ?? new Set<string>())),
    getAllTransient: vi.fn(() => new Map()),
    startImport: vi.fn(() => ({
      id: ENTRY.id,
      state: CatalogItemState.IMPORTING,
      percentComplete: 0,
    })),
    uninstall: vi.fn(() => Promise.resolve(true)),
  };
  const deps = {
    config: {} as RouteDeps['config'],
    catalogService: {
      load: vi.fn(() => Promise.resolve(SNAPSHOT)),
      refresh: vi.fn(() => Promise.resolve(SNAPSHOT)),
    },
    moduleStore,
    lifecycle: { getAllStates: vi.fn(() => Promise.resolve(over.activeStates ?? [])) },
    modelRepository: { findAll: vi.fn(() => Promise.resolve(over.modelRecords ?? [])) },
    leaderElection: { isLeader: over.isLeader ?? true },
  } as unknown as RouteDeps;

  const app = Fastify({ logger: false });
  app.setErrorHandler((error: Error & { statusCode?: number; code?: string }, _req, reply) => {
    return reply.code(error.statusCode ?? 500).send({ error: error.message, code: error.code });
  });
  registerCatalogRoutes(app, deps);
  return { app, moduleStore };
}

describe('catalog routes', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = buildApp().app;
  });

  it('GET /catalog returns the merged view', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/catalog' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ runners: { status: { state: string } }[] }>();
    expect(body.runners).toHaveLength(1);
    expect(body.runners[0].status.state).toBe(CatalogItemState.NOT_IMPORTED);
  });

  it('POST /catalog/:id/import returns 202 with IMPORTING status', async () => {
    const { app: a, moduleStore } = buildApp();
    const res = await a.inject({ method: 'POST', url: '/api/v1/catalog/vllm-0.21/import' });
    expect(res.statusCode).toBe(202);
    expect(res.json<{ state: string }>().state).toBe(CatalogItemState.IMPORTING);
    expect(moduleStore.startImport).toHaveBeenCalledOnce();
  });

  it('POST import returns 404 for an unknown id', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/catalog/nope/import' });
    expect(res.statusCode).toBe(404);
  });

  it('POST import returns 503 when not the leader', async () => {
    const { app: a } = buildApp({ isLeader: false });
    const res = await a.inject({ method: 'POST', url: '/api/v1/catalog/vllm-0.21/import' });
    expect(res.statusCode).toBe(503);
  });

  it('DELETE /catalog/:id uninstalls when not in use', async () => {
    const { app: a, moduleStore } = buildApp({ importedStems: new Set(['vllm-0.21']) });
    const res = await a.inject({ method: 'DELETE', url: '/api/v1/catalog/vllm-0.21' });
    expect(res.statusCode).toBe(204);
    expect(moduleStore.uninstall).toHaveBeenCalledOnce();
  });

  it('DELETE returns 409 when a running model uses the module', async () => {
    const { app: a, moduleStore } = buildApp({
      importedStems: new Set(['vllm-0.21']),
      activeStates: [{ modelName: 'm1', state: ModelLifecycleState.ACTIVE }],
      modelRecords: [{ name: 'm1', runnerType: 'vllm', engineConfig: { version: '0.21' } }],
    });
    const res = await a.inject({ method: 'DELETE', url: '/api/v1/catalog/vllm-0.21' });
    expect(res.statusCode).toBe(409);
    expect(moduleStore.uninstall).not.toHaveBeenCalled();
  });

  it('DELETE allows uninstall when only a different runnerType is running', async () => {
    const { app: a, moduleStore } = buildApp({
      importedStems: new Set(['vllm-0.21']),
      activeStates: [{ modelName: 'm1', state: ModelLifecycleState.ACTIVE }],
      modelRecords: [{ name: 'm1', runnerType: 'triton', engineConfig: null }],
    });
    const res = await a.inject({ method: 'DELETE', url: '/api/v1/catalog/vllm-0.21' });
    expect(res.statusCode).toBe(204);
    expect(moduleStore.uninstall).toHaveBeenCalledOnce();
  });
});
