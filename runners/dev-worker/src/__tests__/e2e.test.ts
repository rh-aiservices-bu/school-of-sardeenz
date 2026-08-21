import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import { RunnerManager } from '../runner-manager.js';
import { registerRunnerRoutes } from '../routes/runners.js';
import type { WorkerRegistration } from '../registration.js';
import type { DevWorkerConfig } from '../config.js';

function makeConfig(): DevWorkerConfig {
  return {
    redisUrl: 'redis://localhost:6379',
    redisKeyPrefix: 'sardeenz',
    workerId: 'e2e-worker',
    workerPort: 0,
    advertiseHost: 'localhost',
    runnerPortStart: 19400,
    maxRunners: 32,
    deviceCount: 2,
    deviceType: 'CUDA',
    deviceMemoryBytes: 24 * 1024 * 1024 * 1024,
    runnerType: 'vllm',
    startupDelayMs: 200,
    sleepDelayMs: 50,
    wakeDelayMs: 200,
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

describe('Dev Worker E2E', () => {
  const config = makeConfig();
  const manager = new RunnerManager(config, makeRegistration());
  const server = Fastify({ logger: false });
  let baseUrl: string;

  beforeAll(async () => {
    registerRunnerRoutes(server, manager);
    server.get('/healthz', () => ({ status: 'ok' }));
    const address = await server.listen({ port: 0, host: '127.0.0.1' });
    baseUrl = address;
  });

  afterAll(async () => {
    await manager.stopAll();
    await server.close();
  });

  it('full lifecycle: create runner → inference → sleep → wake → stop', async () => {
    // 1. Create a runner via the worker agent API
    const createRes = await fetch(`${baseUrl}/runners`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        modelName: 'e2e-model',
        runnerType: 'vllm',
        modelPath: '/models/e2e',
        requiredMemory: 4 * 1024 * 1024 * 1024,
        tensorParallel: 1,
        devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
      }),
    });

    expect(createRes.status).toBe(201);
    const { runnerId, host, port } = (await createRes.json()) as {
      runnerId: string;
      host: string;
      port: number;
    };
    expect(runnerId).toMatch(/^runner-/);
    const runnerUrl = `http://${host}:${port}`;

    // 2. Wait for runner startup to complete
    await waitForState(runnerUrl, 'READY', 5000);

    // 3. Check health
    const healthRes = await fetch(`${runnerUrl}/health`);
    expect(healthRes.status).toBe(200);
    const health = (await healthRes.json()) as { state: string };
    expect(health.state).toBe('READY');

    // 4. Run non-streaming inference
    const inferRes = await fetch(`${runnerUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'e2e-model',
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    });
    expect(inferRes.status).toBe(200);
    const completion = (await inferRes.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    expect(completion.choices[0].message.content).toBeTruthy();

    // 5. Check memory report
    const memRes = await fetch(`${runnerUrl}/memory-report`);
    expect(memRes.status).toBe(200);
    const mem = (await memRes.json()) as {
      devices: Array<{ memoryUsedBytes: number }>;
    };
    expect(mem.devices.length).toBeGreaterThan(0);

    // 6. Sleep the runner
    const sleepRes = await fetch(`${runnerUrl}/sleep`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level: 'L1_HOST_RAM' }),
    });
    expect(sleepRes.status).toBe(200);
    const sleepData = (await sleepRes.json()) as { state: string };
    expect(sleepData.state).toBe('SLEEPING');

    // 7. Verify sleep status
    const sleepStatusRes = await fetch(`${runnerUrl}/sleep-status`);
    const sleepStatus = (await sleepStatusRes.json()) as {
      isSleeping: boolean;
      level: string;
    };
    expect(sleepStatus.isSleeping).toBe(true);
    expect(sleepStatus.level).toBe('L1_HOST_RAM');

    // 8. Wake the runner
    const wakeRes = await fetch(`${runnerUrl}/wake`, { method: 'POST' });
    expect(wakeRes.status).toBe(200);

    // 9. Wait for it to be READY again
    await waitForState(runnerUrl, 'READY', 5000);

    // 10. Run streaming inference
    const streamRes = await fetch(`${runnerUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'e2e-model',
        messages: [{ role: 'user', content: 'Stream test' }],
        stream: true,
      }),
    });
    expect(streamRes.status).toBe(200);
    const streamBody = await streamRes.text();
    expect(streamBody).toContain('data: ');
    expect(streamBody).toContain('[DONE]');

    // 11. Stop the runner via worker agent API
    const stopRes = await fetch(`${baseUrl}/runners/${runnerId}`, {
      method: 'DELETE',
    });
    expect(stopRes.status).toBe(204);

    // 12. Verify runner is gone
    expect(manager.getRunner(runnerId)).toBeUndefined();
  }, 15000);

  it('returns 409 for duplicate model', async () => {
    const body = JSON.stringify({
      modelName: 'dup-model',
      runnerType: 'vllm',
      modelPath: '/models/dup',
      requiredMemory: 1024 * 1024 * 1024,
      tensorParallel: 1,
      devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
    });

    const r1 = await fetch(`${baseUrl}/runners`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    expect(r1.status).toBe(201);
    const { runnerId } = (await r1.json()) as { runnerId: string };

    const r2 = await fetch(`${baseUrl}/runners`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    expect(r2.status).toBe(409);

    await fetch(`${baseUrl}/runners/${runnerId}`, { method: 'DELETE' });
  });

  it('returns 404 for unknown runner delete', async () => {
    const res = await fetch(`${baseUrl}/runners/nonexistent`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(404);
  });
});

async function waitForState(runnerUrl: string, target: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${runnerUrl}/health`);
    if (res.ok) {
      const data = (await res.json()) as { state: string };
      if (data.state === target) return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Runner did not reach ${target} within ${timeoutMs}ms`);
}
