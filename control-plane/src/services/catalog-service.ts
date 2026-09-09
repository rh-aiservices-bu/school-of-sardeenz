import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { Protocol, type ControlPlaneComponents } from '@sardeenz/types';

export type CatalogEntry = ControlPlaneComponents['schemas']['CatalogEntry'];

export interface CatalogInvalidEntry {
  id?: string;
  reason: string;
}

export interface CatalogSnapshot {
  source: string;
  fetchedAt: string;
  entries: CatalogEntry[];
  invalidEntries: CatalogInvalidEntry[];
}

// Result of validating one raw catalog entry: either the constructed entry, or a loud,
// actionable reason it was rejected (surfaced to the importer via CatalogSnapshot.invalidEntries
// rather than silently vanishing).
type ValidateEntryResult = { entry: CatalogEntry } | { error: string; id?: string };

export interface CatalogLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

const NAME_RE = /^[A-Za-z0-9_.-]+$/;
const FETCH_TIMEOUT_MS = 15_000;

// Loads the runner catalog from SARDEENZ_RUNNER_CATALOG_URL: an http(s) URL (official/remote
// catalog) or a local file path / file:// URL (dev). Parses the YAML, validates entries, caches.
export class CatalogService {
  private cache: CatalogSnapshot | null = null;

  constructor(
    private readonly source: string,
    private readonly logger: CatalogLogger,
    // Injectable for tests.
    private readonly deps: {
      fetch?: typeof fetch;
      readFile?: (path: string) => Promise<string>;
      allowInsecureCatalog?: boolean;
    } = {},
  ) {}

  getCached(): CatalogSnapshot | null {
    return this.cache;
  }

  // Return the cached snapshot, loading it once if absent. Use refresh() to force a re-fetch.
  async load(): Promise<CatalogSnapshot> {
    if (this.cache) return this.cache;
    return this.refresh();
  }

  async refresh(): Promise<CatalogSnapshot> {
    const raw = await this.fetchRaw();
    const { entries, invalidEntries } = this.parse(raw);
    this.cache = {
      source: this.source,
      fetchedAt: new Date().toISOString(),
      entries,
      invalidEntries,
    };
    this.logger.info(
      { source: this.source, count: entries.length, invalid: invalidEntries.length },
      'Loaded runner catalog',
    );
    return this.cache;
  }

  // Resolve deploy-time runner metadata (protocol + optional entrypoint) by runnerType. Never
  // throws — deploy must not fail because the catalog is briefly unreachable, and a runnerType
  // absent from the catalog can't produce a working runner regardless, so both cases fail open to
  // the byte-identical pre-MLServer default (openai, no entrypoint override).
  async resolveRunnerMetadata(
    runnerType: string,
  ): Promise<{ protocol: Protocol; entrypoint?: string[] }> {
    let snapshot = this.cache;
    if (!snapshot) {
      try {
        snapshot = await this.load();
      } catch {
        snapshot = null;
      }
    }
    const entry = snapshot?.entries.find((e) => e.runnerType === runnerType);
    if (!entry) return { protocol: Protocol.openai };
    return {
      protocol: (entry.protocol as string) === 'oip' ? Protocol.oip : Protocol.openai,
      ...(entry.entrypoint?.length ? { entrypoint: entry.entrypoint } : {}),
    };
  }

