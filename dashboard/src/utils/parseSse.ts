/**
 * Pure SSE frame parsing for the chat-completion stream, extracted out of the fetch+reader loop
 * so it can be unit-tested without React/DOM (mirrors the split done for useModelLogs — see
 * `__tests__/hooks/useModelLogs.test.ts`).
 *
 * Ported from `dashboard/reference/v1/services/api.v1.ts`
 * (`sendStreamingChatCompletionViaProxy`, lines ~747-789).
 */

export interface ChatCompletionChunk {
  choices: { delta?: { content?: string }; finish_reason?: string | null }[];
}

/**
 * Splits decoded text on newlines, retaining any trailing partial line in `rest` so callers can
 * prepend it to the next chunk of decoded text. `events` never includes the trailing partial.
 */
export function parseSseBuffer(buffer: string): { rest: string; events: string[] } {
  const lines = buffer.split('\n');
  const rest = lines.pop() ?? '';
  return { rest, events: lines };
}

/**
 * Extracts the content delta (if any) from one raw SSE line. Blank lines and `:`-prefixed
 * keepalive comments yield `{ done: false }` with no content. `data: [DONE]` yields
 * `{ done: true }`. A malformed JSON frame is ignored (not thrown).
 */
export function extractDelta(dataLine: string): { content?: string; done: boolean } {
  if (!dataLine.trim() || dataLine.startsWith(':')) {
    return { done: false };
  }

  if (!dataLine.startsWith('data: ')) {
    return { done: false };
  }

  const data = dataLine.slice(6).trim();
  if (data === '[DONE]') {
    return { done: true };
  }

  try {
    const chunk = JSON.parse(data) as ChatCompletionChunk;
    const content = chunk.choices[0]?.delta?.content;
    return content ? { content, done: false } : { done: false };
  } catch {
    return { done: false };
  }
}
