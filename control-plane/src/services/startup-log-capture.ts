import type { WorkerClient } from '../clients/worker.js';
import type { WorkerPoolService } from './worker-pool.js';
import type { StartupLogLine, StartupLogRepository } from './startup-log-repository.js';

const RETRY_MS = 500;
const retryDelay = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, RETRY_MS);
  });

/** Automatically copies the worker's bounded startup-only SSE stream into PostgreSQL. */
export class StartupLogCaptureService {
  private readonly capturing = new Set<string>();

  constructor(
    private readonly repository: StartupLogRepository,
    private readonly workerPool: WorkerPoolService,
    private readonly createWorkerClient: (baseUrl: string) => WorkerClient,
  ) {}

  async start(instanceId: string, modelName: string, workerId: string): Promise<void> {
    await this.repository.createSession(instanceId, modelName, workerId);
    void this.capture(instanceId, workerId).catch(() => {});
  }

  async markSucceeded(instanceId: string): Promise<void> {
    await this.repository.markOutcome(instanceId, 'SUCCEEDED');
  }

  async markFailed(instanceId: string, message: string): Promise<void> {
    await this.repository.markOutcome(instanceId, 'FAILED', message);
  }

  async resumeIncomplete(): Promise<void> {
    const sessions = await this.repository.listIncomplete();
    for (const session of sessions) {
      void this.capture(session.instanceId, session.workerId).catch(() => {});
    }
  }

  private async capture(instanceId: string, workerId: string): Promise<void> {
    if (this.capturing.has(instanceId)) return;
    this.capturing.add(instanceId);
    try {
      while (true) {
        const worker = this.workerPool.getWorker(workerId);
        if (!worker) {
          await retryDelay();
          continue;
        }
        let response: Response;
        try {
          response = await this.createWorkerClient(worker.managementUrl).streamRunnerLogsByInstance(
            instanceId,
          );
        } catch {
          await retryDelay();
          continue;
        }
        if (response.status === 404) {
          await retryDelay();
          continue;
        }
        if (!response.ok || !response.body) {
          await retryDelay();
          continue;
        }
        // The worker replays its complete retained startup buffer on every connection. Replace a
        // partial prior capture so leader/control-plane recovery cannot duplicate those lines.
        try {
          await this.repository.clearLines(instanceId);
          await this.consume(instanceId, response.body);
          await this.repository.markCaptureComplete(instanceId);
          return;
        } catch {
          await retryDelay();
        }
      }
    } finally {
      this.capturing.delete(instanceId);
    }
  }

  private async consume(instanceId: string, body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? '';
      const lines: Omit<StartupLogLine, 'id'>[] = [];
      for (const frame of frames) {
        const event = frame
          .split(/\r?\n/)
          .find((line) => line.startsWith('event:'))
          ?.slice(6)
          .trim();
        const data = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (event !== 'log' || !data) continue;
        try {
          const parsed = JSON.parse(data) as Omit<StartupLogLine, 'id'>;
          if (
            typeof parsed.ts === 'string' &&
            (parsed.stream === 'stdout' || parsed.stream === 'stderr') &&
            typeof parsed.content === 'string'
          ) {
            lines.push(parsed);
          }
        } catch {
          // Ignore malformed upstream frames; the runner continues streaming subsequent lines.
        }
      }
      if (lines.length > 0) await this.repository.append(instanceId, lines);
      if (done) return;
    }
  }
}
