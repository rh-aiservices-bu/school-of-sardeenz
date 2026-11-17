import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';

import { loadCatalogCapabilities } from '../runner-catalog.js';

const FIXTURE = `runners:
  - runnerType: vllm
    version: '0.26'
    kvCacheElasticSharing: true
    maxTensorParallelism: 8
    supportedModelTypes: [LLM]
    supportedDeviceTypes: [CUDA]
    supportedSleepLevels: [L1_HOST_RAM]
    features:
      kvcached: true
  - runnerType: mlserver
    version: '1.7'
    supportedModelTypes: [PREDICTIVE]
`;

// Nested aliases: expanding `d` materializes 10 * (10 + 10*10) alias nodes, well past the 100 cap.
const ALIAS_BOMB = `a: &a [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
b: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]
c: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b]
d: &d [*c, *c, *c, *c, *c, *c, *c, *c, *c, *c]
runners: []
`;

const VLLM_OVERRIDES = {
  supportedModelTypes: ['LLM'],
  supportedDeviceTypes: ['CUDA'],
  supportedSleepLevels: ['L1_HOST_RAM'],
  engineVersion: '0.26',
  maxTensorParallelism: 8,
  kvCacheElasticSharing: true,
  features: { kvcached: true },
};

const openServers: Server[] = [];
let tempDir: string | undefined;

function requireTempDir(): string {
  if (!tempDir) throw new Error('temp dir was not created');
  return tempDir;
}

async function writeCatalogFile(body: string): Promise<string> {
  const file = join(requireTempDir(), 'runners.yaml');
  await writeFile(file, body, 'utf8');
  return file;
}

