import type { DevWorkerConfig } from './config.js';
import type { WorkerRegistration } from './registration.js';
import type { LaunchHandle, LogSink, RunnerLauncher } from './launcher.js';
import { StubLauncher } from './stub-launcher.js';
import { MAX_RETAINED, RunnerLogBuffer } from './runner-log-buffer.js';
import { RunnerProcessState, type WorkerAgentComponents } from '@sardeenz/types';
import { randomUUID } from 'node:crypto';
import { createServer as netCreateServer } from 'node:net';

/**
 * One row of `GET /runners` (worker-agent contract `RunnerSummary`, #286). Typed against the
 * generated contract so a spec change that this view does not follow fails typecheck here instead
 * of drifting silently.
 */
export type RunnerSummary = WorkerAgentComponents['schemas']['RunnerSummary'];

/** One instance's ledger-simulated bytes on one device — see getLedgerInstanceShares(). */
export interface LedgerInstanceShare {
  instanceId: string;
  modelName: string;
  deviceIndex: number;
  bytes: number;
  /** The source row's scope from the runner's /memory-report (ADR-027); absent when the
   * source declared none — an absent value is unknown scope and every consumer treats it
   * conservatively, like `device`. Never relabeled on the way out. */
  attribution?: 'runner' | 'device';
}

/** One kvcached pool block as relayed from a runner's /memory-report (engine-runner contract
 * `KVCachePoolStats`); absent when the runner reports no pool for the device. */
export interface KVCacheDeviceStats {
  totalBytes: number;
  usedBytes: number;
  preallocBytes: number;
  freeBytes: number;
}

/** One device entry of a runner's /memory-report body (engine-runner contract
 * `DeviceMemoryUsage`); only the fields the worker consumes are modeled. */
interface RunnerMemoryReportDevice {
  deviceIndex: number;
  memoryUsedBytes: number;
  kvCache?: KVCacheDeviceStats;
  attribution?: 'runner' | 'device';
}

// Tries to bind 127.0.0.1:port; resolves true if the port is free, false if already in use.
export function probePortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = netCreateServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

export interface RunnerRecord {
  runnerId: string;
  instanceId: string;
  modelName: string;
  /** Management port (runner-contract API). */
  port: number;
  /** Inference port (`/v1/*` | `/v2/*`) the proxy targets — equals `port` for the single-server stub. */
  enginePort: number;
  /** MLServer gRPC port (base+2). Reserved for every runner; used only by OIP runners. */
  grpcPort: number;
  /** MLServer Prometheus-metrics port (base+3). Reserved for every runner; used only by OIP runners. */
  metricsPort: number;
  host: string;
  requiredMemory: number;
  devices: { deviceIndex: number; deviceType: string }[];
  /** The launch identity this record was created for — a later start compares against it (#288). */
  launchSpec: NormalizedLaunchSpec;
  handle: LaunchHandle;
}

export interface StartRunnerParams {
  modelName: string;
  /**
   * Control-plane-assigned instance identity (#120). Disambiguates replicas of the same model on
   * this worker — the sole conflict/lookup key, replacing the pre-#120 one-runner-per-model rule.
   * The route layer generates a fallback when the caller omits it (older/back-compat callers);
   * the control plane always sends one.
   */
  instanceId: string;
  runnerType: string;
  modelPath: string;
  requiredMemory: number;
  deviceType?: string;
  tensorParallel: number;
  runtimeModule?: string;
  engineConfig?: Record<string, unknown>;
  engineArgs?: string[];
  /** Optional engine-reported model identity (ADR-020); passed through to the launcher. */
  servedModelName?: string;
  /** Optional verbatim argv from catalog metadata (#125); passed through to the launcher. */
  entrypoint?: string[];
  devices: { deviceIndex: number; deviceType: string }[];
}

/** What `startRunner` answers. `reused` is set only when the caller got a runner this request did
 *  not spawn (#288) — a READY reuse or an in-flight join. */
export interface StartRunnerResult {
  runnerId: string;
  host: string;
  port: number;
  enginePort: number;
  /** true when this call returned a runner it did not spawn (READY reuse or in-flight join). */
  reused?: boolean;
}

/** Defaults the manager substitutes for omitted request fields — needed so two requests that
 *  differ only by an omitted-vs-explicit default compare equal. */
export interface LaunchSpecDefaults {
  runnerType: string;
  deviceType: string;
}

/**
 * The launch-relevant subset of a start request (#288, design D8). `instanceId` is the idempotency
 * key and the ports are allocated per launch, so neither is part of the launch identity. Every
 * member's ordering is fixed by construction, which makes `launchSpecMatches` a string compare.
 */
export interface NormalizedLaunchSpec {
  modelName: string;
  modelPath: string;
  runnerType: string;
  runtimeModule: string | null;
  deviceType: string;
  requiredMemory: number;
  tensorParallel: number;
  /** Canonical JSON (recursively key-sorted) so object key order never fakes a mismatch. */
  engineConfig: string | null;
  /** Ordered argv tail — order is meaningful, never sorted. */
  engineArgs: string[];
  servedModelName: string | null;
  /** Ordered argv — order is meaningful, never sorted. */
  entrypoint: string[];
  /** Sorted by deviceIndex: placement order is not part of the launch identity. */
  devices: { deviceIndex: number; deviceType: string }[];
}

