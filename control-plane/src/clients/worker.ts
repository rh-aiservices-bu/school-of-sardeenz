import { RunnerByInstanceResponseState, type WorkerAgentComponents } from '@sardeenz/types';

export type StartRunnerRequest = WorkerAgentComponents['schemas']['StartRunnerRequest'];
export type StartRunnerResponse = WorkerAgentComponents['schemas']['StartRunnerResponse'];
export type RunnerByInstanceResponse = WorkerAgentComponents['schemas']['RunnerByInstanceResponse'];

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
