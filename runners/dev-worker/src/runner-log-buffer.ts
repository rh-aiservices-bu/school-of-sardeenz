import type { WorkerAgentComponents } from '@sardeenz/types';

// Per-runnerId ring buffer + pub/sub for captured stdout/stderr, backing the
// `GET /runners/:runnerId/logs` SSE endpoint. Owned by the RunnerManager: one buffer instance
// serves every runner on this worker, keyed by runnerId.

export type RunnerLogLine = WorkerAgentComponents['schemas']['RunnerLogLine'];
// Plain string literal union (matches launcher.ts's LogSink and Node's own stdio stream names) —
// not the generated `RunnerLogLineStream` enum, so every seam that produces a stream tag stays
// decoupled from an openapi-typescript codegen detail. Structurally identical to the enum's
// values, so it's cast when a RunnerLogLine is actually constructed below.
export type LogStream = 'stdout' | 'stderr';

const DEFAULT_CAP = 1000;
export const RETAIN_TTL_MS = 5 * 60 * 1000; // 5 minutes
export const MAX_RETAINED = 20;

// The control plane and the launcher poll the runner's control endpoints (health/progress/etc.)
// constantly, so the engine's HTTP access log fills with one line per poll — pure noise for a human
// watching a launch. Drop those access-log lines (e.g. uvicorn's
// `INFO: 127.0.0.1:52012 - "GET /health HTTP/1.1" 200 OK`) at capture time so they never reach the
// buffer, replay, or live stream. Real engine/startup logs (which don't match this shape) pass through.
const POLL_NOISE_RE =
  /-\s+"(?:GET|POST|HEAD)\s+\/(?:health|progress|memory-report|sleep-status|capabilities)\b/;

type LogListener = (line: RunnerLogLine) => void;
type EndListener = () => void;

export class RunnerLogBuffer {
  private readonly buffers = new Map<string, RunnerLogLine[]>();
  private readonly logListeners = new Map<string, Set<LogListener>>();
  private readonly endListeners = new Map<string, Set<EndListener>>();
  // Runners whose log stream has been ended (startup complete, or the runner stopped). Recorded so a
  // client that connects *after* the end signal fired still gets an immediate `end` frame after the
  // replay, rather than hanging on a stream that will never produce another line.
  private readonly ended = new Set<string>();
  // Pending drop() timers scheduled by retain(), keyed by runnerId.
  private readonly retainTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly cap: number = DEFAULT_CAP) {}

  // Splits `content` on newlines (a launcher's stdio 'data' events don't align with log lines)
  // and pushes one buffered entry per non-empty trailing line, notifying live subscribers.
  append(runnerId: string, stream: LogStream, content: string): void {
    const lines = content.split('\n');
    // A trailing newline produces a trailing empty element — drop it, not a real line.
    if (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop();
    }
    if (lines.length === 0) return;

    let buffer = this.buffers.get(runnerId);
    if (!buffer) {
      buffer = [];
      this.buffers.set(runnerId, buffer);
    }
    const listeners = this.logListeners.get(runnerId);

    for (const raw of lines) {
      if (POLL_NOISE_RE.test(raw)) continue; // control-endpoint poll spam — never buffer or emit it
      const line: RunnerLogLine = {
        ts: new Date().toISOString(),
        stream: stream as RunnerLogLine['stream'],
        content: raw,
      };
      buffer.push(line);
      if (listeners) {
        for (const cb of listeners) cb(line);
      }
    }

    if (buffer.length > this.cap) {
      buffer.splice(0, buffer.length - this.cap);
    }
  }

  // Subscribe to live lines for a runner. Returns an unsubscribe function.
  onLog(runnerId: string, cb: LogListener): () => void {
    let listeners = this.logListeners.get(runnerId);
    if (!listeners) {
      listeners = new Set();
      this.logListeners.set(runnerId, listeners);
    }
    listeners.add(cb);
    return () => {
      listeners?.delete(cb);
    };
  }

  // Subscribe to the runner's end-of-stream signal (fired by markEnded). Returns an unsubscribe
  // function.
  onEnd(runnerId: string, cb: EndListener): () => void {
    let listeners = this.endListeners.get(runnerId);
    if (!listeners) {
      listeners = new Set();
      this.endListeners.set(runnerId, listeners);
    }
    listeners.add(cb);
    return () => {
      listeners?.delete(cb);
    };
  }

  // End a runner's log stream: notify connected SSE clients so they emit the `end` frame, and
  // record the runner as ended so late-connecting clients also get one. Idempotent. Called when the
  // engine finishes starting (seal the startup logs) and again when the runner stops. Does not clear
  // the buffer — call drop() for that, so the startup logs stay viewable via "View starting logs".
  markEnded(runnerId: string): void {
    this.ended.add(runnerId);
    const listeners = this.endListeners.get(runnerId);
    if (!listeners) return;
    for (const cb of listeners) cb();
  }

  // Whether a runner's log stream has already ended (see markEnded).
  isEnded(runnerId: string): boolean {
    return this.ended.has(runnerId);
  }

  // Copy of the buffered lines, oldest first — safe for a caller to replay without racing
  // concurrent appends.
  getBuffer(runnerId: string): RunnerLogLine[] {
    return [...(this.buffers.get(runnerId) ?? [])];
  }

  has(runnerId: string): boolean {
    return this.buffers.has(runnerId);
  }

  // Clear a runner's buffer and listeners (called once its SSE clients have had a chance to see
  // the `end` frame).
  drop(runnerId: string): void {
    const timer = this.retainTimers.get(runnerId);
    if (timer) {
      clearTimeout(timer);
      this.retainTimers.delete(runnerId);
    }

    this.buffers.delete(runnerId);
    this.logListeners.delete(runnerId);
    this.endListeners.delete(runnerId);
    this.ended.delete(runnerId);
  }

  // Schedule a runner's buffer for automatic drop() after RETAIN_TTL_MS. Used when a launch fails:
  // there's no stopRunner() call to drop() the buffer, so without this the failure logs (and their
  // listeners) would remain in memory forever. Caps the number of retained buffers at MAX_RETAINED,
  // evicting the oldest-scheduled retention first, so a burst of failed launches can't leak memory
  // faster than the TTL reclaims it. Idempotent — calling again resets the TTL.
  retain(runnerId: string): void {
    const existing = this.retainTimers.get(runnerId);
    if (existing) clearTimeout(existing);

    if (!this.retainTimers.has(runnerId) && this.retainTimers.size >= MAX_RETAINED) {
      const oldest = this.retainTimers.keys().next().value!;
      clearTimeout(this.retainTimers.get(oldest));
      this.retainTimers.delete(oldest);
      this.drop(oldest);
    }

    const timer = setTimeout(() => {
      this.retainTimers.delete(runnerId);
      this.drop(runnerId);
    }, RETAIN_TTL_MS);
    timer.unref();
    this.retainTimers.set(runnerId, timer);
  }
}
