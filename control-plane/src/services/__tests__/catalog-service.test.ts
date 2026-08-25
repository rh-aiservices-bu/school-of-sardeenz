// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { Protocol } from '@sardeenz/types';
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
    image: oras://quay.io/x/vllm:0.21@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
    sifName: vllm-0.21
    protocol: openai
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
      protocol: 'openai',
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
    image: oras://x/y:1@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
    sifName: good
    protocol: openai
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
    image: oras://x/y:1@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
    sifName: ../../etc/x
`;
    const svc = new CatalogService('/c.yaml', logger, { readFile: () => Promise.resolve(yaml) });
    const snap = await svc.load();
    expect(snap.entries).toHaveLength(0);
  });

  it('deduplicates entries by id', async () => {
    const yaml = `
runners:
  - { id: dup, title: A, description: d, runnerType: vllm, version: "1", image: "oras://x:1@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", sifName: dup, protocol: openai }
  - { id: dup, title: B, description: d, runnerType: vllm, version: "2", image: "oras://x:2@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", sifName: dup, protocol: openai }
`;
    const svc = new CatalogService('/c.yaml', logger, { readFile: () => Promise.resolve(yaml) });
    const snap = await svc.load();
    expect(snap.entries).toHaveLength(1);
  });

  it('deduplicates entries by sifName (aliasing the same module file)', async () => {
    const yaml = `
runners:
  - { id: a, title: A, description: d, runnerType: vllm, version: "1", image: "oras://x:1@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", sifName: shared, protocol: openai }
  - { id: b, title: B, description: d, runnerType: vllm, version: "2", image: "oras://x:2@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", sifName: shared, protocol: openai }
`;
    const svc = new CatalogService('/c.yaml', logger, { readFile: () => Promise.resolve(yaml) });
    const snap = await svc.load();
    expect(snap.entries.map((e) => e.id)).toEqual(['a']);
  });

  it('throws when the runners array is missing', async () => {
    const svc = new CatalogService('/c.yaml', logger, {
      readFile: () => Promise.resolve('apiVersion: x'),
    });
    await expect(svc.load()).rejects.toThrow(/runners/);
  });

  it('defaults maxTensorParallelism and kvCacheElasticSharing when absent', async () => {
    const svc = new CatalogService('/catalog.yaml', logger, {
      readFile: () => Promise.resolve(VALID),
    });
    const snap = await svc.load();
    expect(snap.entries[0].maxTensorParallelism).toBe(1);
    expect(snap.entries[0].kvCacheElasticSharing).toBe(false);
    expect(snap.entries[0].supportedModelTypes).toBeUndefined();
    expect(snap.entries[0].features).toBeUndefined();
  });

  it('parses capability fields when present', async () => {
    const yaml = `
runners:
  - id: vllm-0.21
    title: vLLM 0.21
    description: desc
    runnerType: vllm
    version: "0.21"
    image: oras://quay.io/x/vllm:0.21@sha256:${'a'.repeat(64)}
    sifName: vllm-0.21
    protocol: openai
    supportedModelTypes: [LLM]
    supportedDeviceTypes: [CUDA]
    supportedSleepLevels: [L1_HOST_RAM]
    maxTensorParallelism: 8
    kvCacheElasticSharing: true
    features:
      streamingInference: true
      prefixCaching: false
`;
    const svc = new CatalogService('/c.yaml', logger, { readFile: () => Promise.resolve(yaml) });
    const snap = await svc.load();
    expect(snap.entries[0]).toMatchObject({
      supportedModelTypes: ['LLM'],
      supportedDeviceTypes: ['CUDA'],
      supportedSleepLevels: ['L1_HOST_RAM'],
      maxTensorParallelism: 8,
      kvCacheElasticSharing: true,
      features: { streamingInference: true, prefixCaching: false },
    });
  });

  it('ignores capability fields with the wrong type', async () => {
    const yaml = `
