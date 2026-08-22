import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import type { ControlPlaneComponents } from '@sardeenz/types';

export type CatalogEntry = ControlPlaneComponents['schemas']['CatalogEntry'];

export interface CatalogSnapshot {
  source: string;
  fetchedAt: string;
  entries: CatalogEntry[];
}

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
    const entries = this.parse(raw);
    this.cache = { source: this.source, fetchedAt: new Date().toISOString(), entries };
    this.logger.info({ source: this.source, count: entries.length }, 'Loaded runner catalog');
    return this.cache;
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
      const res = await fetchImpl(this.source, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
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

  // Parse + validate. Invalid entries are skipped (logged) rather than failing the whole catalog.
  private parse(raw: string): CatalogEntry[] {
    const doc = parseYaml(raw) as unknown;
    if (!doc || typeof doc !== 'object') {
      throw new Error('Catalog is not a valid YAML document');
    }
    const runners = (doc as { runners?: unknown }).runners;
    if (!Array.isArray(runners)) {
      throw new Error("Catalog is missing a 'runners' array");
    }

    const entries: CatalogEntry[] = [];
    const seenIds = new Set<string>();
    const seenSifNames = new Set<string>();
    for (const raw of runners) {
      const entry = this.validateEntry(raw);
      if (!entry) continue;
      if (seenIds.has(entry.id)) {
        this.logger.warn({ id: entry.id }, 'Duplicate catalog entry id — skipping');
        continue;
      }
      // Two entries sharing a sifName would alias the same module file (import/uninstall of one
      // would flip the other's state, and concurrent imports would race the same path).
      if (seenSifNames.has(entry.sifName)) {
        this.logger.warn(
          { id: entry.id, sifName: entry.sifName },
          'Duplicate catalog sifName — skipping',
        );
        continue;
      }
      seenIds.add(entry.id);
      seenSifNames.add(entry.sifName);
      entries.push(entry);
    }
    return entries;
  }

  private validateEntry(raw: unknown): CatalogEntry | null {
    if (!raw || typeof raw !== 'object') {
      this.logger.warn({}, 'Catalog entry is not an object — skipping');
      return null;
    }
    const e = raw as Record<string, unknown>;
    const required = ['id', 'title', 'description', 'runnerType', 'version', 'image', 'sifName'];
    for (const key of required) {
      const value = e[key];
      if (typeof value !== 'string' || value.length === 0) {
        this.logger.warn(
          { key, id: e.id },
          'Catalog entry missing required string field — skipping',
        );
        return null;
      }
    }
    if (!NAME_RE.test(e.id as string) || !NAME_RE.test(e.sifName as string)) {
      this.logger.warn(
        { id: e.id, sifName: e.sifName },
        'Catalog entry id/sifName invalid — skipping',
      );
      return null;
    }
    // ORAS refs must be digest-pinned: a mutable tag can be repointed after the catalog entry was
    // reviewed, silently changing what gets pulled onto the module store. Local/dev image refs
    // (used outside ORAS import) are unaffected.
    const image = e.image as string;
    if (image.startsWith('oras://') && !/@sha256:[a-fA-F0-9]{64}$/.test(image)) {
      this.logger.warn(
        { id: e.id, image },
        'Catalog entry ORAS image missing @sha256: digest — skipping',
      );
      return null;
    }
    const entry: CatalogEntry = {
      id: e.id as string,
      title: e.title as string,
      description: e.description as string,
      runnerType: e.runnerType as string,
      version: e.version as string,
      image: e.image as string,
      sifName: e.sifName as string,
    };
    if (typeof e.engine === 'string') entry.engine = e.engine;
    if (typeof e.license === 'string') entry.license = e.license;
    if (typeof e.icon === 'string') entry.icon = e.icon;
    if (typeof e.minVRAMGiB === 'number') entry.minVRAMGiB = e.minVRAMGiB;
    if (Array.isArray(e.tags))
      entry.tags = e.tags.filter((t): t is string => typeof t === 'string');
    return entry;
  }
}
