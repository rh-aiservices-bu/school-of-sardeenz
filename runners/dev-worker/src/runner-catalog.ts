/**
 * Runner-catalog capability loader for the worker agent (issue #289). Reads
 * SARDEENZ_RUNNER_CATALOG_URL — an http(s) URL, a local path, or a file:// URL — once at startup
 * and maps each advertised runner family to the capability overrides the catalog declares
 * (supportedModelTypes, version -> engineVersion, maxTensorParallelism, kvCacheElasticSharing,
 * features, ...). The http(s) branch deliberately mirrors the control plane's CatalogService
 * (control-plane/src/services/catalog-service.ts, fetchRaw) so both components give the same env
 * var the same meaning; the worker does not cache or refresh (restart to pick up a change). The
 * fetch refuses redirects and caps the response body, so a hostile or broken origin cannot pivot
 * the worker to another host or exhaust its boot memory.
 *
 * Failures are never fatal: the worker must start on an air-gapped or offline node. Every
 * unresolved runner family emits one console.warn naming the cause, because a silent
 * `kvCacheElasticSharing: false` makes Phase 5 co-location unreachable (#289).
 */
import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';

import type { CatalogCapabilityOverrides } from './registration.js';

/** Startup load: a black-holed network must not hang a Pod's boot indefinitely. */
const FETCH_TIMEOUT_MS = 10_000;

/**
 * runners.yaml is a few KB, so a response past this ceiling is a broken or hostile origin. The
 * timeout bounds the socket, not the body, so buffering it without a bound would let that origin
 * decide how much memory the worker's boot allocates.
 */
const MAX_CATALOG_BYTES = 1024 * 1024;

const TOO_LARGE_ERROR = `Catalog response exceeds the ${MAX_CATALOG_BYTES}-byte limit`;

/**
 * Log-safe form of the catalog URL: userinfo and query string are dropped, because a catalog URL
 * may carry `https://user:token@host/...` or a pre-signed query and every line below lands in the
 * Pod log.
 */
function logSafeUrl(catalogUrl: string): string {
  let url: URL;
  try {
    url = new URL(catalogUrl);
  } catch {
    return catalogUrl; // a local path, not a URL — nothing credentials-shaped to strip
  }
  if (!url.username && !url.password && !url.search) return catalogUrl;
  url.username = '';
  url.password = '';
  url.search = '';
  return url.toString();
}

