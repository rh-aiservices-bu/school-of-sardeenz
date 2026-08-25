import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRunnerStub, isOipRunnerType, type RunnerStub } from '../../runner-stub/server.js';
import type {
  V2InferResponse,
  V2ErrorResponse,
  V2ReadyResponse,
} from '../response-types.js';

describe('isOipRunnerType', () => {
  it('selects mlserver as the only oip runner type', () => {
    expect(isOipRunnerType('mlserver')).toBe(true);
    expect(isOipRunnerType('vllm')).toBe(false);
  });
});

describe('Runner Stub - V2 (KServe Open Inference Protocol) Routes', () => {
  let stub: RunnerStub;
  const port = 19210;
  const baseUrl = `http://localhost:${port}`;
  const modelName = 'iris';
  const workerId = 'test-worker-0';

  beforeAll(async () => {
    stub = createRunnerStub({
      port,
      modelName,
      workerId,
      runnerType: 'mlserver',
      deviceType: 'CUDA',
      requiredMemory: 1 * 1024 * 1024 * 1024,
      devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
      deviceMemoryTotalBytes: 24 * 1024 * 1024 * 1024,
      startupDelayMs: 200,
      sleepDelayMs: 100,
      wakeDelayMs: 100,
      inferenceDelayMs: 50,
    });

    await stub.start();
    // Wait for runner to become READY (startupDelayMs + buffer)
    await new Promise((resolve) => setTimeout(resolve, 250));
  });

  afterAll(async () => {
    await stub.stop();
  });

  describe('POST /v2/models/:model/infer', () => {
    it('returns a KServe V2 InferenceResponse shape when READY', async () => {
      const response = await fetch(`${baseUrl}/v2/models/${modelName}/infer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inputs: [] }),
      });

      expect(response.status).toBe(200);
      const data = (await response.json()) as V2InferResponse;

      expect(data).toHaveProperty('model_name', modelName);
      expect(data).toHaveProperty('model_version', 'v1');
      expect(Array.isArray(data.outputs)).toBe(true);
      expect(data.outputs).toHaveLength(1);
      expect(data.outputs[0]).toHaveProperty('name', 'predict');
      expect(data.outputs[0]).toHaveProperty('datatype', 'FP32');
      expect(data.outputs[0]).toHaveProperty('shape');
      expect(data.outputs[0]).toHaveProperty('data');
    });

    it('returns 503 when runner is in STARTING state (before ready)', async () => {
      const notReadyStub = createRunnerStub({
        port: 19211,
        modelName: 'not-ready-model',
        workerId: 'test-worker-1',
        runnerType: 'mlserver',
        deviceType: 'CUDA',
        requiredMemory: 1 * 1024 * 1024 * 1024,
        devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
        deviceMemoryTotalBytes: 24 * 1024 * 1024 * 1024,
        startupDelayMs: 5000, // Long delay
        sleepDelayMs: 100,
        wakeDelayMs: 100,
        inferenceDelayMs: 50,
      });

      await notReadyStub.start();

      try {
        const response = await fetch('http://localhost:19211/v2/models/not-ready-model/infer', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ inputs: [] }),
        });

        expect(response.status).toBe(503);
        const data = (await response.json()) as V2ErrorResponse;
        expect(data).toHaveProperty('error');
        expect(data.error).toContain('not ready');
        expect(data.error).toContain('STARTING');
      } finally {
        await notReadyStub.stop();
      }
    });
  });

  describe('GET /v2/models/:model/ready', () => {
    it('returns ready: true when READY', async () => {
      const response = await fetch(`${baseUrl}/v2/models/${modelName}/ready`);

      expect(response.status).toBe(200);
      const data = (await response.json()) as V2ReadyResponse;
      expect(data).toHaveProperty('name', modelName);
      expect(data).toHaveProperty('ready', true);
    });

    it('returns 503 with ready: false when not READY', async () => {
      const notReadyStub = createRunnerStub({
        port: 19212,
        modelName: 'not-ready-model-2',
        workerId: 'test-worker-2',
        runnerType: 'mlserver',
        deviceType: 'CUDA',
        requiredMemory: 1 * 1024 * 1024 * 1024,
        devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
        deviceMemoryTotalBytes: 24 * 1024 * 1024 * 1024,
        startupDelayMs: 5000,
        sleepDelayMs: 100,
        wakeDelayMs: 100,
        inferenceDelayMs: 50,
      });

      await notReadyStub.start();

      try {
        const response = await fetch('http://localhost:19212/v2/models/not-ready-model-2/ready');
        expect(response.status).toBe(503);
        const data = (await response.json()) as V2ReadyResponse;
        expect(data).toHaveProperty('name', 'not-ready-model-2');
        expect(data).toHaveProperty('ready', false);
      } finally {
        await notReadyStub.stop();
      }
    });
  });

  describe('runnerType selects the surface (regression)', () => {
    it('a vllm stub exposes /v1/chat/completions and not the V2 infer route', async () => {
      const vllmStub = createRunnerStub({
        port: 19213,
        modelName: 'vllm-model',
        workerId: 'test-worker-3',
        runnerType: 'vllm',
        deviceType: 'CUDA',
        requiredMemory: 1 * 1024 * 1024 * 1024,
        devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
        deviceMemoryTotalBytes: 24 * 1024 * 1024 * 1024,
        startupDelayMs: 200,
        sleepDelayMs: 100,
        wakeDelayMs: 100,
        inferenceDelayMs: 50,
      });

      await vllmStub.start();
      await new Promise((resolve) => setTimeout(resolve, 250));

      try {
        const chatResponse = await fetch('http://localhost:19213/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'vllm-model', messages: [{ role: 'user', content: 'hi' }] }),
        });
        expect(chatResponse.status).toBe(200);

        const v2Response = await fetch('http://localhost:19213/v2/models/vllm-model/infer', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ inputs: [] }),
        });
        expect(v2Response.status).toBe(404);
      } finally {
        await vllmStub.stop();
      }
    });
  });
});