  private async fetchRaw(): Promise<string> {
    if (/^https?:\/\//i.test(this.source)) {
      // Plaintext http:// lets a network attacker rewrite the catalog in transit (spoofed images,
      // rewritten ORAS refs). Require https unless the operator explicitly opts in.
      if (/^http:\/\//i.test(this.source) && !this.deps.allowInsecureCatalog) {
        throw new Error(
          `Refusing to fetch catalog over http:// (${this.source}) — use https:// or set ` +
            'SARDEENZ_ALLOW_INSECURE_CATALOG=true to opt in',
        );
      }
      const fetchImpl = this.deps.fetch ?? fetch;
      // A refresh must reach the origin even when the catalog is hosted behind a CDN (the
      // official raw GitHub URL is one such source). The unique query parameter defeats shared
      // intermediary caches; the request directives also prevent a conforming cache from
      // satisfying the request with a stored response.
      const url = new URL(this.source);
      url.searchParams.set('_sardeenz_refresh', `${Date.now()}`);
      const res = await fetchImpl(url, {
        cache: 'no-store',
        headers: {
          'Cache-Control': 'no-cache, no-store',
          Pragma: 'no-cache',
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        throw new Error(`Catalog fetch failed: ${res.status} ${res.statusText}`);
      }
      return res.text();
    }
    // Local file path (dev) or file:// URL.
    const path = this.source.startsWith('file://') ? new URL(this.source).pathname : this.source;
    const readFileImpl = this.deps.readFile ?? ((p: string) => readFile(p, 'utf8'));
    return readFileImpl(path);
  }

  // Parse + validate. Invalid entries are excluded from `entries` (logged, and surfaced in
  // `invalidEntries`) rather than failing the whole catalog.
  private parse(raw: string): { entries: CatalogEntry[]; invalidEntries: CatalogInvalidEntry[] } {
    const doc = parseYaml(raw) as unknown;
    if (!doc || typeof doc !== 'object') {
      throw new Error('Catalog is not a valid YAML document');
    }
    const runners = (doc as { runners?: unknown }).runners;
    if (!Array.isArray(runners)) {
      throw new Error("Catalog is missing a 'runners' array");
    }

    const entries: CatalogEntry[] = [];
    const invalidEntries: CatalogInvalidEntry[] = [];
    const seenIds = new Set<string>();
    const seenSifNames = new Set<string>();
    for (const raw of runners) {
      const result = this.validateEntry(raw);
      if ('error' in result) {
        invalidEntries.push({ id: result.id, reason: result.error });
        continue;
      }
      const { entry } = result;
      if (seenIds.has(entry.id)) {
        const reason = 'Duplicate catalog entry id';
        this.logger.warn({ id: entry.id }, `${reason} — skipping`);
        invalidEntries.push({ id: entry.id, reason });
        continue;
      }
      // Two entries sharing a sifName would alias the same module file (import/uninstall of one
      // would flip the other's state, and concurrent imports would race the same path).
      if (seenSifNames.has(entry.sifName)) {
        const reason = 'Duplicate catalog sifName';
        this.logger.warn({ id: entry.id, sifName: entry.sifName }, `${reason} — skipping`);
        invalidEntries.push({ id: entry.id, reason });
        continue;
      }
      seenIds.add(entry.id);
      seenSifNames.add(entry.sifName);
      entries.push(entry);
    }
    return { entries, invalidEntries };
  }

  private validateEntry(raw: unknown): ValidateEntryResult {
    if (!raw || typeof raw !== 'object') {
      const reason = 'Catalog entry is not an object';
      this.logger.warn({}, `${reason} — skipping`);
      return { error: reason };
    }
    const e = raw as Record<string, unknown>;
    const idIfString = typeof e.id === 'string' ? e.id : undefined;
    const required = ['id', 'title', 'description', 'runnerType', 'version', 'image', 'sifName'];
    for (const key of required) {
      const value = e[key];
      if (typeof value !== 'string' || value.length === 0) {
        const reason = `Catalog entry missing required string field '${key}'`;
        this.logger.warn({ key, id: e.id }, `${reason} — skipping`);
        return { error: reason, id: idIfString };
      }
    }
    if (!NAME_RE.test(e.id as string) || !NAME_RE.test(e.sifName as string)) {
      const reason = 'Catalog entry id/sifName invalid';
      this.logger.warn({ id: e.id, sifName: e.sifName }, `${reason} — skipping`);
      return { error: reason, id: idIfString };
    }
    // ORAS refs must be digest-pinned: a mutable tag can be repointed after the catalog entry was
    // reviewed, silently changing what gets pulled onto the module store. Local/dev image refs
    // (used outside ORAS import) are unaffected.
    const image = e.image as string;
    if (image.startsWith('oras://') && !/@sha256:[a-fA-F0-9]{64}$/.test(image)) {
      const reason = 'Catalog entry ORAS image missing @sha256: digest';
      this.logger.warn({ id: e.id, image }, `${reason} — skipping`);
      return { error: reason, id: idIfString };
    }
    // protocol is required (#125): a routing entry cannot be written without one, and the proxy
    // rejects a routing entry missing it. Validated loudly (logger.error, not warn) — unlike the
    // other soft-invalid checks above, an operator needs to notice this one to fix the catalog.
    const protocol = e.protocol;
    if (protocol !== 'openai' && protocol !== 'oip') {
      const reason =
        `runner '${idIfString ?? '?'}' has missing/invalid 'protocol' ` +
        `(expected 'openai' or 'oip', got ${JSON.stringify(protocol)}); a proxy that speaks it must be running`;
      this.logger.error({ id: e.id, protocol }, `${reason} — skipping`);
      return { error: reason, id: idIfString };
    }
    const entry: CatalogEntry = {
      id: e.id as string,
      title: e.title as string,
      description: e.description as string,
      runnerType: e.runnerType as string,
      version: e.version as string,
      image: e.image as string,
      sifName: e.sifName as string,
      protocol: protocol as CatalogEntry['protocol'],
      maxTensorParallelism: 1,
      kvCacheElasticSharing: false,
    };
    if (typeof e.engine === 'string') entry.engine = e.engine;
    if (typeof e.license === 'string') entry.license = e.license;
    if (typeof e.icon === 'string') entry.icon = e.icon;
    if (typeof e.minVRAMGiB === 'number') entry.minVRAMGiB = e.minVRAMGiB;
    if (Array.isArray(e.tags))
      entry.tags = e.tags.filter((t): t is string => typeof t === 'string');
    if (Array.isArray(e.supportedModelTypes)) {
      entry.supportedModelTypes = e.supportedModelTypes.filter(
        (v): v is string => typeof v === 'string',
      ) as CatalogEntry['supportedModelTypes'];
    }
    if (Array.isArray(e.supportedDeviceTypes)) {
      entry.supportedDeviceTypes = e.supportedDeviceTypes.filter(
        (v): v is string => typeof v === 'string',
      ) as CatalogEntry['supportedDeviceTypes'];
    }
    if (Array.isArray(e.supportedSleepLevels)) {
      entry.supportedSleepLevels = e.supportedSleepLevels.filter(
        (v): v is string => typeof v === 'string',
      ) as CatalogEntry['supportedSleepLevels'];
    }
    if (typeof e.maxTensorParallelism === 'number') {
      entry.maxTensorParallelism = e.maxTensorParallelism;
    }
    if (typeof e.kvCacheElasticSharing === 'boolean') {
      entry.kvCacheElasticSharing = e.kvCacheElasticSharing;
    }
    if (e.features && typeof e.features === 'object' && !Array.isArray(e.features)) {
      entry.features = e.features as Record<string, unknown>;
    }
    if (Array.isArray(e.entrypoint)) {
      const argv = e.entrypoint.filter((t): t is string => typeof t === 'string');
      if (argv.length) entry.entrypoint = argv;
    }
    return { entry };
  }
}
