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

export class WorkerRegistration {
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private readonly deviceMemoryUsed: number[];
  private readonly devices: DetectedDevice[];

  constructor(
    private readonly redis: Redis,
    private readonly config: DevWorkerConfig,
    // The advertised fleet. Defaults to the configured (simulated) fleet when not supplied — real
    // deployments pass GPUs resolved via resolveDevices() (nvidia-smi in apptainer mode).
    devices?: DetectedDevice[],
    private readonly fetchFn: typeof fetch = globalThis.fetch,
    private readonly catalogCapabilities?: CatalogCapabilityOverrides,
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
      JSON.stringify(this.buildMemoryReport()),
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

  private buildMemoryReport(): { devices: Array<Record<string, unknown>> } {
    return {
      devices: this.devices.map((device, i) => ({
        deviceIndex: device.deviceIndex,
        deviceType: device.deviceType,
        memoryUsedBytes: this.deviceMemoryUsed[i],
        memoryTotalBytes: device.memoryTotalBytes,
      })),
    };
  }

  private async pushMemoryReport(): Promise<void> {
    await this.redis.set(
      this.key('workers', this.config.workerId, 'memory'),
      JSON.stringify(this.buildMemoryReport()),
    );
  }
}
