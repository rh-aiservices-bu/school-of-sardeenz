import {
  RunnerByInstanceResponseState,
  RunnerProcessState,
  type WorkerAgentComponents,
} from '@sardeenz/types';

export type StartRunnerRequest = WorkerAgentComponents['schemas']['StartRunnerRequest'];
export type StartRunnerResponse = WorkerAgentComponents['schemas']['StartRunnerResponse'];
export type RunnerByInstanceResponse = WorkerAgentComponents['schemas']['RunnerByInstanceResponse'];
export type RunnerSummary = WorkerAgentComponents['schemas']['RunnerSummary'];
export type RunnerListResponse = WorkerAgentComponents['schemas']['RunnerListResponse'];

export type RunnerByInstanceLookup =
  | { status: 'absent' }
  | { status: 'starting'; runnerId: string }
  | {
      status: 'ready';
      runnerId: string;
      host: string;
      port: number;
      enginePort: number;
    };

/**
 * Thrown by `stopRunner` on a non-OK response. Carries the HTTP status so callers can distinguish
 * "runner already gone" (404 — the worker no longer tracks it, already exited and reaped) from a
 * genuine failure, without matching on the message text (a response body that happens to contain
 * the substring "returned 404" must not be misclassified as the 404 case — round-3 review, #157).
 */
export class WorkerHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'WorkerHttpError';
  }
}

/**
 * Thrown when a worker answered 2xx with a body the contract does not allow: over the size cap,
 * not JSON, or not the promised shape. Distinct from `WorkerHttpError`, which reports a status the
 * worker chose — here the status is fine and the payload is not, so callers must treat the call as
 * an inconclusive probe rather than as evidence about the worker's runners.
 */
export class WorkerResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkerResponseError';
  }
}

/**
 * A runner registry is a handful of entries, so a response past this ceiling is a broken or
 * hostile worker. The socket timeout bounds time, not size: buffering an arbitrary body would let
 * that worker decide how much memory the single-replica control plane allocates (the same rule the
 * worker applies to the runner catalog, `runners/dev-worker/src/runner-catalog.ts`).
 */
const MAX_RESPONSE_BODY_BYTES = 1024 * 1024;

const BODY_TOO_LARGE = `Response body exceeds the ${MAX_RESPONSE_BODY_BYTES}-byte limit for a worker API response`;

/** Reads a response body, refusing anything past MAX_RESPONSE_BODY_BYTES (see the constant). */
async function readBodyWithLimit(response: Response): Promise<string> {
  // A declared length over the cap is refused before reading a byte; a chunked response declares
  // none, so the streamed counter below is the real bound.
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BODY_BYTES) {
    // Refusing without releasing the body would leave the worker streaming into a socket nobody
    // reads; the streamed path below cancels its reader for the same reason.
    await response.body?.cancel().catch(() => {});
    throw new WorkerResponseError(BODY_TOO_LARGE);
  }
  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BODY_BYTES) {
      await reader.cancel();
      throw new WorkerResponseError(BODY_TOO_LARGE);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Validates one registry entry against the contract's required fields (`RunnerSummary`:
 * `runnerId`, `instanceId`, `modelName`, `state`). Only the fields the reverse sweep acts on are
 * checked — the sweep decides who to kill from CP records, never from worker-advertised extras.
 */
function parseRunnerSummary(raw: unknown, index: number): RunnerSummary {
  if (raw === null || typeof raw !== 'object') {
    throw new WorkerResponseError(`Worker registry entry runners[${index}] is not an object`);
  }
  const entry = raw as Record<string, unknown>;
  for (const field of ['runnerId', 'instanceId', 'modelName'] as const) {
    const value = entry[field];
    if (typeof value !== 'string' || value.length === 0) {
      throw new WorkerResponseError(
        `Worker registry entry runners[${index}].${field} must be a non-empty string`,
      );
    }
  }
  const state = entry['state'];
  if (state !== RunnerProcessState.STARTING && state !== RunnerProcessState.READY) {
    throw new WorkerResponseError(
      `Worker registry entry runners[${index}].state must be a RunnerProcessState value`,
    );
  }
  return raw as RunnerSummary;
}

/**
 * Parses and validates a `RunnerListResponse`. Anything else rejects: the caller's per-worker
 * catch treats a rejection as an inconclusive probe, while a shape the sweep half-believed would
 * turn into a TypeError outside that catch and disable the sweep every tick.
 */
