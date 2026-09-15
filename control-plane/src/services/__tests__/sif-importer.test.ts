// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Headers, Response, type BodyInit, type RequestInit } from 'undici';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatalogEntry } from '../catalog-service.js';
import { OrasImporter, type FetchFn, type RunFn } from '../sif-importer.js';

const SIF_MEDIA_TYPE = 'application/vnd.sylabs.sif.layer.v1.sif';

function sha256(contents: Uint8Array): string {
  return `sha256:${createHash('sha256').update(contents).digest('hex')}`;
}

function fixture(contents = Buffer.from('a sufficiently interesting fake SIF payload')): {
  blob: Buffer;
  manifest: Buffer;
  entry: CatalogEntry;
} {
  const manifest = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      config: {
        mediaType: 'application/vnd.sylabs.sif.config.v1+json',
        size: 2,
        digest: sha256(Buffer.from('{}')),
      },
      layers: [
        {
          mediaType: SIF_MEDIA_TYPE,
          size: contents.length,
          digest: sha256(contents),
        },
      ],
    }),
  );
  const manifestDigest = sha256(manifest);
  return {
    blob: contents,
    manifest,
    entry: {
      id: 'vllm-test',
      title: 'vLLM test',
      description: 'test',
      runnerType: 'vllm',
      version: 'test',
      image: `oras://registry.example/repository/vllm:test@${manifestDigest}`,
      sifName: 'vllm-test',
      protocol: 'openai' as CatalogEntry['protocol'],
      maxTensorParallelism: 1,
      kvCacheElasticSharing: false,
    },
  };
}

function successfulFetch(f: ReturnType<typeof fixture>, chunked = false): FetchFn {
  return vi.fn((url: string) => {
    if (url.includes('/manifests/')) {
      return Promise.resolve(
        new Response(f.manifest, {
          status: 200,
          headers: { 'content-type': 'application/vnd.oci.image.manifest.v1+json' },
        }),
      );
    }
    if (url.includes('/blobs/')) {
      const body: BodyInit = chunked
        ? (async function* () {
            await Promise.resolve();
            yield f.blob.subarray(0, f.blob.length / 4);
            yield f.blob.subarray(f.blob.length / 4, f.blob.length / 2);
            yield f.blob.subarray(f.blob.length / 2, (f.blob.length * 3) / 4);
            yield f.blob.subarray((f.blob.length * 3) / 4);
          })()
        : f.blob;
      return Promise.resolve(
        new Response(body, {
          status: 200,
          headers: { 'content-length': String(f.blob.length) },
        }),
      );
    }
    throw new Error(`Unexpected URL: ${url}`);
  });
}

