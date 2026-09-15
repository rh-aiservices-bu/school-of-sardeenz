import Fastify from 'fastify';
import { RunnerState } from '@sardeenz/types';

export interface MockRunnerServer {
  host: string;
  port: number;
  url: string;
  setHealthState(state: RunnerState): void;
  setActiveRequests(n: number): void;
  close(): Promise<void>;
}

export async function createMockRunner(): Promise<MockRunnerServer> {
  let healthState = RunnerState.STARTING;
  let activeRequests = 0;

  const app = Fastify({ logger: false });

  app.get('/health', () => ({
    state: healthState,
    activeRequests,
  }));

  app.post('/sleep', () => {
    healthState = RunnerState.SLEEPING;
    return { status: 'ok' };
  });

  app.post('/wake', () => {
    healthState = RunnerState.STARTING;
    return { status: 'ok' };
  });

  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    host: '127.0.0.1',
    port,
    url: `http://127.0.0.1:${port}`,
    setHealthState(state: RunnerState) {
      healthState = state;
    },
    setActiveRequests(n: number) {
      activeRequests = n;
    },
    close: () => app.close(),
  };
}
