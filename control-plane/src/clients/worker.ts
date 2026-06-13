export interface StartRunnerRequest {
  modelName: string;
  runnerType: string;
  modelPath: string;
  requiredMemory: number;
  deviceType?: string;
  tensorParallel: number;
  engineConfig?: Record<string, unknown>;
  devices: { deviceIndex: number; deviceType: string }[];
}

export interface StartRunnerResponse {
  runnerId: string;
  host: string;
  port: number;
}

export interface WorkerClientOptions {
  baseUrl: string;
  timeoutMs?: number;
}

export class WorkerClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: WorkerClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  async startRunner(request: StartRunnerRequest): Promise<StartRunnerResponse> {
    return this.post<StartRunnerResponse>('/runners', request);
  }

  async stopRunner(runnerId: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/runners/${encodeURIComponent(runnerId)}`, {
      method: 'DELETE',
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Worker DELETE /runners/${runnerId} returned ${response.status}: ${body}`);
    }
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Worker ${path} returned ${response.status}: ${text}`);
    }
    return response.json() as Promise<T>;
  }
}
