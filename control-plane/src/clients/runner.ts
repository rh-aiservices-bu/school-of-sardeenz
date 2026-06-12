import type { components as RunnerComponents } from '@sardeenz/types';

type HealthStatus = RunnerComponents['schemas']['HealthStatus'];
type MemoryReport = RunnerComponents['schemas']['MemoryReport'];
type SleepResponse = RunnerComponents['schemas']['SleepResponse'];
type WakeResponse = RunnerComponents['schemas']['WakeResponse'];
type SleepStatus = RunnerComponents['schemas']['SleepStatus'];
type LoadingProgress = RunnerComponents['schemas']['LoadingProgress'];
type RunnerCapabilities = RunnerComponents['schemas']['RunnerCapabilities'];

export interface RunnerClientOptions {
  host: string;
  port: number;
  timeoutMs?: number;
}

export class RunnerClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: RunnerClientOptions) {
    this.baseUrl = `http://${options.host}:${options.port}`;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async getHealth(): Promise<HealthStatus> {
    return this.get<HealthStatus>('/health');
  }

  async getMemoryReport(): Promise<MemoryReport> {
    return this.get<MemoryReport>('/memory-report');
  }

  async sleep(level: string): Promise<SleepResponse> {
    return this.post<SleepResponse>('/sleep', { level });
  }

  async wake(): Promise<WakeResponse> {
    return this.post<WakeResponse>('/wake');
  }

  async getSleepStatus(): Promise<SleepStatus> {
    return this.get<SleepStatus>('/sleep-status');
  }

  async getProgress(): Promise<LoadingProgress> {
    return this.get<LoadingProgress>('/progress');
  }

  async getCapabilities(): Promise<RunnerCapabilities> {
    return this.get<RunnerCapabilities>('/capabilities');
  }

  private async get<T>(path: string): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Runner ${path} returned ${response.status}: ${body}`);
    }
    return response.json() as Promise<T>;
  }

  private async post<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Runner ${path} returned ${response.status}: ${text}`);
    }
    return response.json() as Promise<T>;
  }
}
