import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { WorkerClient } from '../worker.js';

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

describe('WorkerClient', () => {
  describe('startRunner', () => {
    it('sends POST /runners with the request body', async () => {
      const response = { runnerId: 'r-1', host: '10.0.0.1', port: 5001 };
      mockFetch.mockResolvedValue(jsonResponse(response));

      const client = new WorkerClient({ baseUrl: 'http://worker-1:8080' });
      const result = await client.startRunner({
        modelName: 'llama-3',
        runnerType: 'vllm',
        modelPath: '/models/llama',
        requiredMemory: 14_000_000_000,
        tensorParallel: 1,
        devices: [{ deviceIndex: 0, deviceType: 'CUDA' }],
      });

      expect(result).toEqual(response);
      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://worker-1:8080/runners');
      expect((opts as Record<string, unknown>).method).toBe('POST');
      expect(JSON.parse((opts as Record<string, unknown>).body as string)).toMatchObject({ modelName: 'llama-3', runnerType: 'vllm' });
    });

    it('strips trailing slashes from baseUrl', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ runnerId: 'r-1', host: 'h', port: 1 }));

      const client = new WorkerClient({ baseUrl: 'http://worker-1:8080///' });
      await client.startRunner({
        modelName: 'm',
        runnerType: 'vllm',
        modelPath: '/p',
        requiredMemory: 1,
        tensorParallel: 1,
        devices: [],
      });

      const [url] = mockFetch.mock.calls[0] as [string];
      expect(url).toBe('http://worker-1:8080/runners');
    });

    it('throws on non-OK response', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ error: 'no capacity' }, 503));

      const client = new WorkerClient({ baseUrl: 'http://worker-1:8080' });
      await expect(
        client.startRunner({
          modelName: 'm',
          runnerType: 'vllm',
          modelPath: '/p',
          requiredMemory: 1,
          tensorParallel: 1,
          devices: [],
        }),
      ).rejects.toThrow('returned 503');
    });
  });

  describe('stopRunner', () => {
    it('sends DELETE /runners/{runnerId}', async () => {
      mockFetch.mockResolvedValue(jsonResponse({}, 204));

      const client = new WorkerClient({ baseUrl: 'http://worker-1:8080' });
      await client.stopRunner('runner-abc');

      const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://worker-1:8080/runners/runner-abc');
      expect((opts as Record<string, unknown>).method).toBe('DELETE');
    });

    it('throws on non-OK response', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ error: 'not found' }, 404));

      const client = new WorkerClient({ baseUrl: 'http://worker-1:8080' });
      await expect(client.stopRunner('runner-xyz')).rejects.toThrow('returned 404');
    });
  });
});
