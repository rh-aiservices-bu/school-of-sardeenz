import type { Redis } from 'ioredis';
import type { DevWorkerConfig } from './config.js';
import type { DetectedDevice } from './gpu-detect.js';

export interface CatalogCapabilityOverrides {
  supportedModelTypes?: string[];
  supportedDeviceTypes?: string[];
  supportedSleepLevels?: string[];
  engineVersion?: string;
  maxTensorParallelism?: number;
  kvCacheElasticSharing?: boolean;
  features?: Record<string, unknown>;
}

/** One device's measured (NVML) usage, as sampled at report-build time. */
export interface MeasuredDeviceSample {
  deviceIndex: number;
  memoryMeasuredUsedBytes: number;
}

/** One runner instance's measured (NVML, process-attributed) usage on one device. */
export interface MeasuredInstanceSample {
  instanceId: string;
  modelName: string;
  deviceIndex: number;
  memoryMeasuredUsedBytes: number;
}

export interface MeasuredMemorySample {
  devices: MeasuredDeviceSample[];
  instances: MeasuredInstanceSample[];
}

// Supplies a fresh NVML-derived sample on demand. Returns null when measurement isn't possible
// (no NVML, CPU box) — buildMemoryReport() then omits the measured fields entirely. Owned by
// src/index.ts, which composes the NvmlReader with RunnerManager.getRunnerProcesses().
export type MeasuredMemoryProvider = () => Promise<MeasuredMemorySample | null>;

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

  // Ledger figures (memoryUsedBytes) come from the deviceMemoryUsed array unconditionally — that's
  // the untouched placement-math source of truth. Measured figures (memoryMeasuredUsedBytes,
  // instances) are additive and only appear when measuredProvider resolves to non-null; a failing
  // provider (thrown error, or genuinely no NVML) degrades silently to "no measurement", never to a
  // thrown report build. reportedAt is always set, in every mode, since it's what the control plane
  // uses to judge staleness even for a stub worker with no measurement at all.
  private async buildMemoryReport(): Promise<Record<string, unknown>> {
    const measured = this.measuredProvider ? await this.measuredProvider().catch(() => null) : null;
    const measuredByDevice = new Map(
      measured?.devices.map((d) => [d.deviceIndex, d.memoryMeasuredUsedBytes]) ?? [],
    );

    const devices = this.devices.map((device, i) => {
      const out: Record<string, unknown> = {
        deviceIndex: device.deviceIndex,
        deviceType: device.deviceType,
        memoryUsedBytes: this.deviceMemoryUsed[i],
        memoryTotalBytes: device.memoryTotalBytes,
      };
      const measuredBytes = measuredByDevice.get(device.deviceIndex);
      if (measuredBytes !== undefined) out.memoryMeasuredUsedBytes = measuredBytes;
      return out;
    });

    const report: Record<string, unknown> = { devices, reportedAt: new Date().toISOString() };
    if (measured) report.instances = measured.instances;
    return report;
  }

  private async pushMemoryReport(): Promise<void> {
    await this.redis.set(
      this.key('workers', this.config.workerId, 'memory'),
      JSON.stringify(await this.buildMemoryReport()),
    );
  }
}
