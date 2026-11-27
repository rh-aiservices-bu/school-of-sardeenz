import type { Config } from '../config.js';

/**
 * Thin client for the Rust proxy's OpenAI-compatible inference endpoint.
 *
 * The proxy supports an *optional* static inference API key (#332): when the operator adds
 * `SARDEENZ_PROXY_INFERENCE_API_KEY` to the `sardeenz-service-tokens` Secret the proxy answers
 * `401` to headerless inference requests. The BFF reads the same Secret key as
 * `SARDEENZ_INFERENCE_API_KEY` and attaches it server-side, so the playground keeps working
 * while the browser never sees the key — which is also why the BFF fronts the proxy instead of
 * the browser calling it directly (the proxy has no CORS support). Empty key = proxy key
 * disabled; no header is sent.
 */

/**
 * The key this BFF presents, taken from the raw `SARDEENZ_INFERENCE_API_KEY` Secret value.
 *
 * The Secret may hold the proxy's comma-separated rotation list (`key1,key2`) — the proxy
 * accepts any segment, but a bearer token is a single value, so sending the list verbatim
 * (`Bearer key1,key2`) would match no configured key. Return the first non-empty segment,
 * trimmed; the proxy itself refuses to start on a blank configured value
 * (`proxy/src/config.rs`), so blanks here can only come from an in-flight rotation edit and
 * are skipped. No non-empty segment means the key is disabled.
 */
function firstRotationKey(rawSecretValue: string): string {
  for (const segment of rawSecretValue.split(',')) {
    const trimmed = segment.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

export class InferenceClient {
  private readonly baseUrl: string;
  /** Raw Secret value — may be a comma-separated rotation list; see `firstRotationKey`. */
  private readonly apiKeySecretValue: string;
  private readonly upstreamTimeoutMs: number;

  constructor(config: Config) {
    this.baseUrl = config.inferenceUrl;
    this.apiKeySecretValue = config.inferenceApiKey ?? '';
    this.upstreamTimeoutMs = config.upstreamTimeoutMs;
  }

  /** `Authorization` header only when the proxy key is enabled. */
  private authHeaders(): Record<string, string> {
    const key = firstRotationKey(this.apiKeySecretValue);
    return key ? { Authorization: `Bearer ${key}` } : {};
  }

  /**
   * Raw passthrough to `POST /v1/chat/completions` — the analogue of
   * `ControlPlaneClient.proxyRequest`. Returns the raw `Response` so the route can stream the
   * body straight through without buffering; forwards `signal` so a client disconnect aborts the
   * upstream generation.
   */
  async chatCompletions(body: unknown, signal: AbortSignal): Promise<Response> {
    return fetch(`${this.baseUrl}/openai/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
      body: JSON.stringify(body),
      signal,
    });
  }

  // The proxy's /healthz lives on a separate admin port from the inference port this client
  // talks to (proxy/src/main.rs), so probe the inference-port /v1/models instead. That route is
  // behind the same optional key, so it carries the header too — otherwise the probe would
  // report the proxy down whenever the key is enabled.
  async isHealthy(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/openai/v1/models`, {
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(this.upstreamTimeoutMs),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}
