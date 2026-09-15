import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { RunnerClient } from '../runner.js';

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

describe('RunnerClient', () => {
  describe('sleep', () => {
    it('uses instance default timeout when no timeoutMs is provided', async () => {
      const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
      mockFetch.mockResolvedValue(jsonResponse({ status: 'SLEEPING' }));

      const client = new RunnerClient({ host: 'runner-1', port: 8000 });
      await client.sleep('L1_HOST_RAM');

      expect(timeoutSpy).toHaveBeenCalledWith(30_000);
    });

    it('uses per-call timeoutMs when provided', async () => {
      const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
      mockFetch.mockResolvedValue(jsonResponse({ status: 'SLEEPING' }));

      const client = new RunnerClient({ host: 'runner-1', port: 8000 });
      await client.sleep('L1_HOST_RAM', 120_000);

      expect(timeoutSpy).toHaveBeenCalledWith(120_000);
    });

    it('throws on non-OK response', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ error: 'busy' }, 503));

      const client = new RunnerClient({ host: 'runner-1', port: 8000 });
      await expect(client.sleep('L1_HOST_RAM')).rejects.toThrow('returned 503');
    });
  });

  describe('wake', () => {
    it('always uses the instance default timeout', async () => {
      const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
      mockFetch.mockResolvedValue(jsonResponse({ status: 'STARTING' }));

      const client = new RunnerClient({ host: 'runner-1', port: 8000, timeoutMs: 45_000 });
      await client.wake();

      expect(timeoutSpy).toHaveBeenCalledWith(45_000);
    });

    it('throws on non-OK response', async () => {
      mockFetch.mockResolvedValue(jsonResponse({ error: 'not sleeping' }, 409));

      const client = new RunnerClient({ host: 'runner-1', port: 8000 });
      await expect(client.wake()).rejects.toThrow('returned 409');
    });
  });
});
