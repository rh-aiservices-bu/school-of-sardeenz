import type { ChatMessage } from './types';

/**
 * Pure state transitions for one chat session, extracted out of `useChatSession` so the
 * accumulation logic can be unit-tested without a render harness (project convention — see
 * `__tests__/hooks/useModelLogs.test.ts`).
 */
export interface ChatSessionState {
  messages: ChatMessage[];
  streaming: boolean;
  error: string | null;
}

export function initialChatSessionState(): ChatSessionState {
  return { messages: [], streaming: false, error: null };
}

/** Appends the user's message and an empty assistant placeholder, and starts streaming. */
export function beginTurn(state: ChatSessionState, userText: string): ChatSessionState {
  return {
    messages: [
      ...state.messages,
      { role: 'user', content: userText },
      { role: 'assistant', content: '' },
    ],
    streaming: true,
    error: null,
  };
}

/** Appends a streamed delta to the last message. No-op if the last message isn't the assistant placeholder. */
export function appendDelta(state: ChatSessionState, delta: string): ChatSessionState {
  const last = state.messages[state.messages.length - 1];
  if (!last || last.role !== 'assistant') return state;

  const messages = [...state.messages];
  messages[messages.length - 1] = { ...last, content: last.content + delta };
  return { ...state, messages };
}

export function completeTurn(state: ChatSessionState): ChatSessionState {
  return { ...state, streaming: false };
}

/**
 * Ends the turn because the user hit Stop (or the pane unmounted mid-stream), not because the
 * server finished. Keeps whatever partial content had already streamed in via `appendDelta` and
 * clears `streaming` so the input/send UI re-enables. Idempotent when not streaming.
 */
export function abortTurn(state: ChatSessionState): ChatSessionState {
  return { ...state, streaming: false };
}

export function failTurn(state: ChatSessionState, message: string): ChatSessionState {
  return { ...state, streaming: false, error: message };
}
