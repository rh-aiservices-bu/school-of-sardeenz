// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClusterEventType, CatalogItemState, type ControlPlaneComponents } from '@sardeenz/types';
import { ModuleStoreService } from '../module-store.js';
import { StubImporter, OrasImporter, type RunResult } from '../sif-importer.js';
import type { CatalogEntry } from '../catalog-service.js';

type ClusterEvent = ControlPlaneComponents['schemas']['ClusterEvent'];

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function entry(over: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    id: 'vllm-0.21',
    title: 'vLLM 0.21',
    description: 'd',
    runnerType: 'vllm',
    version: '0.21',
    image: 'oras://quay.io/x/vllm:0.21',
    sifName: 'vllm-0.21',
    ...over,
  };
}

async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('waitFor timed out');
}

describe('ModuleStoreService with StubImporter', () => {
  let dir: string;
  let events: ClusterEvent[];
  let store: ModuleStoreService;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sardeenz-modules-'));
    events = [];
    store = new ModuleStoreService(dir, new StubImporter(1), (e) => events.push(e), logger);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('imports a SIF, emits progress/completed events, and reflects it in listImportedStems', async () => {
    const status = store.startImport(entry());
    expect(status.state).toBe(CatalogItemState.IMPORTING);

    await waitFor(() => events.some((e) => e.type === ClusterEventType.CATALOG_IMPORT_COMPLETED));

    const types = events.map((e) => e.type);
    expect(types).toContain(ClusterEventType.CATALOG_IMPORT_STARTED);
    expect(types).toContain(ClusterEventType.CATALOG_IMPORT_PROGRESS);
    expect(types).toContain(ClusterEventType.CATALOG_IMPORT_COMPLETED);

    const stems = await store.listImportedStems();
    expect(stems.has('vllm-0.21')).toBe(true);
    // No transient status once completed (state is fs-derived).
    expect(store.getTransientStatus('vllm-0.21')).toBeUndefined();
    // The temp file was renamed away, not left behind.
    const leftover = (await import('node:fs/promises')).readdir(dir);
    expect((await leftover).filter((f) => f.startsWith('.'))).toHaveLength(0);
  });

  it('is idempotent while an import is in flight', () => {
    const first = store.startImport(entry());
    const second = store.startImport(entry());
    expect(second).toBe(first);
  });

  it('uninstall deletes the SIF and emits a removed event', async () => {
    await writeFile(join(dir, 'vllm-0.21.sif'), 'x');
    const removed = await store.uninstall(entry());
    expect(removed).toBe(true);
    expect((await store.listImportedStems()).has('vllm-0.21')).toBe(false);
    expect(events.at(-1)?.type).toBe(ClusterEventType.CATALOG_MODULE_REMOVED);
  });

  it('uninstall returns false when the SIF is absent', async () => {
    expect(await store.uninstall(entry())).toBe(false);
  });

  it('records a FAILED transient status when the importer throws', async () => {
    const failing = {
      kind: 'stub' as const,
      import: () => Promise.reject(new Error('boom')),
    };
    const s = new ModuleStoreService(dir, failing, (e) => events.push(e), logger);
    s.startImport(entry());
    await waitFor(() => events.some((e) => e.type === ClusterEventType.CATALOG_IMPORT_FAILED));
    expect(s.getTransientStatus('vllm-0.21')?.state).toBe(CatalogItemState.FAILED);
    expect(s.getTransientStatus('vllm-0.21')?.error).toContain('boom');
  });

  it('listImportedStems ignores temp/dotfiles and returns empty for a missing dir', async () => {
    await writeFile(join(dir, '.vllm-0.21.sif.tmp.123'), 'x');
    await writeFile(join(dir, 'notes.txt'), 'x');
    expect([...(await store.listImportedStems())]).toEqual([]);
    const missing = new ModuleStoreService(
      join(dir, 'nope'),
      new StubImporter(1),
      () => {},
      logger,
    );
    expect((await missing.listImportedStems()).size).toBe(0);
  });

  it('imported stub SIF has the expected placeholder content', async () => {
    store.startImport(entry());
    await waitFor(() => events.some((e) => e.type === ClusterEventType.CATALOG_IMPORT_COMPLETED));
    const content = await readFile(join(dir, 'vllm-0.21.sif'), 'utf8');
    expect(content).toContain('SARDEENZ-DEV-STUB-SIF');
  });
});

describe('OrasImporter command construction', () => {
  it('runs apptainer pull then verify with the ORAS ref', async () => {
    const calls: string[][] = [];
    const run = vi.fn((cmd: string, args: string[]): Promise<RunResult> => {
      calls.push([cmd, ...args]);
      return Promise.resolve({ code: 0, stderr: '' });
    });
    const importer = new OrasImporter({ apptainerBin: 'apptainer', verifySif: true }, run);
    await importer.import(entry(), { tmpPath: '/modules/.tmp.sif', onProgress: () => {} });

    expect(calls[0]).toEqual([
      'apptainer',
      'pull',
      '--force',
      '/modules/.tmp.sif',
      'oras://quay.io/x/vllm:0.21',
    ]);
    expect(calls[1]).toEqual(['apptainer', 'verify', '/modules/.tmp.sif']);
  });

  it('skips verify when verifySif is false', async () => {
    const run = vi.fn(() => Promise.resolve({ code: 0, stderr: '' }));
    const importer = new OrasImporter({ apptainerBin: 'apptainer', verifySif: false }, run);
    await importer.import(entry(), { tmpPath: '/t.sif', onProgress: () => {} });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('throws when apptainer pull fails', async () => {
    const run = vi.fn(() => Promise.resolve({ code: 1, stderr: 'no such artifact' }));
    const importer = new OrasImporter({ apptainerBin: 'apptainer', verifySif: true }, run);
    await expect(
      importer.import(entry(), { tmpPath: '/t.sif', onProgress: () => {} }),
    ).rejects.toThrow(/apptainer pull failed/);
  });

  it('throws when verification fails', async () => {
    const run = vi.fn((_cmd: string, args: string[]) =>
      Promise.resolve(
        args[0] === 'verify' ? { code: 2, stderr: 'bad sig' } : { code: 0, stderr: '' },
      ),
    );
    const importer = new OrasImporter({ apptainerBin: 'apptainer', verifySif: true }, run);
    await expect(
      importer.import(entry(), { tmpPath: '/t.sif', onProgress: () => {} }),
    ).rejects.toThrow(/verification failed/);
  });

  it('rejects a non-ORAS image reference', async () => {
    const run = vi.fn(() => Promise.resolve({ code: 0, stderr: '' }));
    const importer = new OrasImporter({ apptainerBin: 'apptainer', verifySif: true }, run);
    await expect(
      importer.import(entry({ image: 'docker://x/y:1' }), {
        tmpPath: '/t.sif',
        onProgress: () => {},
      }),
    ).rejects.toThrow(/not an ORAS reference/);
    expect(run).not.toHaveBeenCalled();
  });
});
