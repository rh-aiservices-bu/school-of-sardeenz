import Fastify from 'fastify';
import type { MockRunnerServer } from './mock-runner.js';

export interface MockWorkerServer {
  url: string;
  close(): Promise<void>;
}

export async function createMockWorker(runner: MockRunnerServer): Promise<MockWorkerServer> {
  let nextId = 1;

  const app = Fastify({ logger: false });

  app.post('/runners', () => ({
    runnerId: `runner-${nextId++}`,
    host: runner.host,
    port: runner.port,
  }));

  app.delete<{ Params: { runnerId: string } }>('/runners/:runnerId', async (_req, reply) => {
    await reply.status(204).send();
  });

  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    close: () => app.close(),
  };
}
