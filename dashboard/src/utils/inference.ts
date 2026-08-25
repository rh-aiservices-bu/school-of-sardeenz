import type { ControlPlaneComponents } from '@sardeenz/types';

type Protocol = 'openai' | 'oip';

/** Paste-ready OpenAI base URL: proxy base + `/openai/v1` (no double slash, no double suffix). */
export function openaiBaseUrl(inferenceUrl: string): string {
  const trimmed = inferenceUrl.replace(/\/+$/, '');
  return trimmed.endsWith('/openai/v1') ? trimmed : `${trimmed}/openai/v1`;
}

/** Paste-ready KServe V2 (OIP) base URL: proxy base + `/oip` (V2 clients append /v2/...). */
export function oipBaseUrl(inferenceUrl: string): string {
  const trimmed = inferenceUrl.replace(/\/+$/, '');
  return trimmed.endsWith('/oip') ? trimmed : `${trimmed}/oip`;
}

/** OpenAI per-model curl (chat/completions), routing name in the body `model` field. */
export function buildChatCurl(inferenceUrl: string, modelName: string): string {
  const url = `${openaiBaseUrl(inferenceUrl)}/chat/completions`;
  const payload = JSON.stringify({ model: modelName, messages: [{ role: 'user', content: 'Hello!' }] });
  return `curl ${url} \\\n  -H "Content-Type: application/json" \\\n  -d '${payload}'`;
}

/**
 * KServe V2 (OIP) per-model curl: model name is in the URL path, not the body. The request body
 * below is a minimal, protocol-valid KServe V2 shape (single FP32 input) — a template the
 * operator edits for their model; an sklearn/HF model expects its own tensor.
 */
export function buildV2InferCurl(inferenceUrl: string, modelName: string): string {
  const url = `${oipBaseUrl(inferenceUrl)}/v2/models/${encodeURIComponent(modelName)}/infer`;
  const payload = JSON.stringify({
    inputs: [{ name: 'input-0', shape: [1], datatype: 'FP32', data: [0] }],
  });
  return `curl ${url} \\\n  -H "Content-Type: application/json" \\\n  -d '${payload}'`;
}

/** Resolve a model's protocol from the catalog (runnerType→protocol); default 'openai'. */
export function runnerProtocol(
  runnerType: string,
  catalogRunners: ControlPlaneComponents['schemas']['CatalogItem'][] | undefined,
): Protocol {
  const entry = catalogRunners?.find((i) => i.entry.runnerType === runnerType)?.entry;
  // entry.protocol is the generated CatalogEntryProtocol enum, not re-exported from
  // @sardeenz/types as a value — compare against its string representation rather than pulling
  // in the enum just for this.
  return (entry?.protocol as string | undefined) === 'oip' ? 'oip' : 'openai';
}
