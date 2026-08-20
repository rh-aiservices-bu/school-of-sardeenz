import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
    runnerPortStart: 19500,
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
    },
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
});