function parseRunnerList(body: string): RunnerSummary[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new WorkerResponseError('Worker GET /runners returned a body that is not JSON');
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new WorkerResponseError('Worker GET /runners returned a body that is not an object');
  }
  const runners = (parsed as Record<string, unknown>)['runners'];
  if (!Array.isArray(runners)) {
    throw new WorkerResponseError('Worker GET /runners returned no `runners` array');
  }
  return runners.map((entry, index) => parseRunnerSummary(entry, index));
}

/** Bounded read of a non-2xx body: the status is the signal, the text only context. */
async function readBoundedErrorBody(response: Response): Promise<string> {
  try {
    return await readBodyWithLimit(response);
  } catch (err) {
    if (err instanceof WorkerResponseError) return `<${err.message}>`;
    throw err;
  }
}

export interface WorkerClientOptions {
  baseUrl: string;
  timeoutMs?: number;
  /**
   * Timeout for `startRunner` specifically. `POST /runners` blocks on the worker until the runner
   * is *healthy* (a large model can take many minutes to load), so this must be generous — far
   * longer than the default request timeout used by quick calls like `stopRunner`. Defaults to
   * `timeoutMs` when unset.
   */
  startTimeoutMs?: number;
  /** Shared-secret bearer token for the worker agent's `SARDEENZ_WORKER_TOKEN` auth hook. */
  token?: string;
}

