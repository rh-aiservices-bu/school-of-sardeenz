import { describe, it, expect } from 'vitest';
import { parseSseBuffer, extractDelta } from '../../utils/parseSse';

describe('parseSseBuffer', () => {
  it('splits complete lines and retains a trailing partial line', () => {
    const { rest, events } = parseSseBuffer('data: one\ndata: two\ndata: thr');
    expect(events).toEqual(['data: one', 'data: two']);
    expect(rest).toBe('data: thr');
  });

  it('returns no events and the whole buffer as rest when there is no newline', () => {
    const { rest, events } = parseSseBuffer('data: partial');
    expect(events).toEqual([]);
    expect(rest).toBe('data: partial');
  });

  it('returns an empty rest when the buffer ends with a newline', () => {
    const { rest, events } = parseSseBuffer('data: one\n');
    expect(events).toEqual(['data: one']);
    expect(rest).toBe('');
  });
});

describe('extractDelta', () => {
  it('parses a single complete data frame', () => {
    const line = `data: ${JSON.stringify({ choices: [{ delta: { content: 'hello' } }] })}`;
    expect(extractDelta(line)).toEqual({ content: 'hello', done: false });
  });

  it('handles multiple events in one chunk (via repeated calls)', () => {
    const line1 = `data: ${JSON.stringify({ choices: [{ delta: { content: 'a' } }] })}`;
    const line2 = `data: ${JSON.stringify({ choices: [{ delta: { content: 'b' } }] })}`;
    expect(extractDelta(line1).content).toBe('a');
    expect(extractDelta(line2).content).toBe('b');
  });

  it('buffers a frame split across chunk boundaries', () => {
    // Simulate feeding two decoded chunks where the frame is split mid-JSON.
    let buffer = '';
    buffer += 'data: {"cho';
    let result = parseSseBuffer(buffer);
    expect(result.events).toEqual([]); // no full line yet
    buffer = result.rest;

    buffer += 'ices":[{"delta":{"content":"x"}}]}\n';
    result = parseSseBuffer(buffer);
    expect(result.events).toHaveLength(1);
    expect(extractDelta(result.events[0])).toEqual({ content: 'x', done: false });
  });

  it('terminates on data: [DONE]', () => {
    expect(extractDelta('data: [DONE]')).toEqual({ done: true });
  });

  it('ignores blank and colon-comment lines', () => {
    expect(extractDelta('')).toEqual({ done: false });
    expect(extractDelta('   ')).toEqual({ done: false });
    expect(extractDelta(': ping')).toEqual({ done: false });
  });

  it('ignores a malformed JSON frame without throwing', () => {
    expect(() => extractDelta('data: {not valid json')).not.toThrow();
    expect(extractDelta('data: {not valid json')).toEqual({ done: false });
  });

  it('ignores a frame with no delta content', () => {
    const line = `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}`;
    expect(extractDelta(line)).toEqual({ done: false });
  });
});
