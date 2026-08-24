import type { Config } from '../config.js';

/**
 * Thin client for the Rust proxy's OpenAI-compatible inference endpoint.
 *
 * Unlike `ControlPlaneClient`, this client sends no auth header — the proxy is deliberately
 * auth-free (see ADR alignment in issue #122's decision comments) and has no CORS support, which
 * is exactly why the BFF fronts it instead of the browser calling it directly.
 */
export class InferenceClient {
  private readonly baseUrl: string;

  constructor(config: Config) {
    this.baseUrl = config.inferenceUrl;
  }

  /**
   * Raw passthrough to `POST /v1/chat/completions` — the analogue of
   * `ControlPlaneClient.proxyRequest`. Returns the raw `Response` so the route can stream the
   * body straight through without buffering; forwards `signal` so a client disconnect aborts the
   * upstream generation.
   */
  async chatCompletions(body: unknown, signal: AbortSignal): Promise<Response> {
    return fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  }

  // The proxy's /healthz lives on a separate admin port from the inference port this client
  // talks to (proxy/src/main.rs), so probe the inference-port /v1/models instead.
  async isHealthy(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/v1/models`);
      return res.ok;
    } catch {
      return false;
    }
  }
}
