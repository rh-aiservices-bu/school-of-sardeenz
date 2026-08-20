import Fastify from 'fastify';
import type { MockRunnerServer } from './mock-runner.js';

export interface MockWorkerServer {
  url: string;
  /** Bodies of every POST /runners (start-runner) call, in order — for asserting forwarded fields. */
  startRequests: Array<Record<string, unknown>>;
  close(): Promise<void>;
}

export async function createMockWorker(runner: MockRunnerServer): Promise<MockWorkerServer> {
  let nextId = 1;
  const startRequests: Array<Record<string, unknown>> = [];

  const app = Fastify({ logger: false });

  app.post('/runners', (req) => {
    startRequests.push((req.body ?? {}) as Record<string, unknown>);
    return {
      runnerId: `runner-${nextId++}`,
      host: runner.host,
      port: runner.port,
    };
  });

  app.delete<{ Params: { runnerId: string } }>('/runners/:runnerId', async (_req, reply) => {
    await reply.status(204).send();
  });

  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    startRequests,
    close: () => app.close(),
  };
}
