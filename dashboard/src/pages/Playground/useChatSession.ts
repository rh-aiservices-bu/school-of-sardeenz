import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, type ModelInfo } from '../../api/client';
import type { ChatMessage, PlaygroundMessage, PlaygroundMessageError } from './types';
import {
  abortTurn,
  appendDelta,
  beginTurn,
  clearHistory as clearHistoryState,
  completeTurn,
  failTurn,
  initialChatSessionState,
  setStreaming,
  tokensPerSecond,
} from './chatSessionState';
import { newSessionId } from './workspaceState';

/** v1 parity: fixed sampling parameters for playground turns. */
const MAX_TOKENS = 512;
const TEMPERATURE = 0.7;

export interface UseChatSessionResult {
  messages: PlaygroundMessage[];
  isGenerating: boolean;
  useStreaming: boolean;
  sendMessage: (content: string) => void;
  stopGeneration: () => void;
  setUseStreaming: (useStreaming: boolean) => void;
  clearHistory: () => void;
}

function toError(err: unknown): PlaygroundMessageError {
  if (err instanceof ApiError) return { message: err.message, statusCode: err.status };
  if (err instanceof Error) return { message: err.message };
  return { message: String(err) };
}

function historyFor(messages: PlaygroundMessage[]): ChatMessage[] {
  return messages
    .filter((m) => !m.error && (m.role === 'user' || m.content))
    .map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content }));
}

/**
 * Per-pane send/stream/abort logic, talking to the model through
 * `POST /api/inference/chat/completions` (never `EventSource` — it can't POST a body or set
 * `Authorization`; see `api.inference.chat` / `streamChatCompletion`). Records latency, time to
 * first token, and tokens/s per reply (v1 parity).
 */
export function useChatSession(model: ModelInfo): UseChatSessionResult {
  const [state, setState] = useState(initialChatSessionState);
  const stateRef = useRef(state);
  stateRef.current = state;

  const controllerRef = useRef<AbortController | null>(null);
  const currentBotIdRef = useRef<string | null>(null);

  // Streamed text not yet committed to state, and the animation frame that will commit it.
  const pendingRef = useRef('');
  const rafRef = useRef<number | null>(null);

  const flushPending = useCallback((botId: string) => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    const pending = pendingRef.current;
    if (!pending) return;
    pendingRef.current = '';
    setState((prev) => appendDelta(prev, botId, pending));
  }, []);

  const sendMessage = useCallback(
    (rawContent: string) => {
      const content = rawContent.trim();
      const current = stateRef.current;
      if (!content || current.isGenerating) return;

      const ids = { userId: newSessionId(), botId: newSessionId() };
      const botId = ids.botId;
      currentBotIdRef.current = botId;

      const priorHistory = historyFor(current.messages);
      setState((prev) => beginTurn(prev, content, ids));

      const controller = new AbortController();
      controllerRef.current = controller;

      const body = {
        model: model.modelName,
        messages: [...priorHistory, { role: 'user' as const, content }],
        max_tokens: MAX_TOKENS,
        temperature: TEMPERATURE,
      };

      const startTime = performance.now();
      let firstTokenTime: number | undefined;
      let chunkCount = 0;

      const finish = () => {
        controllerRef.current = null;
        currentBotIdRef.current = null;
      };

      const onError = (err: unknown) => {
        const latencyMs = Math.round(performance.now() - startTime);
        setState((prev) => failTurn(prev, botId, toError(err), { latencyMs }));
        finish();
      };

      if (current.useStreaming) {
        void api.inference.chat(
          body,
          {
            onChunk: (delta) => {
              firstTokenTime ??= performance.now();
              chunkCount += 1;
              // Coalesce deltas and commit once per animation frame. A synchronous render per
              // chunk (v1's flushSync) saturates the main thread at high token rates, so the
              // browser never paints until the stream ends and the reply appears in one block.
              pendingRef.current += delta;
              rafRef.current ??= requestAnimationFrame(() => {
                rafRef.current = null;
                flushPending(botId);
              });
            },
            onDone: (fullText, usage) => {
              flushPending(botId);
              const endTime = performance.now();
              const latencyMs = Math.round(endTime - startTime);
              const ttftMs = firstTokenTime ? Math.round(firstTokenTime - startTime) : undefined;
              const generationMs = endTime - (firstTokenTime ?? startTime);
              const tokenCount = usage?.completion_tokens ?? chunkCount;
              setState((prev) =>
                completeTurn(
                  prev,
                  botId,
                  {
                    latencyMs,
                    ttftMs,
                    tokensPerSecond: tokensPerSecond(tokenCount, generationMs),
                    promptTokens: usage?.prompt_tokens,
                    completionTokens: usage?.completion_tokens,
                  },
                  fullText,
                ),
              );
              finish();
            },
            onError,
          },
          controller.signal,
        );
        return;
      }

      api.inference
        .chatOnce(body, controller.signal)
        .then((response) => {
          const latencyMs = Math.round(performance.now() - startTime);
          const text = response.choices?.[0]?.message?.content ?? '';
          setState((prev) =>
            completeTurn(
              prev,
              botId,
              {
                latencyMs,
                promptTokens: response.usage?.prompt_tokens,
                completionTokens: response.usage?.completion_tokens,
              },
              text,
            ),
          );
          finish();
        })
        .catch((err: unknown) => {
          if ((err as { name?: unknown } | null)?.name === 'AbortError') return;
          onError(err);
        });
    },
    [model.modelName, flushPending],
  );

  const stopGeneration = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    const botId = currentBotIdRef.current;
    currentBotIdRef.current = null;
    if (botId) flushPending(botId);
    setState((prev) => abortTurn(prev, botId));
  }, [flushPending]);

  const setUseStreaming = useCallback((useStreaming: boolean) => {
    setState((prev) => setStreaming(prev, useStreaming));
  }, []);

  const clearHistory = useCallback(() => setState((prev) => clearHistoryState(prev)), []);

  // Abort any in-flight stream when the pane unmounts (close, layout change, model swap) so the
  // fetch → BFF → proxy → runner chain doesn't keep generating tokens for nobody. Safe: an
  // aborted `streamChatCompletion` calls neither onDone nor onError.
  useEffect(() => {
    return () => {
      controllerRef.current?.abort();
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  return {
    messages: state.messages,
    isGenerating: state.isGenerating,
    useStreaming: state.useStreaming,
    sendMessage,
    stopGeneration,
    setUseStreaming,
    clearHistory,
  };
}
