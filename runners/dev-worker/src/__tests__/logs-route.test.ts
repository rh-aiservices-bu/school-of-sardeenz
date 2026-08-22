import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify from 'fastify';
import { RunnerManager } from '../runner-manager.js';
import { registerLogRoutes } from '../routes/logs.js';
import type { WorkerRegistration } from '../registration.js';
import type { DevWorkerConfig } from '../config.js';
import type { LaunchHandle, LaunchSpec, RunnerLauncher } from '../launcher.js';

function makeConfig(): DevWorkerConfig {
  return {
    redisUrl: 'redis://localhost:6379',
    redisKeyPrefix: 'sardeenz',
    workerId: 'logs-route-worker',
    workerPort: 0,
    advertiseHost: 'localhost',
    runnerPortStart: 19500,
    maxRunners: 32,
    deviceCount: 2,
    deviceType: 'CUDA',
    deviceMemoryBytes: 24 * 1024 * 1024 * 1024,
    runnerType: 'vllm',
    startupDelayMs: 100,
    sleepDelayMs: 50,
    wakeDelayMs: 100,
    inferenceDelayMs: 50,
    heartbeatIntervalMs: 60000,
    mode: 'stub',
    apptainer: {
      apptainerBin: 'apptainer',
      modulesDir: '/modules',
      weightsDir: '/weights',
      scratchDir: '/scratch',
      binds: ['/weights', '/scratch'],
      runnerEntrypoint: ['python3', '-m', 'sardeenz_vllm_runner'],
      home: '/scratch/home',
      verifySif: true,
      healthTimeoutMs: 300000,
      healthIntervalMs: 1000,
      stopGraceMs: 15000,
      advertiseHost: 'localhost',
    },
    workerToken: '',
  };
}

function makeRegistration(): WorkerRegistration {
  return {
    allocateMemory: () => {},
    freeMemory: () => {},
    getDeviceMemoryUsed: () => 0,
    register: async () => {},
    deregister: async () => {},
    startHeartbeat: () => {},
    stopHeartbeat: () => {},
  } as unknown as WorkerRegistration;
}

