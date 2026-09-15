import type { PlaygroundMessage, PlaygroundMessageError, PlaygroundMessageMetrics } from './types';

/**
 * Pure state transitions for one chat session, extracted out of `useChatSession` so the
 * accumulation logic can be unit-tested without a render harness (project convention — see
 * `__tests__/hooks/useModelLogs.test.ts`).
 */
export interface ChatSessionState {
  messages: PlaygroundMessage[];
  useStreaming: boolean;
  isGenerating: boolean;
}

export function initialChatSessionState(): ChatSessionState {
  return { messages: [], useStreaming: true, isGenerating: false };
}

export interface TurnIds {
  userId: string;
  botId: string;
}

/** Appends the user's message and a loading bot placeholder, and marks the session generating. */
export function beginTurn(
  state: ChatSessionState,
  userText: string,
  ids: TurnIds,
  timestamp: string = new Date().toISOString(),
): ChatSessionState {
  return {
    ...state,
    messages: [
      ...state.messages,
      { id: ids.userId, role: 'user', content: userText, timestamp },
      { id: ids.botId, role: 'bot', content: '', timestamp, isLoading: true },
    ],
    isGenerating: true,
  };
}

function patchMessage(
  state: ChatSessionState,
  id: string,
  patch: (message: PlaygroundMessage) => PlaygroundMessage,
): ChatSessionState {
  let touched = false;
  const messages = state.messages.map((message) => {
    if (message.id !== id) return message;
    touched = true;
    return patch(message);
  });
  return touched ? { ...state, messages } : state;
}

/** Appends a streamed delta to the bot message `botId` and clears its loading indicator. */
export function appendDelta(
  state: ChatSessionState,
  botId: string,
  delta: string,
): ChatSessionState {
  return patchMessage(state, botId, (m) => ({
    ...m,
    content: m.content + delta,
    isLoading: false,
  }));
}

/** Ends the turn successfully; `content` replaces the accumulated text when provided. */
export function completeTurn(
  state: ChatSessionState,
  botId: string,
  metrics: PlaygroundMessageMetrics,
  content?: string,
): ChatSessionState {
  const next = patchMessage(state, botId, (m) => ({
    ...m,
    content: content ?? m.content,
    isLoading: false,
    metrics,
  }));
  return { ...next, isGenerating: false };
}

/** Ends the turn with an error attached to the bot message. */
export function failTurn(
  state: ChatSessionState,
  botId: string,
  error: PlaygroundMessageError,
  metrics?: PlaygroundMessageMetrics,
): ChatSessionState {
  const next = patchMessage(state, botId, (m) => ({ ...m, isLoading: false, error, metrics }));
  return { ...next, isGenerating: false };
}

/**
 * Ends the turn because the user hit Stop (or the pane unmounted mid-stream). Keeps whatever
 * partial content had already streamed in. Idempotent when not generating.
 */
export function abortTurn(state: ChatSessionState, botId: string | null): ChatSessionState {
  const next = botId ? patchMessage(state, botId, (m) => ({ ...m, isLoading: false })) : state;
  return next.isGenerating ? { ...next, isGenerating: false } : next;
}

export function clearHistory(state: ChatSessionState): ChatSessionState {
  return state.messages.length === 0 ? state : { ...state, messages: [] };
}

export function setStreaming(state: ChatSessionState, useStreaming: boolean): ChatSessionState {
  return state.useStreaming === useStreaming ? state : { ...state, useStreaming };
}

/** Rounded tokens/second over the generation window; undefined when it cannot be computed. */
export function tokensPerSecond(tokenCount: number, generationMs: number): number | undefined {
  if (tokenCount <= 0 || generationMs <= 0) return undefined;
  return Math.round((tokenCount / (generationMs / 1000)) * 10) / 10;
}