async function startServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ origin: string; requests: () => number }> {
  let hits = 0;
  const server = createServer((req, res) => {
    hits += 1;
    handler(req, res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  openServers.push(server);
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return { origin: `http://127.0.0.1:${address.port}`, requests: () => hits };
}

async function startCatalogServer(
  body: string,
  status = 200,
): Promise<{ url: string; requests: () => number }> {
  const { origin, requests } = await startServer((_req, res) => {
    res.statusCode = status;
    res.setHeader('content-type', 'application/yaml');
    res.end(body);
  });
  return { url: `${origin}/runners.yaml`, requests };
}

function warnMessages(warn: MockInstance): string[] {
  return warn.mock.calls.map((call) => String(call[0]));
}

describe('loadCatalogCapabilities', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'sardeenz-catalog-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      openServers.splice(0).map(async (server) => {
        server.closeAllConnections();
        // Server#close is a node callback API; Promise.withResolvers is outside this tsconfig's lib.
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }),
    );
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it('applies catalog overrides from a local file path', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const file = await writeCatalogFile(FIXTURE);

    const map = await loadCatalogCapabilities(file, ['vllm', 'mlserver']);

    expect(map.get('vllm')).toEqual(VLLM_OVERRIDES);
    expect(map.get('mlserver')).toEqual({
      supportedModelTypes: ['PREDICTIVE'],
      engineVersion: '1.7',
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('applies catalog overrides from a file:// URL', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const file = await writeCatalogFile(FIXTURE);

    const map = await loadCatalogCapabilities(pathToFileURL(file).href, ['vllm']);

    expect(map.get('vllm')).toEqual(VLLM_OVERRIDES);
    expect(warn).not.toHaveBeenCalled();
  });

  it('fetches an http catalog when SARDEENZ_ALLOW_INSECURE_CATALOG is on, warning about plaintext', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const catalog = await startCatalogServer(FIXTURE);

    const map = await loadCatalogCapabilities(catalog.url, ['vllm'], {
      allowInsecureCatalog: true,
    });

    expect(map.get('vllm')).toEqual(VLLM_OVERRIDES);
    expect(catalog.requests()).toBe(1);
    const messages = warnMessages(warn);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/Fetching runner catalog over plaintext http:\/\//);
    expect(messages[0]).toMatch(/SARDEENZ_ALLOW_INSECURE_CATALOG=true/);
  });

  it('warns once, naming every advertised type, when the URL is explicitly empty', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const map = await loadCatalogCapabilities('', ['vllm', 'mlserver']);

    expect(map.size).toBe(0);
    const messages = warnMessages(warn);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/SARDEENZ_RUNNER_CATALOG_URL is empty/);
    expect(messages[0]).toContain('vllm');
    expect(messages[0]).toContain('mlserver');

    warn.mockClear();
    const empty = await loadCatalogCapabilities('', []);
    expect(empty.size).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns naming the runner type the catalog has no entry for', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const file = await writeCatalogFile(FIXTURE);

    const map = await loadCatalogCapabilities(file, ['vllm', 'smollm']);

    expect(map.has('vllm')).toBe(true);
    expect(map.has('smollm')).toBe(false);
    const messages = warnMessages(warn);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/no entry for runnerType 'smollm'/);
  });

  it('refuses a plaintext http catalog without the opt-in, before any request', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const catalog = await startCatalogServer(FIXTURE);

    const map = await loadCatalogCapabilities(catalog.url, ['vllm']);

    expect(map.size).toBe(0);
    expect(catalog.requests()).toBe(0);
    const messages = warnMessages(warn);
    expect(messages[0]).toMatch(/Refusing to fetch catalog over http:\/\//);
    expect(messages.some((m) => /did not load — runnerType 'vllm'/.test(m))).toBe(true);
  });

  it('warns and keeps defaults on a non-2xx fetch', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const catalog = await startCatalogServer(FIXTURE, 503);

    const map = await loadCatalogCapabilities(catalog.url, ['vllm'], {
      allowInsecureCatalog: true,
    });

    expect(map.size).toBe(0);
    const messages = warnMessages(warn);
    expect(messages.some((m) => /Failed to load runner catalog .* 503/.test(m))).toBe(true);
    expect(messages.some((m) => /did not load — runnerType 'vllm'/.test(m))).toBe(true);
  });

  it('refuses a catalog response streamed past the 1 MiB cap', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { origin, requests } = await startServer((_req, res) => {
      res.setHeader('content-type', 'application/yaml');
      // Two writes → chunked (no content-length), so the streamed byte counter does the work.
      res.write(Buffer.alloc(1024 * 1024, 'x'));
      res.end(Buffer.alloc(4096, 'x'));
    });

    const map = await loadCatalogCapabilities(`${origin}/runners.yaml`, ['vllm'], {
      allowInsecureCatalog: true,
    });

    expect(map.size).toBe(0);
    expect(requests()).toBe(1);
    const sizeWarnings = warnMessages(warn).filter((m) => /exceeds the 1048576-byte limit/.test(m));
    expect(sizeWarnings).toHaveLength(1);
    expect(sizeWarnings[0]).toMatch(/Failed to load runner catalog/);
  });

  it('refuses to follow a redirect from the catalog origin', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const target = await startServer((_req, res) => {
      res.setHeader('content-type', 'application/yaml');
      res.end(FIXTURE);
    });
    const redirector = await startServer((_req, res) => {
      res.statusCode = 302;
      res.setHeader('location', `${target.origin}/runners.yaml`);
      res.end();
    });

    const map = await loadCatalogCapabilities(`${redirector.origin}/runners.yaml`, ['vllm'], {
      allowInsecureCatalog: true,
    });

    expect(map.size).toBe(0);
    expect(redirector.requests()).toBe(1);
    expect(target.requests()).toBe(0);
    const messages = warnMessages(warn);
    expect(messages.some((m) => /Failed to load runner catalog/.test(m))).toBe(true);
    expect(messages.some((m) => /did not load — runnerType 'vllm'/.test(m))).toBe(true);
  });

  it('refuses an alias-bomb catalog document', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const file = await writeCatalogFile(ALIAS_BOMB);

    const map = await loadCatalogCapabilities(file, ['vllm']);

    expect(map.size).toBe(0);
    const messages = warnMessages(warn);
    expect(messages.some((m) => /Failed to load runner catalog/.test(m))).toBe(true);
    expect(messages.some((m) => /Excessive alias count/.test(m))).toBe(true);
    expect(messages.some((m) => /did not load — runnerType 'vllm'/.test(m))).toBe(true);
  });

  it('never logs catalog URL credentials or query strings', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Refusal path: the thrown message names the URL.
    await loadCatalogCapabilities(
      'http://user:s3cret@127.0.0.1:9/runners.yaml?access_token=QUERYSECRET',
      ['vllm'],
    );
    // Failure path: https with credentials against a closed port.
    await loadCatalogCapabilities(
      'https://user:s3cret@127.0.0.1:1/runners.yaml?access_token=QUERYSECRET',
      ['vllm'],
    );

    const messages = warnMessages(warn).join('\n');
    expect(messages).toMatch(/Refusing to fetch catalog over http:\/\//);
    expect(messages).toContain('http://127.0.0.1:9/runners.yaml');
    expect(messages).not.toContain('s3cret');
    expect(messages).not.toContain('QUERYSECRET');
    expect(messages).not.toContain('user:');
  });

  it('warns and keeps defaults when a local catalog file is missing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const missing = join(requireTempDir(), 'nonexistent', 'runners.yaml');

    await expect(loadCatalogCapabilities(missing, ['vllm'])).resolves.toBeInstanceOf(Map);
    const messages = warnMessages(warn);
    expect(messages.some((m) => /Failed to load runner catalog/.test(m))).toBe(true);
    expect(messages.some((m) => /ENOENT/.test(m))).toBe(true);
    expect(messages.some((m) => /did not load — runnerType 'vllm'/.test(m))).toBe(true);
  });
});
