import type { WorkerAgentComponents } from '@sardeenz/types';

export type StartRunnerRequest = WorkerAgentComponents['schemas']['StartRunnerRequest'];
export type StartRunnerResponse = WorkerAgentComponents['schemas']['StartRunnerResponse'];

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
      throw new Error(`Worker ${path} returned ${response.status}: ${text}`);
    }
    return response.json() as Promise<T>;
  }
}
