import { describe, it, expect } from 'vitest';
import {
  initialChatSessionState,
  beginTurn,
  appendDelta,
  completeTurn,
  abortTurn,
  failTurn,
  clearHistory,
  setStreaming,
  tokensPerSecond,
} from '../../../pages/Playground/chatSessionState';

const ids = { userId: 'u1', botId: 'b1' };
const at = '2026-01-01T00:00:00.000Z';

describe('chatSessionState', () => {
  it('starts empty, streaming on, idle', () => {
    expect(initialChatSessionState()).toEqual({
      messages: [],
      useStreaming: true,
      isGenerating: false,
    });
  });

  it('beginTurn appends the user message and a loading bot placeholder', () => {
    const state = beginTurn(initialChatSessionState(), 'hello', ids, at);
    expect(state.isGenerating).toBe(true);
    expect(state.messages).toEqual([
      { id: 'u1', role: 'user', content: 'hello', timestamp: at },
      { id: 'b1', role: 'bot', content: '', timestamp: at, isLoading: true },
    ]);
  });

  it('appendDelta accumulates onto the bot message and clears loading', () => {
    let state = beginTurn(initialChatSessionState(), 'hi', ids, at);
    state = appendDelta(state, 'b1', 'Hel');
    state = appendDelta(state, 'b1', 'lo');
    expect(state.messages[1]).toMatchObject({ content: 'Hello', isLoading: false });
    expect(state.isGenerating).toBe(true);
  });

  it('appendDelta is a no-op for an unknown message id', () => {
    const state = beginTurn(initialChatSessionState(), 'hi', ids, at);
    expect(appendDelta(state, 'nope', 'x')).toBe(state);
  });

  it('completeTurn attaches metrics, ends generation, and can replace content', () => {
    let state = beginTurn(initialChatSessionState(), 'hi', ids, at);
    state = appendDelta(state, 'b1', 'partial');
    state = completeTurn(
      state,
      'b1',
      { latencyMs: 120, ttftMs: 40, tokensPerSecond: 12.5 },
      'full',
    );
    expect(state.isGenerating).toBe(false);
    expect(state.messages[1]).toMatchObject({
      content: 'full',
      isLoading: false,
      metrics: { latencyMs: 120, ttftMs: 40, tokensPerSecond: 12.5 },
    });
  });

  it('completeTurn keeps accumulated content when none is supplied', () => {
    let state = beginTurn(initialChatSessionState(), 'hi', ids, at);
    state = appendDelta(state, 'b1', 'streamed');
    state = completeTurn(state, 'b1', { latencyMs: 5 });
    expect(state.messages[1].content).toBe('streamed');
  });

  it('failTurn attaches the error to the bot message and ends generation', () => {
    let state = beginTurn(initialChatSessionState(), 'hi', ids, at);
    state = failTurn(state, 'b1', { message: 'boom', statusCode: 502 }, { latencyMs: 9 });
    expect(state.isGenerating).toBe(false);
    expect(state.messages[1]).toMatchObject({
      isLoading: false,
      error: { message: 'boom', statusCode: 502 },
      metrics: { latencyMs: 9 },
    });
  });

  it('abortTurn keeps partial content, clears loading, and is idempotent when idle', () => {
    const idle = initialChatSessionState();
    expect(abortTurn(idle, null)).toBe(idle);

    let state = beginTurn(initialChatSessionState(), 'hi', ids, at);
    state = appendDelta(state, 'b1', 'part');
    state = abortTurn(state, 'b1');
    expect(state.isGenerating).toBe(false);
    expect(state.messages[1]).toMatchObject({ content: 'part', isLoading: false });
    expect(state.messages[1].error).toBeUndefined();
  });

  it('clearHistory drops messages but keeps settings', () => {
    let state = setStreaming(initialChatSessionState(), false);
    state = beginTurn(state, 'hi', ids, at);
    state = clearHistory(state);
    expect(state.messages).toEqual([]);
    expect(state.useStreaming).toBe(false);
  });

  it('setStreaming returns the same state when unchanged', () => {
    const state = initialChatSessionState();
    expect(setStreaming(state, true)).toBe(state);
    expect(setStreaming(state, false).useStreaming).toBe(false);
  });

  it('tokensPerSecond rounds to one decimal and guards zero inputs', () => {
    expect(tokensPerSecond(100, 4000)).toBe(25);
    expect(tokensPerSecond(7, 3000)).toBe(2.3);
    expect(tokensPerSecond(0, 1000)).toBeUndefined();
    expect(tokensPerSecond(10, 0)).toBeUndefined();
  });
});
