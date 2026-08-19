// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { CatalogService } from '../catalog-service.js';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const VALID = `
apiVersion: sardeenz.io/v1
kind: RunnerCatalog
runners:
  - id: vllm-0.21
    title: vLLM 0.21
    description: desc
    engine: vLLM
    runnerType: vllm
    version: "0.21"
    image: oras://quay.io/x/vllm:0.21
    sifName: vllm-0.21
    tags: [llm, cuda]
    minVRAMGiB: 16
`;

describe('CatalogService.parse (via file source)', () => {
  it('parses a valid catalog and keeps optional fields', async () => {
    const svc = new CatalogService('/catalog.yaml', logger, {
      readFile: () => Promise.resolve(VALID),
    });
    const snap = await svc.load();
    expect(snap.entries).toHaveLength(1);
    expect(snap.entries[0]).toMatchObject({
      id: 'vllm-0.21',
      runnerType: 'vllm',
      sifName: 'vllm-0.21',
      minVRAMGiB: 16,
      tags: ['llm', 'cuda'],
    });
  });

  it('skips entries missing required fields but keeps valid ones', async () => {
    const yaml = `
runners:
  - id: good
    title: Good
    description: d
    runnerType: vllm
    version: "1"
    image: oras://x/y:1
    sifName: good
  - id: bad
    title: Missing fields
`;
    const svc = new CatalogService('/c.yaml', logger, { readFile: () => Promise.resolve(yaml) });
    const snap = await svc.load();
    expect(snap.entries.map((e) => e.id)).toEqual(['good']);
  });

  it('rejects entries with a path-traversal sifName', async () => {
    const yaml = `
runners:
  - id: evil
    title: Evil
    description: d
    runnerType: vllm
    version: "1"
    image: oras://x/y:1
    sifName: ../../etc/x
`;
    const svc = new CatalogService('/c.yaml', logger, { readFile: () => Promise.resolve(yaml) });
    const snap = await svc.load();
    expect(snap.entries).toHaveLength(0);
  });

  it('deduplicates entries by id', async () => {
    const yaml = `
runners:
  - { id: dup, title: A, description: d, runnerType: vllm, version: "1", image: oras://x:1, sifName: dup }
  - { id: dup, title: B, description: d, runnerType: vllm, version: "2", image: oras://x:2, sifName: dup }
`;
    const svc = new CatalogService('/c.yaml', logger, { readFile: () => Promise.resolve(yaml) });
    const snap = await svc.load();
    expect(snap.entries).toHaveLength(1);
  });

  it('throws when the runners array is missing', async () => {
    const svc = new CatalogService('/c.yaml', logger, {
      readFile: () => Promise.resolve('apiVersion: x'),
    });
    await expect(svc.load()).rejects.toThrow(/runners/);
  });
});

describe('CatalogService http source', () => {
  it('fetches over http and caches until refresh', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response(VALID, { status: 200 })),
    ) as unknown as typeof fetch;
    const svc = new CatalogService('https://example.com/runners.yaml', logger, {
      fetch: fetchImpl,
    });

    await svc.load();
    await svc.load(); // cached — no second fetch
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await svc.refresh(); // forces a re-fetch
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('throws on a non-ok http response', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response('nope', { status: 404, statusText: 'Not Found' })),
    ) as unknown as typeof fetch;
    const svc = new CatalogService('https://example.com/runners.yaml', logger, {
      fetch: fetchImpl,
    });
    await expect(svc.load()).rejects.toThrow(/404/);
  });
});
