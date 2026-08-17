import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRunnerStub, type RunnerStub } from '../../runner-stub/server.js';
import type {
  ChatCompletionResponse,
  ChatCompletionErrorResponse,
  ModelsListResponse,
  ChatCompletionChunk,
} from '../response-types.js';

describe('Runner Stub - Inference Routes', () => {
  let stub: RunnerStub;
  const port = 19200;
  const baseUrl = `http://localhost:${port}`;
  const modelName = 'test-model-7b';
  const workerId = 'test-worker-0';

  beforeAll(async () => {
    stub = createRunnerStub({
      port,
      modelName,
      workerId,
      runnerType: 'vllm',
      deviceType: 'CUDA',
      requiredMemory: 8 * 1024 * 1024 * 1024,
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

  describe('POST /v1/chat/completions (non-streaming)', () => {
    it('returns valid ChatCompletion shape with id, object, model, choices, usage', async () => {
      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: modelName,
          messages: [{ role: 'user', content: 'Hello' }],
        }),
      });

      expect(response.status).toBe(200);
      const data = (await response.json()) as ChatCompletionResponse;

      expect(data).toHaveProperty('id');
      expect(data.id).toMatch(/^chatcmpl-/);
      expect(data).toHaveProperty('object', 'chat.completion');
      expect(data).toHaveProperty('created');
      expect(typeof data.created).toBe('number');
      expect(data).toHaveProperty('model');
      expect(data).toHaveProperty('choices');
      expect(Array.isArray(data.choices)).toBe(true);
      expect(data.choices).toHaveLength(1);
      expect(data.choices[0]).toHaveProperty('index', 0);
      expect(data.choices[0]).toHaveProperty('message');
      expect(data.choices[0].message).toHaveProperty('role', 'assistant');
      expect(data.choices[0].message).toHaveProperty('content');
      expect(typeof data.choices[0].message.content).toBe('string');
      expect(data.choices[0]).toHaveProperty('finish_reason', 'stop');
      expect(data).toHaveProperty('usage');
      expect(data.usage).toHaveProperty('prompt_tokens');
      expect(data.usage).toHaveProperty('completion_tokens');
      expect(data.usage).toHaveProperty('total_tokens');
      expect(typeof data.usage.prompt_tokens).toBe('number');
      expect(typeof data.usage.completion_tokens).toBe('number');
      expect(typeof data.usage.total_tokens).toBe('number');
    });

    it('includes correct model name in response', async () => {
      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: modelName,
          messages: [{ role: 'user', content: 'Test' }],
        }),
      });

      expect(response.status).toBe(200);
      const data = (await response.json()) as ChatCompletionResponse;

      expect(data.model).toBe(modelName);
      expect(data.choices[0].message.content).toContain(modelName);
      expect(data.choices[0].message.content).toContain(workerId);
    });

    it('returns 503 when runner is in STARTING state (before ready)', async () => {
      // Create a new stub with long startup delay and don't wait for it
      const notReadyStub = createRunnerStub({
        port: 19201,
        modelName: 'not-ready-model',
        workerId: 'test-worker-1',
        runnerType: 'vllm',
        deviceType: 'CUDA',
        requiredMemory: 8 * 1024 * 1024 * 1024,
        devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
        deviceMemoryTotalBytes: 24 * 1024 * 1024 * 1024,
        startupDelayMs: 5000, // Long delay
        sleepDelayMs: 100,
        wakeDelayMs: 100,
        inferenceDelayMs: 50,
      });

      await notReadyStub.start();

      try {
        const response = await fetch('http://localhost:19201/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'not-ready-model',
            messages: [{ role: 'user', content: 'Hello' }],
          }),
        });

        expect(response.status).toBe(503);
        const data = (await response.json()) as ChatCompletionErrorResponse;

        expect(data).toHaveProperty('error');
        expect(data.error).toHaveProperty('message');
        expect(data.error.message).toContain('not ready');
        expect(data.error.message).toContain('STARTING');
        expect(data.error).toHaveProperty('type', 'server_error');
        expect(data.error).toHaveProperty('code', 'model_not_ready');
      } finally {
        await notReadyStub.stop();
      }
    });
  });

  describe('GET /v1/models', () => {
    it('returns list with the model', async () => {
      const response = await fetch(`${baseUrl}/v1/models`);

      expect(response.status).toBe(200);
      const data = (await response.json()) as ModelsListResponse;

      expect(data).toHaveProperty('object', 'list');
      expect(data).toHaveProperty('data');
      expect(Array.isArray(data.data)).toBe(true);
      expect(data.data).toHaveLength(1);
      expect(data.data[0]).toHaveProperty('id', modelName);
      expect(data.data[0]).toHaveProperty('object', 'model');
      expect(data.data[0]).toHaveProperty('created');
      expect(typeof data.data[0].created).toBe('number');
      expect(data.data[0]).toHaveProperty('owned_by', 'sardeenz-dev');
    });
  });

  describe('POST /v1/chat/completions (streaming)', () => {
    it('returns SSE text/event-stream data with [DONE] marker', async () => {
      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: modelName,
          messages: [{ role: 'user', content: 'Hello' }],
          stream: true,
        }),
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('text/event-stream');
      expect(response.headers.get('cache-control')).toBe('no-cache');
      expect(response.headers.get('connection')).toBe('keep-alive');

      const text = await response.text();

      // Check for SSE format
      expect(text).toContain('data: ');
      expect(text).toContain('[DONE]');

      // Parse SSE lines
      const lines = text.split('\n');
      const dataLines = lines.filter((line) => line.startsWith('data: '));

      // Should have multiple data chunks plus [DONE]
      expect(dataLines.length).toBeGreaterThan(1);

      // Check last line is [DONE]
      const lastDataLine = dataLines[dataLines.length - 1];
      expect(lastDataLine).toBe('data: [DONE]');

      // Parse and validate a chunk (not [DONE])
      const firstChunk = dataLines[0];
      expect(firstChunk).toMatch(/^data: \{/);
      const chunkData = JSON.parse(firstChunk.replace('data: ', '')) as ChatCompletionChunk;

      expect(chunkData).toHaveProperty('id');
      expect(chunkData.id).toMatch(/^chatcmpl-/);
      expect(chunkData).toHaveProperty('object', 'chat.completion.chunk');
      expect(chunkData).toHaveProperty('created');
      expect(chunkData).toHaveProperty('model', modelName);
      expect(chunkData).toHaveProperty('choices');
      expect(Array.isArray(chunkData.choices)).toBe(true);
      expect(chunkData.choices[0]).toHaveProperty('index', 0);
      expect(chunkData.choices[0]).toHaveProperty('delta');
      expect(chunkData.choices[0]).toHaveProperty('finish_reason');
    });

    it('includes delta content in streaming chunks', async () => {
      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: modelName,
          messages: [{ role: 'user', content: 'Hello' }],
          stream: true,
        }),
      });

      const text = await response.text();
      const lines = text.split('\n');
      const dataLines = lines
        .filter((line) => line.startsWith('data: '))
        .filter((line) => !line.includes('[DONE]'));

      // Collect all delta content
      let fullContent = '';
      for (const line of dataLines) {
        const chunkData = JSON.parse(line.replace('data: ', '')) as ChatCompletionChunk;
        if (chunkData.choices[0].delta?.content) {
          fullContent += chunkData.choices[0].delta.content;
        }
      }

      // Should have accumulated some content
      expect(fullContent.length).toBeGreaterThan(0);
      // Content should contain simulated tokens
      expect(fullContent).toContain('simulated');
      expect(fullContent).toContain('worker');
      expect(fullContent).toContain('stub');
    });

    it('includes finish chunk with finish_reason stop', async () => {
      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: modelName,
          messages: [{ role: 'user', content: 'Hello' }],
          stream: true,
        }),
      });

      const text = await response.text();
      const lines = text.split('\n');
      const dataLines = lines
        .filter((line) => line.startsWith('data: '))
        .filter((line) => !line.includes('[DONE]'));

      // Find the finish chunk (second to last before [DONE])
      const finishChunk = JSON.parse(
        dataLines[dataLines.length - 1].replace('data: ', ''),
      ) as ChatCompletionChunk;

      expect(finishChunk.choices[0].finish_reason).toBe('stop');
      expect(finishChunk.choices[0].delta).toEqual({});
    });
  });
});