describe('OrasImporter', () => {
  let dir: string;
  let tmpPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sardeenz-sif-importer-'));
    tmpPath = join(dir, 'runner.sif');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('streams the SIF layer, reports byte progress, and verifies the completed file', async () => {
    const f = fixture(Buffer.alloc(256 * 1024, 0x5a));
    const run = vi.fn<RunFn>(() => Promise.resolve({ code: 0, stderr: '' }));
    const fetchFn = successfulFetch(f, true);
    const progress: number[] = [];
    const importer = new OrasImporter({ apptainerBin: 'apptainer', verifySif: true }, run, fetchFn);

    await importer.import(f.entry, { tmpPath, onProgress: (value) => progress.push(value) });

    expect(await readFile(tmpPath)).toEqual(f.blob);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenCalledWith('apptainer', ['verify', tmpPath], undefined);
    expect(progress[0]).toBe(1);
    expect(progress).toContain(5);
    expect(progress).toContain(80);
    expect(progress.some((value) => value > 5 && value < 79)).toBe(true);
    expect(progress.at(-1)).toBe(100);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
  });

  it('skips signature verification when it is disabled', async () => {
    const f = fixture();
    const run = vi.fn<RunFn>(() => Promise.resolve({ code: 0, stderr: '' }));
    const importer = new OrasImporter(
      { apptainerBin: 'apptainer', verifySif: false },
      run,
      successfulFetch(f),
    );

    await importer.import(f.entry, { tmpPath, onProgress: () => {} });

    expect(run).not.toHaveBeenCalled();
  });

  it('rejects a manifest that does not match the catalog-pinned digest', async () => {
    const f = fixture();
    const tamperedManifest = Buffer.from(f.manifest);
    tamperedManifest[tamperedManifest.length - 2] ^= 1;
    const fetchFn: FetchFn = vi.fn(() => Promise.resolve(new Response(tamperedManifest)));
    const importer = new OrasImporter(
      { apptainerBin: 'apptainer', verifySif: false },
      vi.fn(),
      fetchFn,
    );

    await expect(importer.import(f.entry, { tmpPath, onProgress: () => {} })).rejects.toThrow(
      /manifest digest mismatch/,
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('rejects a layer whose downloaded bytes do not match its digest', async () => {
    const f = fixture();
    const fetchFn: FetchFn = vi.fn((url: string) =>
      Promise.resolve(
        url.includes('/manifests/')
          ? new Response(f.manifest)
          : new Response(Buffer.alloc(f.blob.length, 0x78), {
              headers: { 'content-length': String(f.blob.length) },
            }),
      ),
    );
    const importer = new OrasImporter(
      { apptainerBin: 'apptainer', verifySif: false },
      vi.fn(),
      fetchFn,
    );

    await expect(importer.import(f.entry, { tmpPath, onProgress: () => {} })).rejects.toThrow(
      /layer digest mismatch/,
    );
  });

  it('rejects a blob Content-Length that disagrees with the manifest descriptor', async () => {
    const f = fixture();
    const fetchFn: FetchFn = vi.fn((url: string) =>
      Promise.resolve(
        url.includes('/manifests/')
          ? new Response(f.manifest)
          : new Response(f.blob, {
              headers: { 'content-length': String(f.blob.length + 1) },
            }),
      ),
    );
    const importer = new OrasImporter(
      { apptainerBin: 'apptainer', verifySif: false },
      vi.fn(),
      fetchFn,
    );

    await expect(importer.import(f.entry, { tmpPath, onProgress: () => {} })).rejects.toThrow(
      /blob size mismatch/,
    );
  });

  it('uses the mounted Docker auth file for a bearer-token challenge', async () => {
    const f = fixture();
    const authFile = join(dir, 'auth.json');
    const basic = Buffer.from('robot:secret').toString('base64');
    await writeFile(authFile, JSON.stringify({ auths: { 'registry.example': { auth: basic } } }));

    const fetchFn: FetchFn = vi.fn((url: string, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get('authorization');
      if (url.startsWith('https://auth.example/token')) {
        expect(authorization).toBe(`Basic ${basic}`);
        return Promise.resolve(new Response(JSON.stringify({ token: 'pull-token' })));
      }
      if (authorization !== 'Bearer pull-token') {
        return Promise.resolve(
          new Response(null, {
            status: 401,
            headers: {
              'www-authenticate':
                'Bearer realm="https://auth.example/token",service="registry.example",scope="repository:repository/vllm:pull"',
            },
          }),
        );
      }
      return Promise.resolve(
        url.includes('/manifests/')
          ? new Response(f.manifest)
          : new Response(f.blob, {
              headers: { 'content-length': String(f.blob.length) },
            }),
      );
    });
    const importer = new OrasImporter(
      {
        apptainerBin: 'apptainer',
        verifySif: false,
        registryAuthFile: authFile,
      },
      vi.fn(),
      fetchFn,
    );

    await importer.import(f.entry, { tmpPath, onProgress: () => {} });

    expect(await readFile(tmpPath)).toEqual(f.blob);
    expect(fetchFn).toHaveBeenCalledTimes(6);
  });

  it('reports signature verification failures', async () => {
    const f = fixture();
    const run = vi.fn<RunFn>(() => Promise.resolve({ code: 2, stderr: 'bad signature' }));
    const importer = new OrasImporter(
      { apptainerBin: 'apptainer', verifySif: true },
      run,
      successfulFetch(f),
    );

    await expect(importer.import(f.entry, { tmpPath, onProgress: () => {} })).rejects.toThrow(
      /signature verification failed/,
    );
  });

  it('rejects non-ORAS and unpinned references before making a request', async () => {
    const f = fixture();
    const fetchFn = successfulFetch(f);
    const importer = new OrasImporter(
      { apptainerBin: 'apptainer', verifySif: false },
      vi.fn(),
      fetchFn,
    );

    for (const image of ['docker://registry.example/x:1', 'oras://registry.example/x:1']) {
      await expect(
        importer.import({ ...f.entry, image }, { tmpPath, onProgress: () => {} }),
      ).rejects.toThrow(/digest-pinned ORAS reference/);
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
