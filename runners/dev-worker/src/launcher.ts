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
   */
  start(spec: LaunchSpec): Promise<LaunchHandle>;
}
