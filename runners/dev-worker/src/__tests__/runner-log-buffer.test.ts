import { describe, it, expect, beforeEach } from 'vitest';
import { RunnerLogBuffer, type RunnerLogLine } from '../runner-log-buffer.js';

describe('RunnerLogBuffer', () => {
  let buffer: RunnerLogBuffer;

  beforeEach(() => {
    buffer = new RunnerLogBuffer();
  });

  it('splits multiline content into separate buffered lines', () => {
    buffer.append('runner-1', 'stdout', 'line one\nline two\nline three\n');

    const lines = buffer.getBuffer('runner-1');
    expect(lines.map((l) => l.content)).toEqual(['line one', 'line two', 'line three']);
    // `stream` is the codegen enum type; compare as a plain string (same convention as
    // runner-log-buffer.ts, which keeps consumers decoupled from the openapi-typescript enum).
    expect(lines.every((l) => (l.stream as string) === 'stdout')).toBe(true);
    expect(lines.every((l) => typeof l.ts === 'string' && l.ts.length > 0)).toBe(true);
  });

  it('does not emit a trailing empty line from a trailing newline', () => {
    buffer.append('runner-1', 'stdout', 'only line\n');
    expect(buffer.getBuffer('runner-1')).toHaveLength(1);
  });

  it('drops a lone empty chunk without buffering an entry', () => {
    buffer.append('runner-1', 'stdout', '');
    expect(buffer.getBuffer('runner-1')).toHaveLength(0);
  });

  it('filters out control-endpoint poll access-log noise', () => {
    buffer.append(
      'runner-1',
      'stdout',
      [
        'INFO 09-01 vLLM loading weights...',
        'INFO:     127.0.0.1:39764 - "GET /health HTTP/1.1" 200 OK',
        'INFO:     127.0.0.1:39764 - "GET /progress HTTP/1.1" 200 OK',
        'INFO:     127.0.0.1:39764 - "POST /inference HTTP/1.1" 200 OK',
        'INFO 09-01 Application startup complete.',
      ].join('\n'),
    );

    const contents = buffer.getBuffer('runner-1').map((l) => l.content);
    // Health/progress poll spam dropped; real engine lines and non-poll requests kept.
    expect(contents).toEqual([
      'INFO 09-01 vLLM loading weights...',
      'INFO:     127.0.0.1:39764 - "POST /inference HTTP/1.1" 200 OK',
      'INFO 09-01 Application startup complete.',
    ]);
  });

  it('accumulates across multiple append calls', () => {
    buffer.append('runner-1', 'stdout', 'first\n');
    buffer.append('runner-1', 'stderr', 'second\n');
    const lines = buffer.getBuffer('runner-1');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ content: 'first', stream: 'stdout' });
    expect(lines[1]).toMatchObject({ content: 'second', stream: 'stderr' });
  });

  it('trims the buffer to the configured cap, keeping the newest lines', () => {
    const capped = new RunnerLogBuffer(5);
    for (let i = 0; i < 10; i++) {
      capped.append('runner-1', 'stdout', `line-${i}\n`);
    }
    const lines = capped.getBuffer('runner-1');
    expect(lines).toHaveLength(5);
    expect(lines.map((l) => l.content)).toEqual(['line-5', 'line-6', 'line-7', 'line-8', 'line-9']);
  });

  it('getBuffer returns a copy that callers cannot mutate into the internal state', () => {
    buffer.append('runner-1', 'stdout', 'line\n');
    const copy = buffer.getBuffer('runner-1');
    copy.push({ ts: 'fake', stream: 'stdout', content: 'injected' } as RunnerLogLine);
    expect(buffer.getBuffer('runner-1')).toHaveLength(1);
  });

  it('getBuffer returns an empty array for an unknown runner', () => {
    expect(buffer.getBuffer('nonexistent')).toEqual([]);
  });

  it('delivers live lines to onLog subscribers as they are appended', () => {
    const received: string[] = [];
    buffer.onLog('runner-1', (line) => received.push(line.content));

    buffer.append('runner-1', 'stdout', 'a\nb\n');

    expect(received).toEqual(['a', 'b']);
  });

  it('does not replay past lines to a new subscriber', () => {
    buffer.append('runner-1', 'stdout', 'before\n');

    const received: string[] = [];
    buffer.onLog('runner-1', (line) => received.push(line.content));
    buffer.append('runner-1', 'stdout', 'after\n');

    expect(received).toEqual(['after']);
  });

  it('unsubscribe stops further delivery without affecting other subscribers', () => {
    const a: string[] = [];
    const b: string[] = [];
    const unsubA = buffer.onLog('runner-1', (line) => a.push(line.content));
    buffer.onLog('runner-1', (line) => b.push(line.content));

    buffer.append('runner-1', 'stdout', 'first\n');
    unsubA();
    buffer.append('runner-1', 'stdout', 'second\n');

    expect(a).toEqual(['first']);
    expect(b).toEqual(['first', 'second']);
  });

  it('markEnded notifies onEnd subscribers', () => {
    let ended = false;
    buffer.onEnd('runner-1', () => {
      ended = true;
    });
    buffer.markEnded('runner-1');
    expect(ended).toBe(true);
  });

  it('markEnded is a no-op when there are no subscribers', () => {
    expect(() => buffer.markEnded('nonexistent')).not.toThrow();
  });

  it('onEnd unsubscribe stops delivery', () => {
    let calls = 0;
    const unsub = buffer.onEnd('runner-1', () => {
      calls++;
    });
    unsub();
    buffer.markEnded('runner-1');
    expect(calls).toBe(0);
  });

  it('drop clears the buffer and stops delivering to subscribers', () => {
    buffer.append('runner-1', 'stdout', 'line\n');
    const received: string[] = [];
    buffer.onLog('runner-1', (line) => received.push(line.content));

    buffer.drop('runner-1');

    expect(buffer.getBuffer('runner-1')).toEqual([]);
    expect(buffer.has('runner-1')).toBe(false);

    buffer.append('runner-1', 'stdout', 'new-buffer-after-drop\n');
    expect(received).toEqual([]);
  });

  it('has reflects whether any lines have been buffered for a runner', () => {
    expect(buffer.has('runner-1')).toBe(false);
    buffer.append('runner-1', 'stdout', 'line\n');
    expect(buffer.has('runner-1')).toBe(true);
  });

  it('keeps separate buffers per runnerId', () => {
    buffer.append('runner-1', 'stdout', 'one\n');
    buffer.append('runner-2', 'stdout', 'two\n');

    expect(buffer.getBuffer('runner-1').map((l) => l.content)).toEqual(['one']);
    expect(buffer.getBuffer('runner-2').map((l) => l.content)).toEqual(['two']);
  });
});
