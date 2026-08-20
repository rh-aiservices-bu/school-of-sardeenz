// RunnerLauncher — the seam between the worker agent's lifecycle logic (registration,
// management API, memory accounting, model dedup) and *how* a runner process is actually
// started. Two implementations:
//
//   - StubLauncher     (dev)  — forks an in-process Fastify stub (Phase 3.6 behaviour).
//   - ApptainerLauncher (prod) — `apptainer exec`s an engine SIF off the shared module volume.
//
// The RunnerManager owns ports, dedup, and memory; the launcher owns the process.

export interface DeviceRef {
  deviceIndex: number;
  deviceType: string;
}

// Everything a launcher needs to start one runner. Mirrors StartRunnerRequest plus the
// worker-assigned runnerId and port.
export interface LaunchSpec {
  runnerId: string;
  modelName: string;
  modelPath: string;
  runnerType: string;
  /**
   * `<engine>-<version>` module selector (e.g. "vllm-0.21"). The ApptainerLauncher resolves it
   * to `<modulesDir>/<runtimeModule>.sif`. The StubLauncher ignores it.
   */
  runtimeModule?: string;
  deviceType: string;
  requiredMemory: number;
  tensorParallel: number;
  engineConfig?: Record<string, unknown>;
  devices: DeviceRef[];
  port: number;
}

// Opaque handle returned by a launcher and stored by the RunnerManager. `stop()` closes over
// whatever process/stub the launcher created.
export interface LaunchHandle {
  host: string;
  port: number;
  pid?: number;
  stop: () => Promise<void>;
}

// Callback a launcher feeds raw captured output through, one call per stdio 'data' event (not
// pre-split into lines — the RunnerLogBuffer owns line-splitting). The RunnerManager wires this
// to `RunnerLogBuffer.append` so live launch output reaches the `/runners/:runnerId/logs` SSE
// route.
export type LogSink = (stream: 'stdout' | 'stderr', content: string) => void;

export interface RunnerLauncher {
  /**
   * When true, the RunnerManager serializes `start()` calls (one cold-start at a time) because
   * concurrent engine cold-starts each spike host RAM and can OOM a peer (spike Gate 9c). The
   * StubLauncher sets this false — in-process stubs are cheap and may start concurrently.
   */
  readonly serializeColdStarts: boolean;
  /**
   * Start one runner. For real engines this resolves only once the runner is serving (healthy),
   * so the manager's serialization guarantees the previous cold-start finished first.
   *
   * `onLog`, when provided, receives the runner's captured stdout/stderr as it's produced.
   * Optional and additive — existing callers that don't need logs are unaffected.
   */
  start(spec: LaunchSpec, onLog?: LogSink): Promise<LaunchHandle>;
}
