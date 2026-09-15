export interface RepoStats {
  readonly stars: number | null;
  readonly forks: number | null;
  readonly fetchedAt: string | null;
}

const NULL_STATS: RepoStats = { stars: null, forks: null, fetchedAt: null };

const SUCCESS_TTL_MS = 60 * 60 * 1000; // 1 hour
const FAILURE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const FETCH_TIMEOUT_MS = 5_000;

interface CacheEntry {
  readonly stats: RepoStats;
  readonly expiresAt: number;
}

export interface GithubRepoStatsClientOptions {
  /** Repository lookup URL. Empty string disables the lookup entirely. */
  url: string;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  /** Injectable clock for tests. */
  now?: () => number;
  /** Injectable debug logger for tests; defaults to a no-op. */
  logDebug?: (msg: string) => void;
}

/**
 * Fetches GitHub star/fork counts for the public repo shown in the dashboard sidebar, server-side
 * so the browser never needs a cross-origin fetch (the BFF's CSP blocks `connect-src` to anything
 * but `'self'`). Caches in memory per process: a success is reused for an hour, a failure (network
 * error, non-2xx, malformed body) is cached for 5 minutes so a disconnected cluster does not retry
 * on every page load. Never throws — callers always get a `RepoStats`, nulls on any failure.
 */
export class GithubRepoStatsClient {
  private readonly url: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private logDebug: (msg: string) => void;
  private cache: CacheEntry | null = null;
  /** Dedupes concurrent cold-cache calls so N simultaneous page loads make one GitHub request. */
  private inflight: Promise<RepoStats> | null = null;

  constructor(options: GithubRepoStatsClientOptions) {
    this.url = options.url;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => Date.now());
    this.logDebug = options.logDebug ?? (() => {});
  }

  /** Wires in the app logger once Fastify has built it (construction happens before that). */
  setLogger(logDebug: (msg: string) => void): void {
    this.logDebug = logDebug;
  }

  async getStats(): Promise<RepoStats> {
    if (!this.url) {
      return NULL_STATS;
    }

    const nowMs = this.now();
    if (this.cache && this.cache.expiresAt > nowMs) {
      return this.cache.stats;
    }

    this.inflight ??= this.fetchStats()
      .then((stats) => {
        const ttl = stats.stars !== null || stats.forks !== null ? SUCCESS_TTL_MS : FAILURE_TTL_MS;
        this.cache = { stats, expiresAt: this.now() + ttl };
        return stats;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  private async fetchStats(): Promise<RepoStats> {
    try {
      const res = await this.fetchImpl(this.url, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'sardeenz-dashboard',
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (!res.ok) {
        this.logDebug(`GitHub repo stats fetch returned ${res.status.toString()}`);
        return NULL_STATS;
      }

      const body = (await res.json()) as { stargazers_count?: unknown; forks_count?: unknown };
      const stars = typeof body.stargazers_count === 'number' ? body.stargazers_count : null;
      const forks = typeof body.forks_count === 'number' ? body.forks_count : null;

      if (stars === null && forks === null) {
        this.logDebug('GitHub repo stats response had no usable stargazers_count/forks_count');
        return NULL_STATS;
      }

      return { stars, forks, fetchedAt: new Date(this.now()).toISOString() };
    } catch (cause) {
      this.logDebug(
        `GitHub repo stats fetch failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
      return NULL_STATS;
    }
  }
}
