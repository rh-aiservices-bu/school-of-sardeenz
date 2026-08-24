/** Paste-ready OpenAI base URL: proxy base + `/v1` (no double slash, no double `/v1`). */
export function openaiBaseUrl(inferenceUrl: string): string {
  const trimmed = inferenceUrl.replace(/\/+$/, '');
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
}

/** Per-model curl snippet using the routing name (= modelName). */
export function buildChatCurl(inferenceUrl: string, modelName: string): string {
  const url = `${openaiBaseUrl(inferenceUrl)}/chat/completions`;
  const payload = JSON.stringify({
    model: modelName,
    messages: [{ role: 'user', content: 'Hello!' }],
  });
  return `curl ${url} \\\n  -H "Content-Type: application/json" \\\n  -d '${payload}'`;
}
