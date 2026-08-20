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

  // Notify any connected SSE clients that the runner process has exited, so they can emit the
  // `end` frame and close. Does not clear the buffer — call drop() for that.
  markEnded(runnerId: string): void {
    const listeners = this.endListeners.get(runnerId);
    if (!listeners) return;
    for (const cb of listeners) cb();
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
    this.buffers.delete(runnerId);
    this.logListeners.delete(runnerId);
    this.endListeners.delete(runnerId);
  }
}