// Recursively sorts object keys so two engineConfig objects that differ only in key order
// serialize identically. Arrays keep their order (argv semantics).
function canonicalJson(value: unknown): string {
  const canonicalize = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canonicalize);
    if (v && typeof v === 'object') {
      const record = v as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(record)
          .sort()
          .map((key) => [key, canonicalize(record[key])]),
      );
    }
    return v;
  };
  return JSON.stringify(canonicalize(value)) ?? 'null';
}

/** Normalize the launch-relevant fields of a start request for identity comparison (#288, D8). */
export function normalizeLaunchSpec(
  params: StartRunnerParams,
  defaults: LaunchSpecDefaults,
): NormalizedLaunchSpec {
  return {
    modelName: params.modelName,
    modelPath: params.modelPath,
    runnerType: params.runnerType || defaults.runnerType,
    runtimeModule: params.runtimeModule ?? null,
    deviceType: params.deviceType || defaults.deviceType,
    requiredMemory: params.requiredMemory,
    tensorParallel: params.tensorParallel,
    engineConfig: params.engineConfig === undefined ? null : canonicalJson(params.engineConfig),
    engineArgs: [...(params.engineArgs ?? [])],
    servedModelName: params.servedModelName ?? null,
    entrypoint: [...(params.entrypoint ?? [])],
    devices: [...params.devices]
      .sort((a, b) => a.deviceIndex - b.deviceIndex)
      .map((device) => ({ deviceIndex: device.deviceIndex, deviceType: device.deviceType })),
  };
}

/** Do two start requests describe the same launch? (#288, D8) */
export function launchSpecMatches(a: NormalizedLaunchSpec, b: NormalizedLaunchSpec): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// Ports reserved per runner: mgmt, engine, gRPC, metrics — see allocatePorts.
const PORTS_PER_RUNNER = 4;

