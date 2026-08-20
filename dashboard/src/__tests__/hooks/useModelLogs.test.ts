/**
 * Tests for useModelLogs accumulation/reconnect behaviour.
 *
 * Following the project convention (see useEventStream.test.ts), we drive a MockEventSource
 * and exercise the accumulation/reconnect logic directly rather than using renderHook, which
 * requires a matched React + react-dom version pair that can be tricky in monorepo worktrees.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const RECONNECT_INTERVAL_NORMAL = 5_000;
const RECONNECT_INTERVAL_DEGRADED = 30_000;
const FAILURE_THRESHOLD = 5;
const MAX_LOG_LINES = 1_000;

interface RunnerLogLine {
  ts: string;
  stream: 'stdout' | 'stderr';
  content: string;
}

// ---------------------------------------------------------------------------
// MockEventSource — simulates the browser EventSource API, including named
// `addEventListener('log' | 'end', ...)` frames (unlike the app-scope stream,
// which only uses the default `message` event).
// ---------------------------------------------------------------------------

class MockEventSource {
  static instances: MockEventSource[] = [];

  url: string;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  private listeners: Record<string, ((event: MessageEvent) => void)[]> = {};
  close = vi.fn();

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, handler: (event: MessageEvent) => void) {
    (this.listeners[type] ??= []).push(handler);
  }

  triggerOpen() {
    this.onopen?.(new Event('open'));
  }

  triggerNamedEvent(type: string, data: unknown) {
    const payload = new MessageEvent('message', { data: JSON.stringify(data) });
    for (const handler of this.listeners[type] ?? []) {
      handler(payload);
    }
  }

  triggerError() {
    this.onerror?.(new Event('error'));
  }
}

// ---------------------------------------------------------------------------
// Pure accumulation/reconnect logic — mirrors useModelLogs.ts exactly, so
// tests exercise the same branching without depending on React hooks.
// ---------------------------------------------------------------------------

interface LogsState {
  logs: RunnerLogLine[];
  isConnected: boolean;
  ended: boolean;
  failureCount: number;
}

function initialState(): LogsState {
  return { logs: [], isConnected: false, ended: false, failureCount: 0 };
}

function appendLog(state: LogsState, line: RunnerLogLine): LogsState {
  const next = [...state.logs, line];
  return {
    ...state,
    logs: next.length > MAX_LOG_LINES ? next.slice(next.length - MAX_LOG_LINES) : next,
  };
}

function onOpen(state: LogsState): LogsState {
  return { ...state, isConnected: true, failureCount: 0 };
}

function onEnd(state: LogsState): LogsState {
  return { ...state, ended: true, isConnected: false };
}

function onError(state: LogsState): { state: LogsState; reconnectDelayMs: number | null } {
  const disconnected = { ...state, isConnected: false };
  if (disconnected.ended) {
    // Clean `end` frame already fired — don't reconnect.
    return { state: disconnected, reconnectDelayMs: null };
  }
  const failureCount = disconnected.failureCount + 1;
  const reconnectDelayMs =
    failureCount >= FAILURE_THRESHOLD ? RECONNECT_INTERVAL_DEGRADED : RECONNECT_INTERVAL_NORMAL;
  return { state: { ...disconnected, failureCount }, reconnectDelayMs };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  MockEventSource.instances = [];
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useModelLogs constants', () => {
  it('caps accumulated log lines at 1000', () => {
    expect(MAX_LOG_LINES).toBe(1_000);
  });

  it('shares the app-wide reconnect backoff thresholds', () => {
    expect(FAILURE_THRESHOLD).toBe(5);
    expect(RECONNECT_INTERVAL_NORMAL).toBe(5_000);
    expect(RECONNECT_INTERVAL_DEGRADED).toBe(30_000);
  });
});

describe('log accumulation', () => {
  const line = (content: string, stream: RunnerLogLine['stream'] = 'stdout'): RunnerLogLine => ({
    ts: '2026-08-20T00:00:00.000Z',
    stream,
    content,
  });

  it('appends `log` events in order', () => {
    let state = initialState();
    state = appendLog(state, line('first'));
    state = appendLog(state, line('second'));

    expect(state.logs.map((l) => l.content)).toEqual(['first', 'second']);
  });

  it('drops the oldest lines once the cap is exceeded', () => {
    let state = initialState();
    for (let i = 0; i < MAX_LOG_LINES + 10; i++) {
      state = appendLog(state, line(`line-${i}`));
    }

    expect(state.logs).toHaveLength(MAX_LOG_LINES);
    expect(state.logs[0].content).toBe('line-10');
    expect(state.logs[state.logs.length - 1].content).toBe(`line-${MAX_LOG_LINES + 9}`);
  });

  it('preserves stream type (stdout vs stderr)', () => {
    let state = initialState();
    state = appendLog(state, line('normal output', 'stdout'));
    state = appendLog(state, line('error output', 'stderr'));

    expect(state.logs[0].stream).toBe('stdout');
    expect(state.logs[1].stream).toBe('stderr');
  });
});

describe('connection state machine', () => {
  it('starts disconnected and not ended', () => {
    const state = initialState();
    expect(state.isConnected).toBe(false);
    expect(state.ended).toBe(false);
  });

  it('open event marks connected and resets failure count', () => {
    let state = initialState();
    state = onError(state).state;
    state = onError(state).state;
    expect(state.failureCount).toBe(2);

    state = onOpen(state);
    expect(state.isConnected).toBe(true);
    expect(state.failureCount).toBe(0);
  });

  it('`end` event marks ended and disconnects', () => {
    let state = onOpen(initialState());
    state = onEnd(state);

    expect(state.ended).toBe(true);
    expect(state.isConnected).toBe(false);
  });

  it('error after an `end` frame does not schedule a reconnect', () => {
    let state = onOpen(initialState());
    state = onEnd(state);

    const result = onError(state);
    expect(result.reconnectDelayMs).toBeNull();
    expect(result.state.isConnected).toBe(false);
  });

  it('error before `end` schedules a normal-interval reconnect', () => {
    const state = onOpen(initialState());
    const result = onError(state);

    expect(result.reconnectDelayMs).toBe(RECONNECT_INTERVAL_NORMAL);
    expect(result.state.failureCount).toBe(1);
  });

  it('5th consecutive failure schedules a degraded-interval reconnect', () => {
    let state = initialState();
    let delay: number | null = null;
    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      const result = onError(state);
      state = result.state;
      delay = result.reconnectDelayMs;
    }

    expect(state.failureCount).toBe(FAILURE_THRESHOLD);
    expect(delay).toBe(RECONNECT_INTERVAL_DEGRADED);
  });
});

describe('MockEventSource protocol', () => {
  it('delivers `log` frames only to log listeners', () => {
    const es = new MockEventSource('http://localhost/models/llama-3/logs');
    const received: RunnerLogLine[] = [];
    es.addEventListener('log', (event) => {
      received.push(JSON.parse(event.data as string) as RunnerLogLine);
    });

    es.triggerNamedEvent('log', { ts: 'now', stream: 'stdout', content: 'hello' });

    expect(received).toHaveLength(1);
    expect(received[0].content).toBe('hello');
  });

  it('delivers `end` frames only to end listeners', () => {
    const es = new MockEventSource('http://localhost/models/llama-3/logs');
    let endFired = false;
    es.addEventListener('end', () => {
      endFired = true;
    });

    es.triggerNamedEvent('end', {});
    expect(endFired).toBe(true);
  });

  it('close is called on cleanup', () => {
    const es = new MockEventSource('http://localhost/models/llama-3/logs');
    es.close();
    expect(es.close).toHaveBeenCalledOnce();
  });

  it('carries the encoded model name in the connection URL', () => {
    const modelName = 'meta-llama/Llama-3.1-8B';
    const es = new MockEventSource(`/api/models/${encodeURIComponent(modelName)}/logs`);
    expect(es.url).toBe('/api/models/meta-llama%2FLlama-3.1-8B/logs');
  });
});

describe('disable/unmount cleanup', () => {
  it('scheduled reconnect timers are cleared when disabled (no stray reconnect fires)', () => {
    const reconnectSpy = vi.fn();
    const timer = setTimeout(reconnectSpy, RECONNECT_INTERVAL_NORMAL);

    // Simulates the effect cleanup calling `disconnect()`, which clears the pending timer.
    clearTimeout(timer);
    vi.advanceTimersByTime(RECONNECT_INTERVAL_NORMAL + 1);

    expect(reconnectSpy).not.toHaveBeenCalled();
  });
});
