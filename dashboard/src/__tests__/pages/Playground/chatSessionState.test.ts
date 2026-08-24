import { describe, it, expect } from 'vitest';
import {
  initialChatSessionState,
  beginTurn,
  appendDelta,
  completeTurn,
  abortTurn,
  failTurn,
} from '../../../pages/Playground/chatSessionState';

describe('chatSessionState', () => {
  it('starts with no messages, not streaming, no error', () => {
    expect(initialChatSessionState()).toEqual({ messages: [], streaming: false, error: null });
  });

  it('appends the user message and an empty assistant placeholder, marks streaming', () => {
    const state = beginTurn(initialChatSessionState(), 'hello');
    expect(state.messages).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: '' },
    ]);
    expect(state.streaming).toBe(true);
    expect(state.error).toBeNull();
  });

  it('accumulates streamed deltas onto the assistant placeholder', () => {
    let state = beginTurn(initialChatSessionState(), 'hi');
    state = appendDelta(state, 'Hel');
    state = appendDelta(state, 'lo!');

    expect(state.messages).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'Hello!' },
    ]);
  });

  it('appendDelta is a no-op when the last message is not the assistant placeholder', () => {
    const state = initialChatSessionState();
    expect(appendDelta(state, 'stray chunk')).toBe(state);
  });

  it('completeTurn clears streaming without touching messages', () => {
    let state = beginTurn(initialChatSessionState(), 'hi');
    state = appendDelta(state, 'ok');
    state = completeTurn(state);

    expect(state.streaming).toBe(false);
    expect(state.messages[1]?.content).toBe('ok');
  });

  it('a full turn: begin -> two chunks -> complete produces the expected transcript', () => {
    let state = initialChatSessionState();
    state = beginTurn(state, 'What is 2+2?');
    state = appendDelta(state, '4');
    state = appendDelta(state, '.');
    state = completeTurn(state);

    expect(state).toEqual({
      messages: [
        { role: 'user', content: 'What is 2+2?' },
        { role: 'assistant', content: '4.' },
      ],
      streaming: false,
      error: null,
    });
  });

  it('failTurn sets the error and clears streaming', () => {
    let state = beginTurn(initialChatSessionState(), 'hi');
    state = failTurn(state, 'Inference proxy unreachable');

    expect(state.streaming).toBe(false);
    expect(state.error).toBe('Inference proxy unreachable');
  });

  it('abortTurn clears streaming and preserves whatever partial content had streamed in', () => {
    let state = beginTurn(initialChatSessionState(), 'hi');
    state = appendDelta(state, 'partial resp');
    state = abortTurn(state);

    expect(state.streaming).toBe(false);
    expect(state.messages[1]?.content).toBe('partial resp');
    expect(state.error).toBeNull();
  });

  it('abortTurn is idempotent when not streaming', () => {
    const state = initialChatSessionState();
    expect(abortTurn(state)).toEqual({ messages: [], streaming: false, error: null });

    let completed = beginTurn(initialChatSessionState(), 'hi');
    completed = completeTurn(completed);
    expect(abortTurn(completed)).toEqual(completed);
  });
});

describe('stop() aborts the in-flight controller', () => {
  it('aborts the current controller when one is set', () => {
    const controllerRef: { current: AbortController | null } = { current: new AbortController() };
    const stop = () => controllerRef.current?.abort();

    stop();

    expect(controllerRef.current?.signal.aborted).toBe(true);
  });

  it('is a no-op when there is no in-flight controller', () => {
    const controllerRef: { current: AbortController | null } = { current: null };
    const stop = () => controllerRef.current?.abort();

    expect(() => stop()).not.toThrow();
  });
});
