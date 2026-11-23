import { parse as parseYaml } from 'yaml';

// Maintainer staleness check for the runner catalog's shim provenance (#287).
//
// Pure and dependency-injected: the CLI wrapper (`control-plane/scripts/check-catalog-shim-source.mts`)
// supplies `node:fs` and `git`, tests supply fakes. Deliberately NOT a CI gate — published catalog
// digests lag the dev tree by design, so a hard gate would be permanently red.

export const SHIM_SOURCE_PATTERN = /^[a-f0-9]{40}$/;

/** Minimal catalog-entry shape this check reads; everything else is ignored. */
export interface CatalogShimSourceEntry {
  id: string;
  shimSource?: unknown;
}

export type ShimSourceVerdict = 'current' | 'stale' | 'unset' | 'unverified' | 'invalid';

export interface ShimSourceRow {
  id: string;
  /** Catalog value as written, when it is a string (diagnostic display only). */
  catalogShimSource?: string;
  /** Resolved current source commit, only when git produced a well-formed commit. */
  currentSource?: string;
  verdict: ShimSourceVerdict;
}

// One row per catalog entry, in file order. `currentSource` comes from `git log - <shimPath>`;
// `undefined` (git missing/unusable) degrades every sourced entry to `unverified` rather than
// silently claiming staleness.
export function compareShimSources(
  entries: readonly CatalogShimSourceEntry[],
  currentSource: string | undefined,
): ShimSourceRow[] {
  const resolved =
    currentSource !== undefined && SHIM_SOURCE_PATTERN.test(currentSource)
      ? currentSource
      : undefined;
  return entries.map((entry): ShimSourceRow => {
    const catalogShimSource = entry.shimSource;
    if (catalogShimSource === undefined || catalogShimSource === null) {
      return { id: entry.id, verdict: 'unset' };
    }
    if (typeof catalogShimSource !== 'string' || !SHIM_SOURCE_PATTERN.test(catalogShimSource)) {
      return {
        id: entry.id,
        verdict: 'invalid',
        ...(typeof catalogShimSource === 'string' ? { catalogShimSource } : {}),
      };
    }
    if (resolved === undefined) {
      return { id: entry.id, catalogShimSource, verdict: 'unverified' };
    }
    return {
      id: entry.id,
      catalogShimSource,
      currentSource: resolved,
      verdict: catalogShimSource === resolved ? 'current' : 'stale',
    };
  });
}

// One tab-separated line per row, then a single summary line. No trailing empty string.
export function formatTable(rows: readonly ShimSourceRow[]): string[] {
  const counts: Record<ShimSourceVerdict, number> = {
    current: 0,
    stale: 0,
    unset: 0,
    unverified: 0,
    invalid: 0,
  };
  const lines = rows.map((row) => {
    counts[row.verdict] += 1;
    return [row.id, row.catalogShimSource ?? '-', row.currentSource ?? '-', row.verdict].join('\t');
  });
  lines.push(
    `checked=${rows.length} current=${counts.current} stale=${counts.stale} ` +
      `unset=${counts.unset} unverified=${counts.unverified} invalid=${counts.invalid}`,
  );
  return lines;
}

export interface CheckOptions {
  catalogPath: string;
  /** Repo-relative path handed to `git log -- <shimPath>`. */
  shimPath: string;
  strict: boolean;
}

export interface CheckDeps {
  readCatalog(path: string): Promise<string>;
  /** `undefined` = git unavailable/failed → rows are `unverified`. */
  resolveCurrentSource(shimPath: string): string | undefined;
  stdout(line: string): void;
  stderr(line: string): void;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Reads + parses the catalog, compares it against the resolved source commit, prints the table.
// Exit codes: 0 = no strict-worthy finding, 1 = `--strict` and something is stale/invalid/unverified,
// 2 = usage or catalog error (read/parse/no runners array; a throwing resolver propagates to the CLI).
export async function runCheck(opts: CheckOptions, deps: CheckDeps): Promise<number> {
  let raw: string;
  try {
    raw = await deps.readCatalog(opts.catalogPath);
  } catch (err) {
    deps.stderr(`cannot read catalog ${opts.catalogPath}: ${errorMessage(err)}`);
    return 2;
  }
  let doc: unknown;
  try {
    doc = parseYaml(raw, { maxAliasCount: 100 });
  } catch (err) {
    deps.stderr(`cannot parse catalog ${opts.catalogPath}: ${errorMessage(err)}`);
    return 2;
  }
  let entries: CatalogShimSourceEntry[];
  try {
    entries = extractEntries(doc);
  } catch (err) {
    deps.stderr(`cannot use catalog ${opts.catalogPath}: ${errorMessage(err)}`);
    return 2;
  }
  const rows = compareShimSources(entries, deps.resolveCurrentSource(opts.shimPath));
  for (const line of formatTable(rows)) deps.stdout(line);
  const flagged = rows.some(
    (row) => row.verdict === 'stale' || row.verdict === 'invalid' || row.verdict === 'unverified',
  );
  return opts.strict && flagged ? 1 : 0;
}

export type ParsedArgs =
  | { kind: 'help' }
  | { kind: 'error'; message: string }
  | { kind: 'run'; catalogPath?: string; shimPath?: string; strict: boolean };

export function parseArgs(argv: readonly string[]): ParsedArgs {
  let catalogPath: string | undefined;
  let shimPath: string | undefined;
  let strict = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { kind: 'help' };
    if (arg === '--strict') {
      strict = true;
      continue;
    }
    if (arg === '--catalog' || arg === '--shim-path') {
      const value: string | undefined = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        return { kind: 'error', message: `missing value for ${arg}` };
      }
      if (arg === '--catalog') catalogPath = value;
      else shimPath = value;
      i += 1;
      continue;
    }
    return { kind: 'error', message: `unknown argument '${arg}'` };
  }
  return { kind: 'run', catalogPath, shimPath, strict };
}

/** Throws `Error` when the document has no `runners` array. */
export function extractEntries(doc: unknown): CatalogShimSourceEntry[] {
  if (doc === null || typeof doc !== 'object' || !('runners' in doc)) {
    throw new Error("catalog has no 'runners' array");
  }
  const runners: unknown = doc.runners;
  if (!Array.isArray(runners)) {
    throw new Error("catalog has no 'runners' array");
  }
  const entries: CatalogShimSourceEntry[] = [];
  for (const runner of runners) {
    if (runner === null || typeof runner !== 'object') continue;
    const r = runner as Record<string, unknown>;
    entries.push({ id: typeof r.id === 'string' ? r.id : '(unknown)', shimSource: r.shimSource });
  }
  return entries;
}
