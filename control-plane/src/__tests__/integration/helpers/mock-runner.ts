import Fastify from 'fastify';
import { RunnerState } from '@sardeenz/types';

export interface MockRunnerServer {
  host: string;
  port: number;
  url: string;
  /**
   * Number of `POST /wake` calls received (#340). The control plane's wake path sends exactly one
   * per executed wake, so two concurrent wake triggers that dedupe to one wake leave this at 1.
   */
  readonly wakeRequests: number;
  setHealthState(state: RunnerState): void;
  setActiveRequests(n: number): void;
  /**
   * Make `POST /wake` hang instead of answering (#340, scenario 2 — control-plane loss mid-wake).
   * The wake worker parks on the socket, which is how a restart strands an in-flight wake; the
   * hang is released by `close()` (the socket is reset and the client's fetch rejects).
   */
  setHangWake(hang: boolean): void;
  close(): Promise<void>;
}

export async function createMockRunner(): Promise<MockRunnerServer> {
  let healthState = RunnerState.STARTING;
  let activeRequests = 0;
  let wakeRequests = 0;
  let hangWake = false;

  // `forceCloseConnections` so `close()` resets a hanging `/wake` socket instead of waiting for a
  // handler that never resolves (#340 scenario 2's abandoned wake).
  const app = Fastify({ logger: false, forceCloseConnections: true });

  app.get('/health', () => ({
    state: healthState,
    activeRequests,
  }));

  app.post('/sleep', () => {
    healthState = RunnerState.SLEEPING;
    return { status: 'ok' };
  });

  app.post('/wake', () => {
    // Counted before the hang check so the counter is accurate while the call is stuck.
    wakeRequests += 1;
    if (hangWake) return new Promise(() => {});
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
    get wakeRequests() {
      return wakeRequests;
    },
    setHealthState(state: RunnerState) {
      healthState = state;
    },
    setActiveRequests(n: number) {
      activeRequests = n;
    },
    setHangWake(hang: boolean) {
      hangWake = hang;
    },
    close: () => app.close(),
  };
}
