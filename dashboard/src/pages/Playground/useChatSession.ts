import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api/client';
import type { ChatMessage } from './types';
import {
  initialChatSessionState,
  beginTurn,
  appendDelta,
  completeTurn,
  abortTurn,
  failTurn,
} from './chatSessionState';

export interface UseChatSessionResult {
  messages: ChatMessage[];
  streaming: boolean;
  error: string | null;
  send: (userText: string, params?: { temperature?: number; max_tokens?: number }) => void;
  stop: () => void;
}

/**
 * Per-session send/stream/abort logic for one chat pane, talking to the model through
 * `POST /api/inference/chat/completions` (never `EventSource` — it can't POST a body or set
 * `Authorization`; see `api.inference.chat` / `streamChatCompletion`).
 */
export function useChatSession(model: string): UseChatSessionResult {
  const [state, setState] = useState(initialChatSessionState);
  const controllerRef = useRef<AbortController | null>(null);

  const send = useCallback(
    (userText: string, params?: { temperature?: number; max_tokens?: number }) => {
      const nextMessages: ChatMessage[] = [...state.messages, { role: 'user', content: userText }];

      setState((prev) => beginTurn(prev, userText));

      const controller = new AbortController();
      controllerRef.current = controller;

      void api.inference.chat(
        { model, messages: nextMessages, ...params },
        {
          onChunk: (delta) => setState((prev) => appendDelta(prev, delta)),
          onDone: () => {
            setState((prev) => completeTurn(prev));
            controllerRef.current = null;
          },
          onError: (err) => {
            setState((prev) => failTurn(prev, err.message));
            controllerRef.current = null;
          },
        },
        controller.signal,
      );
    },
    [state.messages, model],
  );

  const stop = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setState((prev) => abortTurn(prev));
  }, []);

  // Abort any in-flight stream when the pane unmounts (close, split/resize remount, model swap)
  // so the fetch → BFF → proxy → runner chain doesn't keep generating tokens for nobody.
  // Safe: an aborted `streamChatCompletion` calls neither onDone nor onError, so no state update
  // happens after unmount.
  useEffect(() => {
    return () => {
      controllerRef.current?.abort();
    };
  }, []);

  return { ...state, send, stop };
}
