import type { Redis } from 'ioredis';
import type { DevWorkerConfig } from './config.js';
import type { DetectedDevice } from './gpu-detect.js';
import type { KVCacheDeviceStats } from './runner-manager.js';

export interface CatalogCapabilityOverrides {
  supportedModelTypes?: string[];
  supportedDeviceTypes?: string[];
  supportedSleepLevels?: string[];
  engineVersion?: string;
  maxTensorParallelism?: number;
  kvCacheElasticSharing?: boolean;
  features?: Record<string, unknown>;
}

/**
 * One device's measured (NVML) usage, as sampled at report-build time. Doctrine: measured memory
 * IS the number everywhere downstream — there's no separate "reserved" figure. `memoryUsedBytes`
 * here always means an NVML reading; buildMemoryReport() falls back to the internal ledger itself
 * (as a simulated measurement) for any device this sample doesn't cover.
 */
export interface MeasuredDeviceSample {
  deviceIndex: number;
  memoryUsedBytes: number;
  deviceName?: string;
  utilizationPercent?: number;
  temperatureC?: number;
}

/** One runner instance's measured (NVML, process-attributed) usage on one device. */
export interface MeasuredInstanceSample {
  instanceId: string;
  modelName: string;
  deviceIndex: number;
  memoryUsedBytes: number;
}

export interface MeasuredMemorySample {
  devices: MeasuredDeviceSample[];
  instances: MeasuredInstanceSample[];
}

// Supplies a fresh NVML-derived sample on demand. Returns null when measurement isn't possible
// (no NVML, CPU box) — buildMemoryReport() then falls back to the ledger for devices and to
// ledgerInstancesProvider for instances. Owned by src/index.ts, which composes the NvmlReader with
// RunnerManager.getRunnerProcesses().
export type MeasuredMemoryProvider = () => Promise<MeasuredMemorySample | null>;

// Simulates instances[] from the worker's own runner ledger when measuredProvider is absent or
// resolves null (no NVML — stub mode / CPU-only host). Owned by src/index.ts, which composes
// RunnerManager.getLedgerInstanceShares() — see that method for why this correctly reports nothing
// for a sleeping runner despite being ledger-derived rather than NVML-derived.
export type LedgerInstancesProvider = () => Promise<MeasuredInstanceSample[]>;

// Per-device kvcached pool stats (issue #165), relayed verbatim from the runners' own
// /memory-report kvCache blocks. Owned by src/index.ts, which composes
// RunnerManager.getKvCacheDeviceStats(). Returns null when nothing is available (no running
// runners, every query failed); a device missing from the Map simply gets no kvCache field.
// Telemetry only — never feeds the ledger or placement math.
export type KVCacheDeviceProvider = () => Promise<Map<number, KVCacheDeviceStats> | null>;

export class WorkerRegistration {
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private readonly deviceMemoryUsed: number[];
  private readonly devices: DetectedDevice[];

  constructor(
    private readonly redis: Redis,
    private readonly config: DevWorkerConfig,
    // The advertised fleet. Defaults to the configured (simulated) fleet when not supplied — real
    // deployments pass GPUs resolved via resolveDevices() (NVML in apptainer mode).
    devices?: DetectedDevice[],
    private readonly fetchFn: typeof fetch = globalThis.fetch,
    private readonly catalogCapabilities?: CatalogCapabilityOverrides,
    private readonly measuredProvider?: MeasuredMemoryProvider,
    private readonly ledgerInstancesProvider?: LedgerInstancesProvider,
    private readonly kvCacheDeviceProvider?: KVCacheDeviceProvider,
  ) {
    this.devices =
      devices ??
      Array.from({ length: config.deviceCount }, (_, i) => ({
        deviceIndex: i,
        deviceType: config.deviceType,
        memoryTotalBytes: config.deviceMemoryBytes,
      }));
    this.deviceMemoryUsed = new Array<number>(this.devices.length).fill(0);
  }

  private key(...parts: string[]): string {
    return [this.config.redisKeyPrefix, ...parts].join(':');
  }

  async register(): Promise<void> {
    const info = {
      capabilities: [
        {
          runnerType: this.config.runnerType,
          engineName:
            this.config.mode === 'stub'
              ? `Dev Stub (${this.config.runnerType})`
              : `${this.config.runnerType} (apptainer)`,
          supportedModelTypes: this.catalogCapabilities?.supportedModelTypes ?? ['LLM'],
          // Always derived from detected devices — catalog overrides intentionally ignored
          supportedDeviceTypes: [...new Set(this.devices.map((d) => d.deviceType))],
          supportedSleepLevels: this.catalogCapabilities?.supportedSleepLevels ?? ['L1_HOST_RAM'],
          engineVersion: this.catalogCapabilities?.engineVersion ?? '0.0.1-dev',
          maxTensorParallelism: this.catalogCapabilities?.maxTensorParallelism ?? 1,
          kvCacheElasticSharing: this.catalogCapabilities?.kvCacheElasticSharing ?? false,
          features: this.catalogCapabilities?.features ?? {},
        },
      ],
      devices: this.devices,
      managementUrl: `http://${this.config.advertiseHost}:${this.config.workerPort}`,
    };

    const pipeline = this.redis.pipeline();
    pipeline.set(this.key('workers', this.config.workerId, 'info'), JSON.stringify(info));
    pipeline.set(this.key('workers', this.config.workerId, 'heartbeat'), new Date().toISOString());
    pipeline.set(
      this.key('workers', this.config.workerId, 'memory'),
      JSON.stringify(await this.buildMemoryReport()),
    );
    await pipeline.exec();
  }

  startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    const heartbeatKey = this.key('workers', this.config.workerId, 'heartbeat');
    const ttlMs = this.config.heartbeatIntervalMs * 4;
    this.heartbeatTimer = setInterval(() => {
      void (async () => {
        try {
          const res = await this.fetchFn(`http://127.0.0.1:${this.config.workerPort}/healthz`);
          if (!res.ok) return;
          await this.redis.set(heartbeatKey, new Date().toISOString(), 'PX', ttlMs);
          // Refresh the memory report every tick too, in every mode — this is what keeps
          // `reportedAt` (and any measured NVML figures) fresh for the control plane's staleness
          // checks, not just the ledger-driven allocate/free pushes below.
          await this.pushMemoryReport();
        } catch {
          // Health check failed or Redis write failed — skip this tick and let the key age out.
        }
      })();
    }, this.config.heartbeatIntervalMs);
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  async deregister(): Promise<void> {
    const pipeline = this.redis.pipeline();
    pipeline.del(this.key('workers', this.config.workerId, 'info'));
    pipeline.del(this.key('workers', this.config.workerId, 'heartbeat'));
    pipeline.del(this.key('workers', this.config.workerId, 'memory'));
    await pipeline.exec();
  }

  allocateMemory(deviceIndex: number, bytes: number): void {
    if (deviceIndex < 0 || deviceIndex >= this.deviceMemoryUsed.length) return;
    this.deviceMemoryUsed[deviceIndex] += bytes;
    void this.pushMemoryReport();
  }

  freeMemory(deviceIndex: number, bytes: number): void {
    if (deviceIndex < 0 || deviceIndex >= this.deviceMemoryUsed.length) return;
    this.deviceMemoryUsed[deviceIndex] = Math.max(0, this.deviceMemoryUsed[deviceIndex] - bytes);
    void this.pushMemoryReport();
  }

  getDeviceMemoryUsed(deviceIndex: number): number {
    return this.deviceMemoryUsed[deviceIndex] ?? 0;
  }

  // Doctrine: measured memory IS `memoryUsedBytes` everywhere downstream — there is no separate
  // "reserved"/ledger figure exposed anywhere in the report. Per device: an NVML reading from
  // measuredProvider when available, else the internal allocation ledger (deviceMemoryUsed) as a
  // simulated measurement — the ledger's only remaining purpose post-doctrine. `instances` is
  // always present (never omitted): NVML mode uses the process-attributed measurements: sample
  // from measuredProvider, no-NVML mode simulates them via ledgerInstancesProvider (backed by
  // RunnerManager's runner records). Both providers degrade silently on failure (thrown error, or
  // genuinely unavailable) rather than ever throwing out of report-building. reportedAt is always
  // set, in every mode, since it's what the control plane uses to judge staleness even for a stub
  // worker with no NVML measurement at all.
  private async buildMemoryReport(): Promise<Record<string, unknown>> {
    const [measured, kvCache] = await Promise.all([
      this.measuredProvider ? this.measuredProvider().catch(() => null) : Promise.resolve(null),
      this.kvCacheDeviceProvider ? this.kvCacheDeviceProvider().catch(() => null) : Promise.resolve(null),
    ]);
    const measuredByDevice = new Map(measured?.devices.map((d) => [d.deviceIndex, d]) ?? []);

    const devices = this.devices.map((device) => {
      const out: Record<string, unknown> = {
        deviceIndex: device.deviceIndex,
        deviceType: device.deviceType,
        memoryTotalBytes: device.memoryTotalBytes,
      };
      const sample = measuredByDevice.get(device.deviceIndex);
      if (sample) {
        out.memoryUsedBytes = sample.memoryUsedBytes;
        if (sample.deviceName !== undefined) out.deviceName = sample.deviceName;
        if (sample.utilizationPercent !== undefined)
          out.utilizationPercent = sample.utilizationPercent;
        if (sample.temperatureC !== undefined) out.temperatureC = sample.temperatureC;
      } else {
        // No NVML reading for this device (no reader at all, or just this device's query failed)
        // — fall back to the ledger as a simulated measurement. No device stats in this case;
        // the ledger has no notion of utilization/temperature/name. Indexed by deviceIndex to
        // match allocateMemory/freeMemory, not by array position.
        out.memoryUsedBytes = this.deviceMemoryUsed[device.deviceIndex] ?? 0;
      }
      // kvcached pool telemetry is independent of the NVML-vs-ledger choice above: it comes from
      // the runners themselves in every mode, and absence (no pool reported for this device)
      // means the field is omitted, never zeroed.
      const kvStats = kvCache?.get(device.deviceIndex);
      if (kvStats !== undefined) out.kvCache = kvStats;
      return out;
    });

    const instances = measured
      ? measured.instances
      : ((await this.ledgerInstancesProvider?.().catch(() => [])) ?? []);

    return { devices, instances, reportedAt: new Date().toISOString() };
  }

  private async pushMemoryReport(): Promise<void> {
    await this.redis.set(
      this.key('workers', this.config.workerId, 'memory'),
      JSON.stringify(await this.buildMemoryReport()),
    );
  }
}