/** Streams the body, refusing anything past MAX_CATALOG_BYTES (see the constant). */
async function readBodyWithLimit(res: Response): Promise<string> {
  // A declared length over the cap is refused before reading a byte; a chunked response declares
  // none, so the streamed counter below is the real bound.
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_CATALOG_BYTES) {
    throw new Error(TOO_LARGE_ERROR);
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_CATALOG_BYTES) {
      await reader.cancel();
      throw new Error(TOO_LARGE_ERROR);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export interface CatalogLoadOptions {
  /**
   * SARDEENZ_ALLOW_INSECURE_CATALOG — plaintext http:// lets a network attacker rewrite the
   * catalog (spoofed images/ORAS refs), so it is refused unless the operator opts in.
   */
  allowInsecureCatalog?: boolean;
}

async function readCatalogSource(
  catalogUrl: string,
  allowInsecureCatalog: boolean,
): Promise<string> {
  const isPlaintext = /^http:\/\//i.test(catalogUrl);
  if (isPlaintext && !allowInsecureCatalog) {
    throw new Error(
      `Refusing to fetch catalog over http:// (${logSafeUrl(catalogUrl)}) — use https:// or set ` +
        'SARDEENZ_ALLOW_INSECURE_CATALOG=true to opt in',
    );
  }
  if (/^https?:\/\//i.test(catalogUrl)) {
    if (isPlaintext) {
      console.warn(
        `[dev-worker] Fetching runner catalog over plaintext http:// (${logSafeUrl(catalogUrl)}) — ` +
          'SARDEENZ_ALLOW_INSECURE_CATALOG=true is set, so the catalog can be rewritten in transit.',
      );
    }
    const res = await fetch(catalogUrl, {
      cache: 'no-store',
      // A 3xx from the origin (or from a MITM on the plaintext path) must not pivot this fetch to
      // another host: the operator's URL is the only authority the worker talks to.
      redirect: 'error',
      headers: { 'Cache-Control': 'no-cache, no-store', Pragma: 'no-cache' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`Catalog fetch failed: ${res.status} ${res.statusText}`);
    }
    return readBodyWithLimit(res);
  }
  // Local file path (dev) or file:// URL (air-gapped operators mount the catalog).
  const path = catalogUrl.startsWith('file://') ? new URL(catalogUrl).pathname : catalogUrl;
  return readFile(path, 'utf8');
}

export async function loadCatalogCapabilities(
  catalogUrl: string,
  runnerTypes: string[],
  options: CatalogLoadOptions = {},
): Promise<Map<string, CatalogCapabilityOverrides>> {
  const result = new Map<string, CatalogCapabilityOverrides>();
  if (!catalogUrl) {
    // Only reachable by explicitly setting SARDEENZ_RUNNER_CATALOG_URL='' — the config default is
    // the official catalog. Silence here is exactly the #289 bug.
    if (runnerTypes.length > 0) {
      console.warn(
        '[dev-worker] SARDEENZ_RUNNER_CATALOG_URL is empty — no catalog capabilities are ' +
          `advertised for ${runnerTypes.join(', ')} (kvCacheElasticSharing stays false). ` +
          'Point it at a catalog URL or a mounted catalog file.',
      );
    }
    return result;
  }

  try {
    const raw = await readCatalogSource(catalogUrl, options.allowInsecureCatalog ?? false);
    // Explicit alias bound instead of trusting the library default (100 today): the catalog is
    // untrusted input, so a future default change must not turn into an alias bomb.
    const doc = parseYaml(raw, { maxAliasCount: 100 }) as {
      runners?: Array<Record<string, unknown>>;
    };
    for (const runnerType of runnerTypes) {
      const entry = doc.runners?.find((r) => r.runnerType === runnerType);
      if (!entry) continue;
      const overrides: CatalogCapabilityOverrides = {};
      if (Array.isArray(entry.supportedModelTypes)) {
        overrides.supportedModelTypes = entry.supportedModelTypes.filter(
          (v): v is string => typeof v === 'string',
        );
      }
      if (Array.isArray(entry.supportedDeviceTypes)) {
        overrides.supportedDeviceTypes = entry.supportedDeviceTypes.filter(
          (v): v is string => typeof v === 'string',
        );
      }
      if (Array.isArray(entry.supportedSleepLevels)) {
        overrides.supportedSleepLevels = entry.supportedSleepLevels.filter(
          (v): v is string => typeof v === 'string',
        );
      }
      if (typeof entry.version === 'string') overrides.engineVersion = entry.version;
      if (typeof entry.maxTensorParallelism === 'number') {
        overrides.maxTensorParallelism = entry.maxTensorParallelism;
      }
      if (typeof entry.kvCacheElasticSharing === 'boolean') {
        overrides.kvCacheElasticSharing = entry.kvCacheElasticSharing;
      }
      if (entry.features && typeof entry.features === 'object' && !Array.isArray(entry.features)) {
        overrides.features = entry.features as Record<string, unknown>;
      }
      result.set(runnerType, overrides);
    }
  } catch (err) {
    const source = logSafeUrl(catalogUrl);
    const message = (err as Error).message;
    // Fetch/URL-parse errors can quote the raw URL; keep credentials out of that text too.
    const reason = source === catalogUrl ? message : message.replaceAll(catalogUrl, source);
    console.warn(`[dev-worker] Failed to load runner catalog from ${source}: ${reason}`);
    // The capability stays false for every advertised family; say so per family (spec item 4) so
    // the log alone explains why a worker advertises kvCacheElasticSharing: false.
    for (const runnerType of runnerTypes) {
      console.warn(
        `[dev-worker] Runner catalog did not load — runnerType '${runnerType}' advertises ` +
          'kvCacheElasticSharing: false.',
      );
    }
    return result;
  }

  for (const runnerType of runnerTypes) {
    if (!result.has(runnerType)) {
      console.warn(
        `[dev-worker] Runner catalog has no entry for runnerType '${runnerType}' ` +
          `(source: ${logSafeUrl(catalogUrl)}) — its capabilities stay at defaults ` +
          '(kvCacheElasticSharing: false).',
      );
    }
  }
  return result;
}
