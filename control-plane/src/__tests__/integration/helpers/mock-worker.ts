import Fastify from 'fastify';
import type { WorkerAgentComponents } from '@sardeenz/types';
import type { MockRunnerServer } from './mock-runner.js';

type RunnerSummary = WorkerAgentComponents['schemas']['RunnerSummary'];

export interface MockWorkerServer {
  url: string;
  /** Bodies of every POST /runners (start-runner) call, in order — for asserting forwarded fields. */
  startRequests: Array<Record<string, unknown>>;
  /** runnerId path params of every DELETE /runners/:runnerId (stop-runner) call, in order (#157). */
  stopRequests: string[];
  /**
   * The registry `GET /runners` answers with (#286). Set it with `setListedRunners` to model a
   * worker that hosts runners the control plane is (or is not) aware of.
   */
  setListedRunners(runners: RunnerSummary[]): void;
  close(): Promise<void>;
}

/**
 * Backs a mock worker with either a single fixed runner (every start returns the same
 * host:port — the pre-#120 behavior, still correct for a worker that only ever hosts one
 * runner in a given test) or an ordered list of runners (each `POST /runners` call gets the
 * next one in sequence — needed to model #120's same-worker replica case, where a single
 * worker returns two *distinct* runner endpoints so their routing entries don't collide).
 */
export async function createMockWorker(
  runner: MockRunnerServer | MockRunnerServer[],
): Promise<MockWorkerServer> {
  let nextId = 1;
  let nextRunnerIndex = 0;
  const runners = Array.isArray(runner) ? runner : [runner];
  const startRequests: Array<Record<string, unknown>> = [];
  const stopRequests: string[] = [];

  const app = Fastify({ logger: false });

  app.post('/runners', (req) => {
    startRequests.push((req.body ?? {}) as Record<string, unknown>);
    // Cycle through the provided runners in call order; once past the end, the last runner is
    // reused rather than throwing — most tests only ever start one or two instances per worker.
    const target = runners[Math.min(nextRunnerIndex, runners.length - 1)];
    nextRunnerIndex++;
    return {
      runnerId: `runner-${nextId++}`,
      host: target.host,
      port: target.port,
    };
  });

  app.delete<{ Params: { runnerId: string } }>('/runners/:runnerId', async (req, reply) => {
    stopRequests.push(req.params.runnerId);
    await reply.status(204).send();
  });

  // Registry enumeration (#286): the control plane's reverse sweep lists this to find runners it
  // has no instance record for. Empty unless a test populates it.
  let listedRunners: RunnerSummary[] = [];
  app.get('/runners', () => ({ runners: listedRunners }));

  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    startRequests,
    stopRequests,
    setListedRunners: (runners: RunnerSummary[]) => {
      listedRunners = runners;
    },
    close: () => app.close(),
  };
}
