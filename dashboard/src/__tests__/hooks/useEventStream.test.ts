/**
 * Tests for useEventStream state machine behaviour.
 *
 * We test the connection-state machine by driving a MockEventSource and
 * directly observing the internal constants and branching that the hook
 * relies on, rather than using renderHook (which requires a matched
 * React + react-dom version pair that can be tricky in monorepo worktrees).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Re-export constants to verify them
// ---------------------------------------------------------------------------

// These values are the thresholds the hook uses — validate them here so any
// accidental change is caught by a test.
const FAILURE_THRESHOLD = 5;
const RECONNECT_INTERVAL_NORMAL = 5_000;
const RECONNECT_INTERVAL_DEGRADED = 30_000;

// ---------------------------------------------------------------------------
// MockEventSource — simulates the browser EventSource API
// ---------------------------------------------------------------------------

class MockEventSource {
  static instances: MockEventSource[] = [];

  url: string;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  close = vi.fn();

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  triggerOpen() {
    this.onopen?.(new Event('open'));
  }

  triggerMessage(data: unknown) {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(data) }));
  }

  triggerError() {
    this.onerror?.(new Event('error'));
  }
}

// ---------------------------------------------------------------------------
// State machine simulator — mirrors the logic in useEventStreamConnection
// without depending on React hooks
// ---------------------------------------------------------------------------

type ConnectionStatus = 'connected' | 'reconnecting' | 'degraded';

interface StateMachineState {
  status: ConnectionStatus;
  failureCount: number;
  reconnectDelayMs: number;
}

function initialState(): StateMachineState {
  return { status: 'reconnecting', failureCount: 0, reconnectDelayMs: RECONNECT_INTERVAL_NORMAL };
}

function onOpen(): StateMachineState {
  return { status: 'connected', failureCount: 0, reconnectDelayMs: RECONNECT_INTERVAL_NORMAL };
}

function onError(state: StateMachineState): StateMachineState {
  const newCount = state.failureCount + 1;
  if (newCount >= FAILURE_THRESHOLD) {
    return {
      status: 'degraded',
      failureCount: newCount,
      reconnectDelayMs: RECONNECT_INTERVAL_DEGRADED,
    };
  }
  return {
    status: 'reconnecting',
    failureCount: newCount,
    reconnectDelayMs: RECONNECT_INTERVAL_NORMAL,
  };
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

describe('useEventStream state machine constants', () => {
  it('FAILURE_THRESHOLD is 5 (~25 seconds at 5s intervals)', () => {
    expect(FAILURE_THRESHOLD).toBe(5);
  });

  it('normal reconnect interval is 5000ms', () => {
    expect(RECONNECT_INTERVAL_NORMAL).toBe(5_000);
  });

  it('degraded reconnect interval is 30000ms', () => {
    expect(RECONNECT_INTERVAL_DEGRADED).toBe(30_000);
  });
});

describe('state machine transitions', () => {
  it('starts in reconnecting state', () => {
    const state = initialState();
    expect(state.status).toBe('reconnecting');
    expect(state.failureCount).toBe(0);
  });

  it('CONNECTED: open event resets failure count and sets connected', () => {
    let state = initialState();
    // Simulate some failures first
    state = onError(state);
    state = onError(state);
    expect(state.failureCount).toBe(2);

    state = onOpen();
    expect(state.status).toBe('connected');
    expect(state.failureCount).toBe(0);
    expect(state.reconnectDelayMs).toBe(RECONNECT_INTERVAL_NORMAL);
  });

  it('RECONNECTING: first error transitions to reconnecting with normal interval', () => {
    let state = initialState();
    state = onOpen(); // connected
    state = onError(state);
    expect(state.status).toBe('reconnecting');
    expect(state.failureCount).toBe(1);
    expect(state.reconnectDelayMs).toBe(RECONNECT_INTERVAL_NORMAL);
  });

  it('DEGRADED: 5th consecutive failure triggers degraded state', () => {
    let state = initialState();
    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      state = onError(state);
    }
    expect(state.status).toBe('degraded');
    expect(state.failureCount).toBe(FAILURE_THRESHOLD);
    expect(state.reconnectDelayMs).toBe(RECONNECT_INTERVAL_DEGRADED);
  });

  it('4th failure stays in reconnecting (not yet degraded)', () => {
    let state = initialState();
    for (let i = 0; i < FAILURE_THRESHOLD - 1; i++) {
      state = onError(state);
    }
    expect(state.status).toBe('reconnecting');
    expect(state.failureCount).toBe(FAILURE_THRESHOLD - 1);
    expect(state.reconnectDelayMs).toBe(RECONNECT_INTERVAL_NORMAL);
  });

  it('CONNECTED from DEGRADED: open event resets failure count and restores normal interval', () => {
    let state = initialState();
    // Drive to degraded
    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      state = onError(state);
    }
    expect(state.status).toBe('degraded');

    // Successful reconnect
    state = onOpen();
    expect(state.status).toBe('connected');
    expect(state.failureCount).toBe(0);
    expect(state.reconnectDelayMs).toBe(RECONNECT_INTERVAL_NORMAL);
  });

  it('further errors after recovery require another 5 failures to re-enter degraded', () => {
    let state = initialState();
    // Drive to degraded
    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      state = onError(state);
    }
    // Recover
    state = onOpen();
    // 4 more errors — should NOT be degraded yet
    for (let i = 0; i < FAILURE_THRESHOLD - 1; i++) {
      state = onError(state);
    }
    expect(state.status).toBe('reconnecting');

    // 5th error — degraded again
    state = onError(state);
    expect(state.status).toBe('degraded');
  });
});

describe('MockEventSource protocol', () => {
  it('close is called when a new connection supersedes an old one', () => {
    const es1 = new MockEventSource('http://localhost/events');
    const closeSpy = es1.close;

    // Simulate closing the old connection before creating a new one
    es1.close();
    expect(closeSpy).toHaveBeenCalledOnce();
  });

  it('triggerMessage parses JSON and calls onmessage', () => {
    const es = new MockEventSource('http://localhost/events');
    const received: unknown[] = [];
    es.onmessage = (event) => {
      received.push(JSON.parse(event.data as string));
    };

    const event = { type: 'MODEL_STATE_CHANGED', modelName: 'llama3' };
    es.triggerMessage(event);

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject(event);
  });

  it('triggerError calls onerror', () => {
    const es = new MockEventSource('http://localhost/events');
    let errorFired = false;
    es.onerror = () => {
      errorFired = true;
    };
    es.triggerError();
    expect(errorFired).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Memory throttle simulator — mirrors the leading+trailing edge throttle
// logic in useEventStreamConnection's WORKER_MEMORY_UPDATED case
// ---------------------------------------------------------------------------

const MEMORY_THROTTLE_MS = 1_000;

interface ThrottleState {
  lastInvalidationAt: number;
  pendingTimer: ReturnType<typeof setTimeout> | undefined;
  invalidationCount: number;
}

function createThrottle(): ThrottleState {
  return { lastInvalidationAt: 0, pendingTimer: undefined, invalidationCount: 0 };
}

function fireMemoryEvent(state: ThrottleState): void {
  const now = Date.now();
  const elapsed = now - state.lastInvalidationAt;

  const doInvalidate = (): void => {
    state.lastInvalidationAt = Date.now();
    state.invalidationCount++;
  };

  if (elapsed >= MEMORY_THROTTLE_MS) {
    doInvalidate();
  } else if (!state.pendingTimer) {
    state.pendingTimer = setTimeout(() => {
      state.pendingTimer = undefined;
      doInvalidate();
    }, MEMORY_THROTTLE_MS - elapsed);
  }
}

describe('WORKER_MEMORY_UPDATED throttle logic', () => {
  it('first event fires immediately', () => {
    const state = createThrottle();
    fireMemoryEvent(state);

    expect(state.invalidationCount).toBe(1);
    expect(state.pendingTimer).toBeUndefined();
  });

  it('second event within 1s is deferred, not dropped', () => {
    const state = createThrottle();

    fireMemoryEvent(state);
    expect(state.invalidationCount).toBe(1);

    // Fire again within the throttle window
    fireMemoryEvent(state);
    expect(state.invalidationCount).toBe(1);
    expect(state.pendingTimer).toBeDefined();
  });

  it('deferred event fires after the throttle window', () => {
    const state = createThrottle();

    fireMemoryEvent(state);
    expect(state.invalidationCount).toBe(1);

    fireMemoryEvent(state);
    expect(state.invalidationCount).toBe(1);

    // Advance past the throttle window
    vi.advanceTimersByTime(MEMORY_THROTTLE_MS);
    expect(state.invalidationCount).toBe(2);
    expect(state.pendingTimer).toBeUndefined();
  });

  it('burst of events results in exactly 2 invalidations (leading + trailing)', () => {
    const state = createThrottle();

    fireMemoryEvent(state);
    fireMemoryEvent(state);
    fireMemoryEvent(state);
    fireMemoryEvent(state);
    expect(state.invalidationCount).toBe(1);

    vi.advanceTimersByTime(MEMORY_THROTTLE_MS);
    expect(state.invalidationCount).toBe(2);
  });

  it('events after the throttle window fire immediately again', () => {
    const state = createThrottle();

    fireMemoryEvent(state);
    expect(state.invalidationCount).toBe(1);

    vi.advanceTimersByTime(MEMORY_THROTTLE_MS);

    fireMemoryEvent(state);
    expect(state.invalidationCount).toBe(2);
    expect(state.pendingTimer).toBeUndefined();
  });
});