runners:
  - id: vllm-0.21
    title: vLLM 0.21
    description: desc
    runnerType: vllm
    version: "0.21"
    image: oras://quay.io/x/vllm:0.21@sha256:${'a'.repeat(64)}
    sifName: vllm-0.21
    protocol: openai
    maxTensorParallelism: "eight"
    kvCacheElasticSharing: "yes"
    features: [not, an, object]
`;
    const svc = new CatalogService('/c.yaml', logger, { readFile: () => Promise.resolve(yaml) });
    const snap = await svc.load();
    expect(snap.entries[0].maxTensorParallelism).toBe(1);
    expect(snap.entries[0].kvCacheElasticSharing).toBe(false);
    expect(snap.entries[0].features).toBeUndefined();
  });
});

describe('CatalogService ORAS image digest pinning', () => {
  it('rejects an ORAS image without an @sha256: digest', async () => {
    const yaml = `
runners:
  - id: nodigest
    title: No Digest
    description: d
    runnerType: vllm
    version: "1"
    image: oras://quay.io/x/vllm:0.21
    sifName: nodigest
`;
    const svc = new CatalogService('/c.yaml', logger, { readFile: () => Promise.resolve(yaml) });
    const snap = await svc.load();
    expect(snap.entries).toHaveLength(0);
  });

  it('accepts an ORAS image with an @sha256: digest', async () => {
    const yaml = `
runners:
  - id: digest
    title: Digest
    description: d
    runnerType: vllm
    version: "1"
    image: oras://quay.io/x/vllm:0.21@sha256:${'a'.repeat(64)}
    sifName: digest
    protocol: openai
`;
    const svc = new CatalogService('/c.yaml', logger, { readFile: () => Promise.resolve(yaml) });
    const snap = await svc.load();
    expect(snap.entries.map((e) => e.id)).toEqual(['digest']);
  });

  it('accepts a non-ORAS image without a digest (local dev)', async () => {
    const yaml = `
runners:
  - id: local
    title: Local
    description: d
    runnerType: vllm
    version: "1"
    image: /modules/vllm-0.21.sif
    sifName: local
    protocol: openai
`;
    const svc = new CatalogService('/c.yaml', logger, { readFile: () => Promise.resolve(yaml) });
    const snap = await svc.load();
    expect(snap.entries.map((e) => e.id)).toEqual(['local']);
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

  it('throws on an http:// catalog source without allowInsecureCatalog', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const svc = new CatalogService('http://example.com/runners.yaml', logger, {
      fetch: fetchImpl,
    });
    await expect(svc.load()).rejects.toThrow(/http:\/\//);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('allows an http:// catalog source with allowInsecureCatalog opted in', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response(VALID, { status: 200 })),
    ) as unknown as typeof fetch;
    const svc = new CatalogService('http://example.com/runners.yaml', logger, {
      fetch: fetchImpl,
      allowInsecureCatalog: true,
    });
    const snap = await svc.load();
    expect(snap.entries).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('CatalogService protocol validation (#125)', () => {
  it('loudly rejects an entry missing protocol', async () => {
    const yaml = `
runners:
  - id: noproto
    title: No Protocol
    description: d
    runnerType: vllm
    version: "1"
    image: oras://x/y:1@sha256:${'a'.repeat(64)}
    sifName: noproto
`;
    const svc = new CatalogService('/c.yaml', logger, { readFile: () => Promise.resolve(yaml) });
    const snap = await svc.load();
    expect(snap.entries).toHaveLength(0);
    expect(snap.invalidEntries).toEqual([
      { id: 'noproto', reason: expect.stringMatching(/protocol/i) as string },
    ]);
    expect(logger.error).toHaveBeenCalled();
  });

  it('rejects an invalid protocol value', async () => {
    const yaml = `