// A launcher that resolves instantly without starting any real process or stub server — the
// route only needs a RunnerManager with a live runner record, not a working runtime.
const instantLauncher: RunnerLauncher = {
  serializeColdStarts: false,
  start: (spec: LaunchSpec): Promise<LaunchHandle> =>
    Promise.resolve({
      host: 'localhost',
      port: spec.port,
      enginePort: spec.enginePort,
      stop: () => Promise.resolve(),
    }),
};

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
  predicate: (received: string) => boolean,
  timeoutMs = 5000,
): Promise<string> {
  let received = '';
  const deadline = Date.now() + timeoutMs;
  while (!predicate(received)) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for stream content. Received so far:\n${received}`);
    }
    const { value, done } = await reader.read();
    if (done) break;
    received += decoder.decode(value, { stream: true });
  }
  return received;
}

describe('GET /runners/:runnerId/logs', () => {
  const config = makeConfig();
  const manager = new RunnerManager(config, makeRegistration(), instantLauncher);
  const server = Fastify({ logger: false });
  let baseUrl: string;

  beforeAll(async () => {
    registerLogRoutes(server, manager);
    baseUrl = await server.listen({ port: 0, host: '127.0.0.1' });
  });

  afterAll(async () => {
    await manager.stopAll();
    await server.close();
  });

  it('returns 404 for an unknown runner', async () => {
    const res = await fetch(`${baseUrl}/runners/nonexistent/logs`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe('NOT_FOUND');
  });

  it('replays buffered lines then streams live-appended lines', async () => {
    const { runnerId } = await manager.startRunner({
      modelName: 'logs-model',
      runnerType: 'vllm',
      modelPath: '/models/logs',
      requiredMemory: 1024 * 1024 * 1024,
      tensorParallel: 1,
      devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
    });

    const logBuffer = manager.getLogBuffer();
    logBuffer.append(runnerId, 'stdout', 'buffered line one\n');
    logBuffer.append(runnerId, 'stderr', 'buffered line two\n');

    const res = await fetch(`${baseUrl}/runners/${runnerId}/logs`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    let received = await readUntil(reader, decoder, (r) => r.includes('buffered line two'));
    expect(received).toContain('event: log');
    expect(received).toContain('buffered line one');
    expect(received).toContain('buffered line two');

    logBuffer.append(runnerId, 'stdout', 'live line\n');
    received = await readUntil(reader, decoder, (r) => r.includes('live line'));
    expect(received).toContain('live line');

    await reader.cancel();
    await manager.stopRunner(runnerId);
  });

  it('replays sealed startup logs then ends immediately when reopened after startup', async () => {
    // Simulates the "View starting logs" reopen: the runner finished starting (stream sealed via
    // markEnded), the buffer retains the startup logs, and a fresh connection should replay them
    // then get an end frame right away rather than hanging for live lines that never come.
    const { runnerId } = await manager.startRunner({
      modelName: 'logs-model-sealed',
      runnerType: 'vllm',
      modelPath: '/models/logs-sealed',
      requiredMemory: 1024 * 1024 * 1024,
      tensorParallel: 1,
      devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
    });

    const logBuffer = manager.getLogBuffer();
    logBuffer.append(runnerId, 'stdout', 'startup line\n');
    logBuffer.append(runnerId, 'stdout', 'Application startup complete.\n');
    logBuffer.markEnded(runnerId); // startup complete — stream sealed, buffer kept

    const res = await fetch(`${baseUrl}/runners/${runnerId}/logs`);
    expect(res.status).toBe(200);

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const received = await readUntil(reader, decoder, (r) => r.includes('event: end'));
    expect(received).toContain('startup line');
    expect(received).toContain('Application startup complete.');
    expect(received).toContain('event: end');

    await reader.cancel();
    await manager.stopRunner(runnerId);
  });

  it('sends an end frame when the runner stops', async () => {
    const { runnerId } = await manager.startRunner({
      modelName: 'logs-model-end',
      runnerType: 'vllm',
      modelPath: '/models/logs-end',
      requiredMemory: 1024 * 1024 * 1024,
      tensorParallel: 1,
      devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
    });

    const res = await fetch(`${baseUrl}/runners/${runnerId}/logs`);
    expect(res.status).toBe(200);

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    await manager.stopRunner(runnerId);

    const received = await readUntil(reader, decoder, (r) => r.includes('event: end'));
    expect(received).toContain('event: end');

    await reader.cancel();
  });

  it('sends an end frame to a client attached during a failing launch', async () => {
    let rejectLaunch!: (err: Error) => void;
    const deferredLauncher: RunnerLauncher = {
      serializeColdStarts: false,
      start: () =>
        new Promise((_resolve, reject) => {
          rejectLaunch = reject;
        }),
    };
    const failConfig = makeConfig();
    const failManager = new RunnerManager(failConfig, makeRegistration(), deferredLauncher);
    const failServer = Fastify({ logger: false });
    registerLogRoutes(failServer, failManager);
    const failBaseUrl = await failServer.listen({ port: 0, host: '127.0.0.1' });

    try {
      const startPromise = failManager.startRunner({
        modelName: 'failing-launch-model',
        runnerType: 'vllm',
        modelPath: '/models/failing-launch',
        requiredMemory: 1024 * 1024 * 1024,
        tensorParallel: 1,
        devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
      });
      // Attached mid-launch, before the rejection below — this is the "cold-starting runner"
      // route, resolvable since modelToRunner is set the instant startRunner() is entered.
      const res = await fetch(`${failBaseUrl}/runners/by-model/failing-launch-model/logs`);
      expect(res.status).toBe(200);

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();

      rejectLaunch(new Error('deferred launch boom'));
      await expect(startPromise).rejects.toThrow('deferred launch boom');

      const received = await readUntil(reader, decoder, (r) => r.includes('event: end'));
      expect(received).toContain('event: end');

      await reader.cancel();
    } finally {
      await failServer.close();
    }
  });

  it('keeps failure logs retrievable by runnerId after the launch fails', async () => {
    const failingLauncher: RunnerLauncher = {
      serializeColdStarts: false,
      start: (_spec, onLog) => {
        onLog?.('stdout', 'loading weights...\n');
        return Promise.reject(new Error('launch boom'));
      },
    };
    const failConfig = makeConfig();
    const failManager = new RunnerManager(failConfig, makeRegistration(), failingLauncher);
    const logBuffer = failManager.getLogBuffer();
    const markEndedSpy = vi.spyOn(logBuffer, 'markEnded');
    const failServer = Fastify({ logger: false });
    registerLogRoutes(failServer, failManager);
    const failBaseUrl = await failServer.listen({ port: 0, host: '127.0.0.1' });

    try {
      await expect(
        failManager.startRunner({
          modelName: 'failure-logs-model',
          runnerType: 'vllm',
          modelPath: '/models/failure-logs',
          requiredMemory: 1024 * 1024 * 1024,
          tensorParallel: 1,
          devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
        }),
      ).rejects.toThrow('launch boom');

      // The model slot was rolled back on failure, so the runnerId can only be recovered from the
      // markEnded call the manager makes before rethrowing — mirroring what a real caller (the
      // control plane, which learns the runnerId when the start command is issued) would already
      // have on hand.
      expect(markEndedSpy).toHaveBeenCalledTimes(1);
      const runnerId = markEndedSpy.mock.calls[0][0];

      const res = await fetch(`${failBaseUrl}/runners/${runnerId}/logs`);
      expect(res.status).toBe(200);

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      const received = await readUntil(reader, decoder, (r) => r.includes('event: end'));
      expect(received).toContain('loading weights...');
      expect(received).toContain('event: end');

      await reader.cancel();
    } finally {
      await failServer.close();
    }
  });
});