export class WorkerClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly startTimeoutMs: number;
  private readonly token: string;

  constructor(options: WorkerClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.startTimeoutMs = options.startTimeoutMs ?? this.timeoutMs;
    this.token = options.token ?? '';
  }

  private authHeaders(): Record<string, string> {
    return this.token ? { Authorization: `Bearer ${this.token}` } : {};
  }

  async startRunner(request: StartRunnerRequest): Promise<StartRunnerResponse> {
    return this.post<StartRunnerResponse>('/runners', request, this.startTimeoutMs);
  }

  /**
   * Open the worker's SSE log stream for a runner and return the raw Response without
   * reading the body — the caller pipes `response.body` through to its own client. This
   * intentionally does NOT apply the class's default request timeout: a log stream is
   * long-lived, so the caller supplies an external AbortSignal (e.g. tied to client
   * disconnect) instead.
   */
  async streamRunnerLogs(runnerId: string, signal?: AbortSignal): Promise<Response> {
    const response = await fetch(`${this.baseUrl}/runners/${encodeURIComponent(runnerId)}/logs`, {
      headers: { Accept: 'text/event-stream', ...this.authHeaders() },
      signal,
      redirect: 'error',
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Worker GET /runners/${runnerId}/logs returned ${response.status}: ${body}`);
    }
    return response;
  }

  /**
   * Open the worker's SSE log stream for a runner addressed by model name, returning the raw
   * Response WITHOUT throwing on a non-2xx status — the caller inspects `response.ok`/`.status`
   * so it can retry a `404` (the worker hasn't received the start command yet) while a runner is
   * cold-starting. Like {@link streamRunnerLogs}, applies no default timeout; the caller supplies
   * an AbortSignal tied to client disconnect.
   */
  async streamRunnerLogsByModel(modelName: string, signal?: AbortSignal): Promise<Response> {
    return fetch(`${this.baseUrl}/runners/by-model/${encodeURIComponent(modelName)}/logs`, {
      headers: { Accept: 'text/event-stream', ...this.authHeaders() },
      signal,
      redirect: 'error',
    });
  }

  /**
   * Same as {@link streamRunnerLogsByModel}, but addressed by the control-plane-assigned
   * `instanceId` — unambiguous when replicas of the same model run on this worker. Like
   * streamRunnerLogsByModel, does NOT throw on a non-2xx status (the caller inspects
   * `response.ok`/`.status` to retry a `404` during cold-start) and applies no default timeout.
   */
  async streamRunnerLogsByInstance(instanceId: string, signal?: AbortSignal): Promise<Response> {
    return fetch(`${this.baseUrl}/runners/by-instance/${encodeURIComponent(instanceId)}/logs`, {
      headers: { Accept: 'text/event-stream', ...this.authHeaders() },
      signal,
      redirect: 'error',
    });
  }

  /**
   * Liveness probe for one runner (worker-agent contract `getRunner`): resolves `true` when a
   * runner with this id is running on the worker, `false` when it is not (404 — never started,
   * already stopped, or exited and reaped). Any other failure (network error, 5xx, …) rejects —
   * callers must distinguish "worker answered: runner absent" (false) from "we could not ask"
   * (rejected), since only the former is evidence the runner is gone.
   */
  async getRunner(runnerId: string): Promise<boolean> {
    const response = await fetch(`${this.baseUrl}/runners/${encodeURIComponent(runnerId)}`, {
      headers: { ...this.authHeaders() },
      signal: AbortSignal.timeout(this.timeoutMs),
      redirect: 'error',
    });
    if (response.status === 404) return false;
    if (!response.ok) {
      const body = await response.text();
      throw new WorkerHttpError(
        `Worker GET /runners/${runnerId} returned ${response.status}: ${body}`,
        response.status,
      );
    }
    return true;
  }

  /**
   * Enumerate this worker's runner registry (worker-agent contract `listRunners`, #286). Used by
   * reconciliation's runner→instance sweep: the returned `instanceId`s are compared against the
   * control plane's own records. Any non-2xx rejects — a failed enumeration is inconclusive and the
   * caller must never treat it as "no runners".
   *
   * The body is untrusted worker input on a path that decides what gets killed, so it is read
   * under a size cap and validated against the contract before it is returned (#286 review):
   * over-cap, unparseable or off-shape bodies reject with `WorkerResponseError`, which the sweep's
   * per-worker catch treats as an inconclusive probe.
   */
  async listRunners(): Promise<RunnerSummary[]> {
    const response = await fetch(`${this.baseUrl}/runners`, {
      headers: { ...this.authHeaders() },
      signal: AbortSignal.timeout(this.timeoutMs),
      redirect: 'error',
    });
    if (!response.ok) {
      const body = await readBoundedErrorBody(response);
      throw new WorkerHttpError(
        `Worker GET /runners returned ${response.status}: ${body}`,
        response.status,
      );
    }
    return parseRunnerList(await readBodyWithLimit(response));
  }

  /**
   * Resolve the worker-assigned identity for a control-plane instance after a transport failure
   * made POST /runners ambiguous. A 404 is a confirmed absence only once the caller's startup
   * grace period has elapsed; this method deliberately reports facts without applying timing
   * policy.
   */
  async getRunnerByInstance(instanceId: string): Promise<RunnerByInstanceLookup> {
    const response = await fetch(
      `${this.baseUrl}/runners/by-instance/${encodeURIComponent(instanceId)}/status`,
      {
        headers: { ...this.authHeaders() },
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: 'error',
      },
    );
    if (response.status === 404) return { status: 'absent' };
    if (response.status !== 200 && response.status !== 202) {
      const body = await response.text();
      throw new WorkerHttpError(
        `Worker GET /runners/by-instance/${instanceId}/status returned ${response.status}: ${body}`,
        response.status,
      );
    }

    const body = (await response.json()) as RunnerByInstanceResponse;
    if (response.status === 202 || body.state === RunnerByInstanceResponseState.STARTING) {
      return { status: 'starting', runnerId: body.runnerId };
    }
    if (!body.host || !body.port) {
      throw new Error(`Worker returned READY runner ${body.runnerId} without an endpoint`);
    }
    return {
      status: 'ready',
      runnerId: body.runnerId,
      host: body.host,
      port: body.port,
      enginePort: body.enginePort ?? body.port,
    };
  }

  async stopRunner(runnerId: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/runners/${encodeURIComponent(runnerId)}`, {
      method: 'DELETE',
      headers: { ...this.authHeaders() },
      signal: AbortSignal.timeout(this.timeoutMs),
      redirect: 'error',
    });
    if (!response.ok) {
      const body = await response.text();
      throw new WorkerHttpError(
        `Worker DELETE /runners/${runnerId} returned ${response.status}: ${body}`,
        response.status,
      );
    }
  }

  private async post<T>(
    path: string,
    body: unknown,
    timeoutMs: number = this.timeoutMs,
  ): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    });
    if (!response.ok) {
      const text = await response.text();
      throw new WorkerHttpError(
        `Worker ${path} returned ${response.status}: ${text}`,
        response.status,
      );
    }
    return response.json() as Promise<T>;
  }
}