runners:
  - id: badproto
    title: Bad Protocol
    description: d
    runnerType: vllm
    version: "1"
    image: oras://x/y:1@sha256:${'a'.repeat(64)}
    sifName: badproto
    protocol: grpc
`;
    const svc = new CatalogService('/c.yaml', logger, { readFile: () => Promise.resolve(yaml) });
    const snap = await svc.load();
    expect(snap.entries).toHaveLength(0);
    expect(snap.invalidEntries).toEqual([
      { id: 'badproto', reason: expect.stringMatching(/protocol/i) as string },
    ]);
  });

  it('parses entrypoint when present', async () => {
    const yaml = `
runners:
  - id: mlserver-1.6
    title: MLServer
    description: d
    runnerType: mlserver
    version: "1.6"
    image: oras://x/y:1@sha256:${'a'.repeat(64)}
    sifName: mlserver-1.6
    protocol: oip
    entrypoint: [python3, -m, sardeenz_mlserver_runner]
`;
    const svc = new CatalogService('/c.yaml', logger, { readFile: () => Promise.resolve(yaml) });
    const snap = await svc.load();
    expect(snap.entries[0].entrypoint).toEqual(['python3', '-m', 'sardeenz_mlserver_runner']);
  });

  it('ignores non-array entrypoint', async () => {
    const yaml = `
runners:
  - id: mlserver-1.6
    title: MLServer
    description: d
    runnerType: mlserver
    version: "1.6"
    image: oras://x/y:1@sha256:${'a'.repeat(64)}
    sifName: mlserver-1.6
    protocol: oip
    entrypoint: "not-an-array"
`;
    const svc = new CatalogService('/c.yaml', logger, { readFile: () => Promise.resolve(yaml) });
    const snap = await svc.load();
    expect(snap.entries[0].entrypoint).toBeUndefined();
  });
});

describe('CatalogService.resolveRunnerMetadata', () => {
  const CATALOG = `
runners:
  - id: vllm-0.21
    title: vLLM 0.21
    description: d
    runnerType: vllm
    version: "0.21"
    image: oras://x/y:1@sha256:${'a'.repeat(64)}
    sifName: vllm-0.21
    protocol: openai
  - id: mlserver-1.6
    title: MLServer
    description: d
    runnerType: mlserver
    version: "1.6"
    image: oras://x/y:2@sha256:${'a'.repeat(64)}
    sifName: mlserver-1.6
    protocol: oip
    entrypoint: [python3, -m, sardeenz_mlserver_runner]
`;

  it('resolves protocol + entrypoint for a cataloged oip runnerType', async () => {
    const svc = new CatalogService('/c.yaml', logger, {
      readFile: () => Promise.resolve(CATALOG),
    });
    await svc.load();
    expect(await svc.resolveRunnerMetadata('mlserver')).toEqual({
      protocol: Protocol.oip,
      entrypoint: ['python3', '-m', 'sardeenz_mlserver_runner'],
    });
  });

  it('resolves protocol without entrypoint for a cataloged openai runnerType', async () => {
    const svc = new CatalogService('/c.yaml', logger, {
      readFile: () => Promise.resolve(CATALOG),
    });
    await svc.load();
    expect(await svc.resolveRunnerMetadata('vllm')).toEqual({ protocol: Protocol.openai });
  });

  it('defaults to openai for an unknown runnerType', async () => {
    const svc = new CatalogService('/c.yaml', logger, {
      readFile: () => Promise.resolve(CATALOG),
    });
    await svc.load();
    expect(await svc.resolveRunnerMetadata('unknown')).toEqual({ protocol: Protocol.openai });
  });

  it('defaults to openai (never throws) when the catalog source fails to load', async () => {
    const svc = new CatalogService('/c.yaml', logger, {
      readFile: () => Promise.reject(new Error('ENOENT')),
    });
    await expect(svc.resolveRunnerMetadata('mlserver')).resolves.toEqual({
      protocol: Protocol.openai,
    });
  });
});