export class RunnerManager {
  private readonly runners = new Map<string, RunnerRecord>();
  private readonly pendingRunners = new Map<
    string,
    { instanceId: string; modelName: string; handle?: LaunchHandle; cancelRequested: boolean }
  >();
  // modelName -> runnerIds. A Set, not a single id, because #120 allows N replicas of one model
  // on this worker; insertion order is preserved (JS Set iteration order), which
  // getRunnerIdForModel relies on to return the most-recently-started runner.
  private readonly modelRunners = new Map<string, Set<string>>();
  // instanceId -> runnerId. The unambiguous lookup/conflict key — unlike modelName, an instanceId
  // identifies exactly one runner even with replicas.
  private readonly instanceRunners = new Map<string, string>();
  // instanceId -> the in-flight start (#288). Registered synchronously by startRunner *before* its
  // first await, so a second POST for the same instanceId always observes one of: this promise
  // (join), the READY record (reuse), or neither (fresh start). Removed on settle so a *failed*
  // launch does not keep rejecting later attempts — runStart's catch rolls the slot back itself.
  private readonly instanceStarts = new Map<
    string,
    { spec: NormalizedLaunchSpec; runnerId: string; promise: Promise<StartRunnerResult> }
  >();
  // Failed launches are removed from instanceRunners so they do not block a retry, but their
  // sealed startup logs remain addressable by instanceId for RunnerLogBuffer's retention window.
  private readonly failedInstanceLogRunners = new Map<string, string>();
  // instanceId -> a failed launch whose process could not be confirmed dead (#288, D4). A retry
  // for that instance must stop it before spawning; DELETE /runners/{runnerId} addresses it too.
  // Deliberately NOT listed by getAllRunnerSummaries(): a zombie may be no process at all, and the
  // reverse sweep must not be handed a phantom. Bounded like failedInstanceLogRunners.
  private readonly failedLaunchHandles = new Map<
    string,
    { runnerId: string; handle: LaunchHandle }
  >();
  private readonly launcher: RunnerLauncher;
  private readonly logBuffer: RunnerLogBuffer;
  private readonly usedPorts = new Set<number>();
  private readonly probePort?: (port: number) => Promise<boolean>;
  // Serializes cold-starts when the launcher requires it (real engine cold-starts spike host RAM
  // and OOM a peer if run concurrently — spike Gate 9c). A promise chain acts as an async mutex.
  private coldStartChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly config: DevWorkerConfig,
    private readonly registration: WorkerRegistration,
    launcher?: RunnerLauncher,
    logBuffer?: RunnerLogBuffer,
    probePort?: (port: number) => Promise<boolean>,
    private readonly fetchFn: typeof fetch = globalThis.fetch,
  ) {
    this.launcher = launcher ?? new StubLauncher(config);
    this.logBuffer = logBuffer ?? new RunnerLogBuffer();
    this.probePort = probePort;
  }

  getLogBuffer(): RunnerLogBuffer {
    return this.logBuffer;
  }

  /**
   * Start — or join/reuse — the runner for one `instanceId` (#288). Deliberately **not** `async`:
   * the in-flight entry is registered before this method yields, so two concurrent callers can
   * never both reach `runStart`.
   */
  startRunner(params: StartRunnerParams): Promise<StartRunnerResult> {
    const inFlight = this.instanceStarts.get(params.instanceId);
    if (inFlight) return this.joinStart(inFlight, params);

    const existingId = this.instanceRunners.get(params.instanceId);
    if (existingId) return this.reuseRunner(existingId, params);

    const spec = normalizeLaunchSpec(params, this.launchSpecDefaults());
    const runnerId = `runner-${randomUUID().slice(0, 8)}`;
    const promise = this.runStart(
      params,
      spec,
      runnerId,
      this.failedLaunchHandles.get(params.instanceId),
    );
    this.instanceStarts.set(params.instanceId, { spec, runnerId, promise });
    promise
      .finally(() => {
        if (this.instanceStarts.get(params.instanceId)?.promise === promise) {
          this.instanceStarts.delete(params.instanceId);
        }
      })
      .catch(() => {}); // the caller owns the rejection; this chain only cleans the map
    return promise;
  }

  private launchSpecDefaults(): LaunchSpecDefaults {
    return { runnerType: this.config.runnerType, deviceType: this.config.deviceType };
  }

  // A second POST for an instance whose first start is still cold-starting: identical spec joins
  // that launch (both callers need the endpoint); a different spec is a real conflict (#288, D2).
  private async joinStart(
    joined: { spec: NormalizedLaunchSpec; runnerId: string; promise: Promise<StartRunnerResult> },
    params: StartRunnerParams,
  ): Promise<StartRunnerResult> {
    const spec = normalizeLaunchSpec(params, this.launchSpecDefaults());
    if (!launchSpecMatches(joined.spec, spec)) {
      throw new ConflictError(
        `Runner ${joined.runnerId} for instance ${params.instanceId} is already starting with a ` +
          `different launch spec; stop it first (DELETE /runners/${joined.runnerId})`,
      );
    }
    console.log(
      `[worker] POST /runners coalesced with in-flight start: instance=${params.instanceId} ` +
        `runner=${joined.runnerId}`,
    );
    const result = await joined.promise;
    return { ...result, reused: true };
  }

  // A repeat POST for an instance that already has a READY runner: describe it, spawn nothing
  // (#288, D1 step 2). No port allocation, no launcher call, no memory re-allocation. Returns a
  // promise (rather than throwing synchronously) so every `startRunner` outcome is a rejection.
  private reuseRunner(existingId: string, params: StartRunnerParams): Promise<StartRunnerResult> {
    const record = this.runners.get(existingId);
    if (!record) {
      // Defensive only: instanceRunners is claimed together with the in-flight entry, so a
      // claimed slot without a READY record is a launch that has not settled yet.
      return Promise.reject(
        new ConflictError(
          `Runner ${existingId} for instance ${params.instanceId} is still starting`,
        ),
      );
    }
    const spec = normalizeLaunchSpec(params, this.launchSpecDefaults());
    if (!launchSpecMatches(record.launchSpec, spec)) {
      return Promise.reject(
        new ConflictError(
          `Runner ${existingId} for instance ${params.instanceId} was started with a different ` +
            `launch spec; stop it first (DELETE /runners/${existingId})`,
        ),
      );
    }
    console.log(
      `[worker] POST /runners idempotent reuse: instance=${params.instanceId} ` +
        `runner=${existingId} (identical launch spec, no spawn)`,
    );
    return Promise.resolve({
      runnerId: record.runnerId,
      host: record.host,
      port: record.port,
      enginePort: record.enginePort,
      reused: true,
    });
  }

  private async runStart(
    params: StartRunnerParams,
    spec: NormalizedLaunchSpec,
    runnerId: string,
    zombie?: { runnerId: string; handle: LaunchHandle },
  ): Promise<StartRunnerResult> {
    // Reserve the instance slot up-front — synchronously, before the first await — so a second
    // start of the same instance (which missed the in-flight join only because it arrived later)
    // sees a claimed slot rather than racing this launch. Also register under modelName — a Set
    // now (#120), since several instances of the same model may run concurrently on this worker.
    this.instanceRunners.set(params.instanceId, runnerId);
    let modelRunnerIds = this.modelRunners.get(params.modelName);
    if (!modelRunnerIds) {
      modelRunnerIds = new Set();
      this.modelRunners.set(params.modelName, modelRunnerIds);
    }
    modelRunnerIds.add(runnerId);

    // A previous launch for this instance may have left a process behind (#288, D4). Try once more
    // to stop it; if it is still alive, refuse loudly instead of spawning a second process.
    if (zombie) {
      await zombie.handle.stop().catch(() => {});
      if (zombie.handle.isAlive?.()) {
        this.releaseReservation(params, runnerId);
        throw new ConflictError(
          `Runner ${zombie.runnerId} for instance ${params.instanceId} did not stop after a ` +
            `failed launch (pid=${zombie.handle.pid ?? '-'}); stop it first ` +
            `(DELETE /runners/${zombie.runnerId})`,
        );
      }
      this.failedLaunchHandles.delete(params.instanceId);
      console.warn(
        `[worker] Stopped retained launch ${zombie.runnerId} for instance ` +
          `${params.instanceId} before retry`,
      );
    }

    // Pre-declared nullable port bindings: the catch below deletes the block base from
    // usedPorts, so the binding must exist (not be destructured inside the try) — otherwise an
    // allocation failure that throws before the destructure would make the catch's delete hit
    // an unset binding and mask the original error. Safety only: allocatePorts never leaves
    // usedPorts residue on its exhausted-range throw (every add is paired with a delete unless
    // it returned a block).
    let port: number | undefined;
    let enginePort: number | undefined;
    let grpcPort: number | undefined;
    let metricsPort: number | undefined;
    try {
      ({ port, enginePort, grpcPort, metricsPort } = await this.allocatePorts());
      const pending: {
        instanceId: string;
        modelName: string;
        handle?: LaunchHandle;
        cancelRequested: boolean;
      } = { instanceId: params.instanceId, modelName: params.modelName, cancelRequested: false };
      this.pendingRunners.set(runnerId, pending);

      // Post-startup supervision: if the runner's process exits on its own (crash, OOM-kill, etc.)
      // rather than via a deliberate stopRunner(), reap its record and free its device memory so a
      // dead runner doesn't leave a phantom VRAM reservation. Guarded on `this.runners.has` so this
      // no-ops when stopRunner() has already removed the record before calling handle.stop() (see
      // stopRunner's ordering below) — otherwise a deliberate stop would double-free memory.
      const handleUnexpectedExit = (): void => {
        if (!this.runners.has(runnerId)) return;
        const record = this.runners.get(runnerId)!;
        for (const device of record.devices) {
          const perDeviceMemory = Math.floor(record.requiredMemory / record.devices.length);
          this.registration.freeMemory(device.deviceIndex, perDeviceMemory);
        }
        this.registration.pushMemoryReportOnce();
        this.runners.delete(runnerId);
        this.usedPorts.delete(record.port);
        this.instanceRunners.delete(record.instanceId);
        this.modelRunners.get(record.modelName)?.delete(runnerId);
        if (this.modelRunners.get(record.modelName)?.size === 0) {
          this.modelRunners.delete(record.modelName);
        }
        this.logBuffer.markEnded(runnerId);
        this.logBuffer.retain(runnerId);
        console.log(
          `[worker] Runner ${runnerId} (${params.modelName}/${params.instanceId}) exited unexpectedly — cleaned up`,
        );
      };

      const handle = await this.launch(
        {
          runnerId,
          modelName: params.modelName,
          modelPath: params.modelPath,
          runnerType: params.runnerType || this.config.runnerType,
          runtimeModule: params.runtimeModule,
          deviceType: params.deviceType || this.config.deviceType,
          requiredMemory: params.requiredMemory,
          tensorParallel: params.tensorParallel,
          engineConfig: params.engineConfig,
          engineArgs: params.engineArgs,
          servedModelName: params.servedModelName,
          entrypoint: params.entrypoint,
          devices: params.devices,
          port,
          enginePort,
          grpcPort,
          metricsPort,
        },
        (stream, content) => this.logBuffer.append(runnerId, stream, content),
        // Once the engine has finished starting, end the launch-log stream: connected viewers stop
        // streaming and the buffered startup logs are sealed for later "View starting logs" reopens,
        // so post-startup request logs never reach the control plane. The buffer is kept until the
        // runner is stopped (drop() in stopRunner).
        () => this.logBuffer.markEnded(runnerId),
        handleUnexpectedExit,
        (handle) => {
          pending.handle = handle;
          if (pending.cancelRequested) void handle.stop().catch(() => {});
        },
      );

      if (pending.cancelRequested) {
        await handle.stop().catch(() => {});
        throw new Error(`Runner start cancelled for instance ${params.instanceId}`);
      }

      const record: RunnerRecord = {
        runnerId,
        instanceId: params.instanceId,
        modelName: params.modelName,
        port: handle.port,
        enginePort: handle.enginePort,
        grpcPort,
        metricsPort,
        host: handle.host,
        requiredMemory: params.requiredMemory,
        devices: params.devices,
        launchSpec: spec,
        handle,
      };
      this.runners.set(runnerId, record);
      this.failedInstanceLogRunners.delete(params.instanceId);

      for (const device of params.devices) {
        const perDeviceMemory = Math.floor(params.requiredMemory / params.devices.length);
        this.registration.allocateMemory(device.deviceIndex, perDeviceMemory);
      }
      this.registration.pushMemoryReportOnce();

      // `pid` makes a duplicated log block self-diagnosing (#288, D5): the same pid on two
      // "Started runner" lines is one process logged twice; a different pid for one instanceId
      // would be a genuine double spawn — impossible with the guard above.
      console.log(
        `[worker] Started runner ${runnerId} for ${params.modelName}/${params.instanceId} on ${handle.host}:${handle.port}` +
          (handle.enginePort !== handle.port ? ` (inference on :${handle.enginePort})` : '') +
          ` pid=${handle.pid ?? '-'}`,
      );

      return { runnerId, host: handle.host, port: handle.port, enginePort: handle.enginePort };
    } catch (err) {
      // Roll back the reserved instance/model slots so a failed start doesn't permanently block
      // either the instance id or (transitively) the model. Covers allocation-phase failures too:
      // the reservation happens above the try, so an exhausted port range rolls it back instead of
      // stranding it behind ConflictError.
      if (port !== undefined) this.usedPorts.delete(port);
      this.releaseReservation(params, runnerId);
      // Seal the launch-log stream (any SSE client attached mid-launch gets its `end` frame) and
      // schedule the buffer for later cleanup — there's no stopRunner() call for a failed launch to
      // drop() it, so without retain() the failure logs (and their listeners) would leak forever.
      this.logBuffer.markEnded(runnerId);
      this.logBuffer.retain(runnerId);
      if (
        !this.failedInstanceLogRunners.has(params.instanceId) &&
        this.failedInstanceLogRunners.size >= MAX_RETAINED
      ) {
        const oldestInstanceId = this.failedInstanceLogRunners.keys().next().value;
        if (oldestInstanceId) this.failedInstanceLogRunners.delete(oldestInstanceId);
      }
      this.failedInstanceLogRunners.set(params.instanceId, runnerId);

      // A failed launch whose process is not confirmed dead must not be forgotten: a retry would
      // spawn a second process under a new runnerId with nothing able to stop the first (#288, D4).
      // When the caller already requested the stop (stopRunner's cancel path, or the cancel branch
      // above), stop() has been issued once; issuing it again would only double the launcher call.
      const pendingEntry = this.pendingRunners.get(runnerId);
      const failedHandle = pendingEntry?.handle;
      if (failedHandle) {
        if (!pendingEntry?.cancelRequested) {
          await failedHandle.stop().catch(() => {});
        }
        if (failedHandle.isAlive?.()) {
          this.retainFailedLaunch(params.instanceId, runnerId, failedHandle);
          console.error(
            `[worker] Runner ${runnerId} for instance ${params.instanceId} did not stop after a ` +
              `failed launch — retained as a zombie (pid=${failedHandle.pid ?? '-'}); ` +
              `retry DELETE /runners/${runnerId}`,
          );
        }
      }
      throw err;
    } finally {
      this.pendingRunners.delete(runnerId);
    }
  }

  // Undo runStart's synchronous instance/model reservation. Shared by the launch catch and the
  // retained-zombie refusal so both roll back identically.
  private releaseReservation(params: StartRunnerParams, runnerId: string): void {
    this.instanceRunners.delete(params.instanceId);
    const modelRunnerIds = this.modelRunners.get(params.modelName);
    modelRunnerIds?.delete(runnerId);
    if (modelRunnerIds?.size === 0) this.modelRunners.delete(params.modelName);
  }

  // Bound the retention map exactly like failedInstanceLogRunners: FIFO by insertion, evicting the
  // oldest. An evicted handle gets one last stop attempt — dropping it silently would discard the
  // only reference to a live process.
  private retainFailedLaunch(instanceId: string, runnerId: string, handle: LaunchHandle): void {
    if (
      !this.failedLaunchHandles.has(instanceId) &&
      this.failedLaunchHandles.size >= MAX_RETAINED
    ) {
      const oldestInstanceId = this.failedLaunchHandles.keys().next().value;
      if (oldestInstanceId) {
        const evicted = this.failedLaunchHandles.get(oldestInstanceId);
        this.failedLaunchHandles.delete(oldestInstanceId);
        if (evicted) {
          void evicted.handle.stop().catch(() => {});
          console.warn(
            `[worker] Dropped retained launch ${evicted.runnerId} for instance ` +
              `${oldestInstanceId} (retention bound ${MAX_RETAINED}); its process may still be alive`,
          );
        }
      }
    }
    this.failedLaunchHandles.set(instanceId, { runnerId, handle });
  }

  private findRetainedLaunch(
    runnerId: string,
  ): { instanceId: string; handle: LaunchHandle } | undefined {
    for (const [instanceId, retained] of this.failedLaunchHandles) {
      if (retained.runnerId === runnerId) return { instanceId, handle: retained.handle };
    }
    return undefined;
  }

  // Run the launcher, serializing cold-starts when the launcher requires it.
  private launch(
    spec: Parameters<RunnerLauncher['start']>[0],
    onLog?: LogSink,
    onStartupComplete?: () => void,
    onExit?: () => void,
    onLaunchHandle?: (handle: LaunchHandle) => void,
  ): Promise<LaunchHandle> {
    const start = (): Promise<LaunchHandle> => {
      if (this.pendingRunners.get(spec.runnerId)?.cancelRequested) {
        return Promise.reject(new Error(`Runner start cancelled for ${spec.runnerId}`));
      }
      return this.launcher.start(spec, onLog, onStartupComplete, onExit, onLaunchHandle);
    };
    if (!this.launcher.serializeColdStarts) {
      return start();
    }
    const result = this.coldStartChain.then(start);
    // Keep the chain alive regardless of this start's success/failure.
    this.coldStartChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async stopRunner(runnerId: string): Promise<void> {
    const record = this.runners.get(runnerId);
    const pending = this.pendingRunners.get(runnerId);
    if (!record && pending) {
      pending.cancelRequested = true;
      if (pending.handle) await pending.handle.stop();
      return;
    }
    if (!record) {
      const retained = this.findRetainedLaunch(runnerId);
      if (retained) {
        await retained.handle.stop().catch(() => {});
        this.failedLaunchHandles.delete(retained.instanceId);
        if (retained.handle.isAlive?.()) {
          console.error(
            `[worker] DELETE /runners/${runnerId}: retained launch for instance ` +
              `${retained.instanceId} may still be alive (pid=${retained.handle.pid ?? '-'})`,
          );
        } else {
          console.warn(
            `[worker] Stopped retained launch ${runnerId} for instance ${retained.instanceId}`,
          );
        }
        return;
      }
      throw new NotFoundError(`Runner ${runnerId} not found`);
    }

    // Remove the record and free memory BEFORE stopping the process: the process exiting in
    // response to stop() fires the launcher's post-startup supervision callback
    // (handleUnexpectedExit in startRunner), which guards on `this.runners.has(runnerId)` — clearing
    // the record here first makes that guard a no-op so a deliberate stop doesn't double-free memory.
    this.runners.delete(runnerId);
    this.usedPorts.delete(record.port);
    this.instanceRunners.delete(record.instanceId);
    this.modelRunners.get(record.modelName)?.delete(runnerId);
    if (this.modelRunners.get(record.modelName)?.size === 0) {
      this.modelRunners.delete(record.modelName);
    }

    for (const device of record.devices) {
      const perDeviceMemory = Math.floor(record.requiredMemory / record.devices.length);
      this.registration.freeMemory(device.deviceIndex, perDeviceMemory);
    }
    this.registration.pushMemoryReportOnce();

    await record.handle.stop();

    // Signal any connected SSE clients that the stream is over before dropping the buffer —
    // otherwise a client's `end` frame would race a listener set already cleared by drop().
    this.logBuffer.markEnded(runnerId);
    this.logBuffer.drop(runnerId);

    console.log(`[worker] Stopped runner ${runnerId} (${record.modelName}/${record.instanceId})`);
  }

  async stopAll(): Promise<void> {
    // Stop concurrently: cold-start serialization is a start-time constraint, not a stop-time one,
    // and draining runners in series would let total teardown exceed the pod's grace period when a
    // worker hosts several runners. Each stopRunner touches distinct map keys, so this is safe.
    // Retained failed launches are included: draining a worker must attempt every process it knows
    // about, including one whose launch failed after the process started (#288).
    const runnerIds = new Set([
      ...this.runners.keys(),
      ...this.pendingRunners.keys(),
      ...[...this.failedLaunchHandles.values()].map((retained) => retained.runnerId),
    ]);
    await Promise.all([...runnerIds].map((runnerId) => this.stopRunner(runnerId)));
  }

  getRunner(runnerId: string): RunnerRecord | undefined {
    return this.runners.get(runnerId);
  }

  // Resolve the runnerId for a model. Unlike getRunner() (backed by the `runners` map, which is
  // only populated once a cold-start is *healthy*), this reads `modelRunners`, which is set the
  // instant startRunner() is entered — so a runner's logs are addressable during cold-start, which
  // is exactly the window the deploy modal wants to stream. With replicas (#120), several runners
  // may serve the same model name on this worker — returns the *most recently started* one (Set
  // iteration order is insertion order in JS), matching the by-model logs route's documented
  // ambiguity. Use getRunnerIdForInstance to address a specific replica unambiguously.
  getRunnerIdForModel(modelName: string): string | undefined {
    const ids = this.modelRunners.get(modelName);
    if (!ids || ids.size === 0) return undefined;
    let last: string | undefined;
    for (const id of ids) last = id;
    return last;
  }

  // Resolve the runnerId for a specific instance — unambiguous even with replicas of the same
  // model on this worker. Like getRunnerIdForModel, set the instant startRunner() is entered.
  getRunnerIdForInstance(instanceId: string): string | undefined {
    const active = this.instanceRunners.get(instanceId);
    if (active) return active;
    const failed = this.failedInstanceLogRunners.get(instanceId);
    if (!failed) return undefined;
    if (this.logBuffer.has(failed)) return failed;
    this.failedInstanceLogRunners.delete(instanceId);
    return undefined;
  }

  // The retained failed launch ("zombie", #288 D4) for an instance, if its process could not be
  // confirmed dead — exposed to the status route so the control plane can stop it. Only the
  // runnerId leaves the manager: the caller needs an id to DELETE, never the launcher handle.
  // Deliberately separate from getRunnerIdForInstance, which answers registry/log identity and
  // would misreport a zombie as STARTING once its log buffer is the only thing left.
  getRetainedLaunchForInstance(instanceId: string): { runnerId: string } | undefined {
    const retained = this.failedLaunchHandles.get(instanceId);
    return retained ? { runnerId: retained.runnerId } : undefined;
  }

  getAllRunners(): RunnerRecord[] {
    return Array.from(this.runners.values());
  }

  /**
   * The worker's runner registry as the worker-agent contract `RunnerSummary` list (#286):
   * READY runners plus launches still in flight. Includes `pendingRunners` on purpose — a start
   * that is still awaiting engine health is exactly the window in which the control plane may
   * have lost the record that requested it, and the reverse sweep must be able to see it.
   *
   * READY records come from `this.runners` (populated at the end of `startRunner`); STARTING
   * records from `this.pendingRunners` (populated in `startRunner`, cleared in its `finally`).
   * The two are disjoint at every point a request can observe them: the runner is inserted into
   * `runners` and removed from `pendingRunners` in the same synchronous tail of `startRunner`,
   * and this method is synchronous, so no interleaving is possible.
   */
  getAllRunnerSummaries(): RunnerSummary[] {
    const summaries: RunnerSummary[] = [];
    for (const record of this.runners.values()) {
      summaries.push({
        runnerId: record.runnerId,
        instanceId: record.instanceId,
        modelName: record.modelName,
        state: RunnerProcessState.READY,
        host: record.host,
        port: record.port,
        enginePort: record.enginePort,
      });
    }
    for (const [runnerId, pending] of this.pendingRunners) {
      summaries.push({
        runnerId,
        instanceId: pending.instanceId,
        modelName: pending.modelName,
        state: RunnerProcessState.STARTING,
      });
    }
    return summaries;
  }

  // Runners whose launcher recorded a process PID (the ApptainerLauncher; the StubLauncher never
  // sets handle.pid). Used to attribute NVML-reported GPU processes back to a runner instance — the
  // NVML PID is a descendant of handle.pid (apptainer exec -> shim -> engine), so callers walk the
  // parent chain (see proc-tree.ts) rather than comparing PIDs directly.
  getRunnerProcesses(): Array<{ pid: number; instanceId: string; modelName: string }> {
    const out: Array<{ pid: number; instanceId: string; modelName: string }> = [];
    for (const record of this.runners.values()) {
      if (record.handle.pid !== undefined) {
        out.push({
          pid: record.handle.pid,
          instanceId: record.instanceId,
          modelName: record.modelName,
        });
      }
    }
    return out;
  }

  // Simulates per-instance measured bytes for the worker's memory report when NVML isn't available
  // (stub mode / CPU-only host), by querying each running runner's own `/memory-report` endpoint —
  // part of the runner contract every launcher implements (see
  // packages/contracts/specs/engine-runner.yaml). Reusing that endpoint, rather than re-deriving
  // sleep state here, is what makes a sleeping runner correctly contribute nothing: the runner's
  // own /memory-report already reports 0 while SLEEPING (runner-stub/routes/memory.ts). A runner
  // whose query fails (unreachable, still starting, in ERROR state, non-2xx) contributes no
  // entries rather than a stale guess — this method never rejects.
  //
  // Scope rule (ADR-027, issue #278): a `runner`-scope row is genuinely per-runner and is emitted
  // as-is (the stub's own-ledger figure). A `device`-scope or unknown-scope row is a WHOLE-device
  // observation — promoting it into an instance row while any other runner record claims the same
  // device would double-count every co-located instance, so it is promoted only while its runner
  // is the device's SOLE record among this worker's runner records, and dropped otherwise (its
  // bytes surface in the dashboard's Other bucket downstream). Residency is decided from runner
  // records (`RunnerRecord.devices`), never from reported bytes: a sleeping or ERROR co-tenant's
  // record persists until stopRunner() and its residual CUDA context can still hold bytes, so it
  // blocks promotion. A promoted row carries the source scope verbatim — never relabeled to
  // `runner`, which would overclaim (device rows include processes outside Sardeenz).
  async getLedgerInstanceShares(): Promise<LedgerInstanceShare[]> {
    const reports = await this.fetchMemoryReports();
    // deviceIndex -> every runner record claiming the device (this.runners, not the fetched
    // reports — a co-tenant whose query failed still holds its record and its bytes).
    const claimantsByDevice = new Map<number, Set<string>>();
    for (const record of this.runners.values()) {
      for (const device of record.devices) {
        let claimants = claimantsByDevice.get(device.deviceIndex);
        if (!claimants) {
          claimants = new Set();
          claimantsByDevice.set(device.deviceIndex, claimants);
        }
        claimants.add(record.runnerId);
      }
    }
    return reports.flatMap(({ record, body }) =>
      (body.devices ?? [])
        .filter((d) => d.memoryUsedBytes > 0) // sleeping (or otherwise idle) runners hold nothing
        .flatMap((d): LedgerInstanceShare[] => {
          // The report body is untyped JSON cast at the fetch boundary, so a runner-supplied
          // attribution can be any value; only the contract's two enum values may reach a
          // LedgerInstanceShare — and the worker's outbound report. Anything else clamps to
          // absent: unknown scope, treated conservatively like `device` below.
          const attribution =
            d.attribution === 'runner' || d.attribution === 'device' ? d.attribution : undefined;
          if (attribution !== 'runner') {
            // Device- or unknown-scope row: promote only while this runner is the device's sole
            // record (sole-residency exception); otherwise drop — never a per-instance figure.
            const claimants = claimantsByDevice.get(d.deviceIndex);
            if (claimants && [...claimants].some((id) => id !== record.runnerId)) return [];
          }
          return [
            {
              instanceId: record.instanceId,
              modelName: record.modelName,
              deviceIndex: d.deviceIndex,
              bytes: d.memoryUsedBytes,
              ...(attribution !== undefined ? { attribution } : {}),
            },
          ];
        }),
    );
  }

  // Per-device kvcached pool stats relayed from the runners' own /memory-report kvCache blocks
  // (issue #165) — the NVML-active path needs them too since NVML has no pool-level figures.
  // Co-located runners that share a pool segment (same GPU) report the same numbers; a device
  // with no reported pool is simply absent from the result (absent means absent, not zero).
  async getKvCacheDeviceStats(): Promise<Map<number, KVCacheDeviceStats>> {
    const stats = new Map<number, KVCacheDeviceStats>();
    for (const { body } of await this.fetchMemoryReports()) {
      for (const device of body.devices ?? []) {
        if (device.kvCache && !stats.has(device.deviceIndex)) {
          stats.set(device.deviceIndex, device.kvCache);
        }
      }
    }
    return stats;
  }

  // One /memory-report fetch per running runner. Timeout so a hung runner (socket accepted,
  // response never sent) can't pend this Promise.all forever — that would freeze the
  // heartbeat's memory-report push and eventually mark the whole worker's budget stale on the
  // control plane. A runner whose query fails (unreachable, still starting, in ERROR state,
  // non-2xx) contributes nothing rather than a stale guess; never rejects.
  private async fetchMemoryReports(): Promise<
    Array<{ record: RunnerRecord; body: { devices?: RunnerMemoryReportDevice[] } }>
  > {
    const records = Array.from(this.runners.values());
    const perRunner = await Promise.all(
      records.map(async (record) => {
        try {
          const res = await this.fetchFn(`http://127.0.0.1:${record.port}/memory-report`, {
            signal: AbortSignal.timeout(2000),
          });
          if (!res.ok) return null;
          const body = (await res.json()) as { devices?: RunnerMemoryReportDevice[] };
          return { record, body };
        } catch {
          return null;
        }
      }),
    );
    return perRunner.filter(
      (r): r is { record: RunnerRecord; body: { devices?: RunnerMemoryReportDevice[] } } =>
        r !== null,
    );
  }

  // Allocate a contiguous block of PORTS_PER_RUNNER ports for one runner:
  //   (mgmt=base, engine=base+1, grpc=base+2, metrics=base+3)
  // A uniform block per runner (protocol-agnostic): OpenAI/stub runners bind only mgmt (+engine for
  // vLLM) and leave grpc/metrics unused; OIP (MLServer) runners bind all four (engine/gRPC/metrics
  // via SARDEENZ_MLSERVER_*_PORT env — see apptainer-launcher.ts). Reserving explicit ports removes
  // the MLServer shim's +10000/+20000 offset derivation and its 65535 ceiling (#160). The engine
  // port stays mgmt+1, preserving the invariant real engines (vLLM) rely on.
  //
  // Scans for the lowest free block in [runnerPortStart, runnerPortStart + maxRunners *
  // PORTS_PER_RUNNER), stepping by PORTS_PER_RUNNER, so blocks released by stopRunner()/crash
  // cleanup get reused instead of exhausting the range. usedPorts tracks only `base`: the whole
  // block is a pure function of base, so freeing base frees the block.
  private async allocatePorts(): Promise<{
    port: number;
    enginePort: number;
    grpcPort: number;
    metricsPort: number;
  }> {
    const rangeEnd = this.config.runnerPortStart + this.config.maxRunners * PORTS_PER_RUNNER;
    for (let base = this.config.runnerPortStart; base < rangeEnd; base += PORTS_PER_RUNNER) {
      if (this.usedPorts.has(base)) continue;
      // Skip any block that would overlap the worker's own management port.
      if (this.config.workerPort >= base && this.config.workerPort <= base + PORTS_PER_RUNNER - 1)
        continue;
      this.usedPorts.add(base);
      if (this.probePort) {
        const free =
          (await this.probePort(base)) &&
          (await this.probePort(base + 1)) &&
          (await this.probePort(base + 2)) &&
          (await this.probePort(base + 3));
        if (!free) {
          this.usedPorts.delete(base);
          continue;
        }
      }
      return { port: base, enginePort: base + 1, grpcPort: base + 2, metricsPort: base + 3 };
    }
    throw new Error(
      `Port range exhausted: all ${this.config.maxRunners} runner slots in ` +
        `[${this.config.runnerPortStart}, ${rangeEnd}) are in use`,
    );
  }
}

export class ConflictError extends Error {
  readonly statusCode = 409;
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

export class NotFoundError extends Error {
  readonly statusCode = 404;
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}
