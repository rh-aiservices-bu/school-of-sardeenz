import type { Redis } from 'ioredis';
import type { DevWorkerConfig } from './config.js';

export class WorkerRegistration {
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private readonly deviceMemoryUsed: number[];

  constructor(
    private readonly redis: Redis,
    private readonly config: DevWorkerConfig,
  ) {
    this.deviceMemoryUsed = new Array<number>(config.deviceCount).fill(0);
  }

  private key(...parts: string[]): string {
    return [this.config.redisKeyPrefix, ...parts].join(':');
  }

  async register(): Promise<void> {
    const info = {
      capabilities: [
        {
          runnerType: this.config.runnerType,
          engineName: `Dev Stub (${this.config.runnerType})`,
          supportedModelTypes: ['LLM'],
          supportedDeviceTypes: [this.config.deviceType],
          supportedSleepLevels: ['L1_HOST_RAM'],
        },
      ],
      devices: Array.from({ length: this.config.deviceCount }, (_, i) => ({
        deviceIndex: i,
        deviceType: this.config.deviceType,
        memoryTotalBytes: this.config.deviceMemoryBytes,
      })),
      managementUrl: `http://localhost:${this.config.workerPort}`,
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
    this.heartbeatTimer = setInterval(() => {
      void this.redis.set(
        this.key('workers', this.config.workerId, 'heartbeat'),
        new Date().toISOString(),
      );
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
      devices: Array.from({ length: this.config.deviceCount }, (_, i) => ({
        deviceIndex: i,
        deviceType: this.config.deviceType,
        memoryUsedBytes: this.deviceMemoryUsed[i],
        memoryTotalBytes: this.config.deviceMemoryBytes,
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
