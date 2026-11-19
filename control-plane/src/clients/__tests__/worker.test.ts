import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DeviceType } from '@sardeenz/types';

import { WorkerClient, WorkerHttpError, WorkerResponseError } from '../worker.js';

const mockFetch = vi.fn();

beforeEach(() => {
  mockFetch.mockReset();
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
        devices: [{ deviceIndex: 0, deviceType: DeviceType.CUDA }],
      });

      expect(result).toEqual(response);
      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://worker-1:8080/runners');
      expect((opts as Record<string, unknown>).method).toBe('POST');
      expect(JSON.parse((opts as Record<string, unknown>).body as string)).toMatchObject({
        modelName: 'llama-3',
        runnerType: 'vllm',
      });
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
      await expect(
        client.startRunner({
          modelName: 'm',
          runnerType: 'vllm',
          modelPath: '/p',
          requiredMemory: 1,
          tensorParallel: 1,
          devices: [],
        }),
      ).rejects.toBeInstanceOf(WorkerHttpError);
    });
  });

  describe('getRunnerByInstance', () => {
    it.each([
      [404, { error: 'missing' }, { status: 'absent' }],
      [
        202,
        { instanceId: 'inst-1', runnerId: 'runner-1', state: 'STARTING' },
        { status: 'starting', runnerId: 'runner-1' },
      ],
      [
        200,
        {
          instanceId: 'inst-1',
          runnerId: 'runner-1',
          state: 'READY',
          host: '10.0.0.1',
          port: 8000,
          enginePort: 8001,
        },
        {
          status: 'ready',
          runnerId: 'runner-1',
          host: '10.0.0.1',
          port: 8000,
          enginePort: 8001,
        },
      ],
    ])('maps worker status %i to a recovery fact', async (status, body, expected) => {
      mockFetch.mockResolvedValue(jsonResponse(body, status));
      const client = new WorkerClient({ baseUrl: 'http://worker-1:8080' });

      await expect(client.getRunnerByInstance('inst-1')).resolves.toEqual(expected);
      expect(mockFetch.mock.calls[0]?.[0]).toBe(
        'http://worker-1:8080/runners/by-instance/inst-1/status',
      );
    });
  });

  describe('listRunners (#286)', () => {
    /**
     * Real `Response` objects (not the `jsonResponse` stub) — `listRunners` reads the body through
     * a size-capped stream, so the tests must exercise an actual stream, and the over-cap case
     * needs a body genuinely larger than the cap.
     */
    function registryResponse(body: unknown, status = 200): Response {
      return new Response(JSON.stringify(body), { status });
    }

    it('sends GET /runners with the bearer token and returns the registry entries', async () => {
      const runners = [
        {
          runnerId: 'runner-1',
          instanceId: 'inst-1',
          modelName: 'llama-3',
          state: 'READY',
          host: '10.0.0.1',
          port: 8000,
          enginePort: 8001,
        },
        {
          runnerId: 'runner-2',
          instanceId: 'inst-2',
          modelName: 'llama-3',
          state: 'STARTING',
        },
      ];
      mockFetch.mockResolvedValue(registryResponse({ runners }));

      const client = new WorkerClient({ baseUrl: 'http://worker-1:8080', token: 'secret' });
      await expect(client.listRunners()).resolves.toEqual(runners);

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://worker-1:8080/runners');
      // No method override: fetch defaults to GET, so the enumeration never posts to the registry.
      expect((opts as Record<string, unknown>).method).toBeUndefined();
      expect((opts as Record<string, unknown>).headers).toEqual({ Authorization: 'Bearer secret' });
    });

    it('returns an empty list for a worker hosting nothing', async () => {
      mockFetch.mockResolvedValue(registryResponse({ runners: [] }));

      const client = new WorkerClient({ baseUrl: 'http://worker-1:8080' });
      await expect(client.listRunners()).resolves.toEqual([]);
    });

    it('throws a WorkerHttpError carrying the status on a non-OK response', async () => {
      mockFetch.mockResolvedValue(registryResponse({ error: 'boom' }, 500));

      const client = new WorkerClient({ baseUrl: 'http://worker-1:8080' });
      const failure = client.listRunners();
      await expect(failure).rejects.toBeInstanceOf(WorkerHttpError);
      await expect(failure).rejects.toMatchObject({ status: 500 });
      await expect(failure).rejects.toThrow('returned 500');
    });

    it('rejects an over-cap body instead of buffering it', async () => {
      // 1 MiB + 1 byte, streamed (no content-length): the streamed counter is the bound.
      const oversized = 'x'.repeat(1024 * 1024 + 1);
      mockFetch.mockResolvedValue(new Response(oversized));

      const client = new WorkerClient({ baseUrl: 'http://worker-1:8080' });
      const failure = client.listRunners();
      await expect(failure).rejects.toBeInstanceOf(WorkerResponseError);
      await expect(failure).rejects.toThrow('exceeds the');
    });

    it('rejects on a declared content-length over the cap without reading the body', async () => {
      let cancelled = false;
      const body = new ReadableStream({
        pull: () => new Promise<void>(() => {}),
        cancel: () => {
          cancelled = true;
        },
      });
      mockFetch.mockResolvedValue(
        new Response(body, { headers: { 'content-length': String(8 * 1024 * 1024) } }),
      );

      const client = new WorkerClient({ baseUrl: 'http://worker-1:8080' });
      await expect(client.listRunners()).rejects.toThrow('exceeds the');
      // Refused before a byte was read, but the body is released rather than left streaming into
      // a socket nobody drains.
      expect(cancelled).toBe(true);
    });

    it('keeps the status when the error body itself is over the cap', async () => {
      mockFetch.mockResolvedValue(new Response('x'.repeat(1024 * 1024 + 1), { status: 500 }));

      const client = new WorkerClient({ baseUrl: 'http://worker-1:8080' });
      const failure = client.listRunners();
      await expect(failure).rejects.toBeInstanceOf(WorkerHttpError);
      await expect(failure).rejects.toMatchObject({ status: 500 });
    });

    it('rejects a body whose `runners` member is not an array', async () => {
      mockFetch.mockResolvedValue(registryResponse({ runners: null }));

      const client = new WorkerClient({ baseUrl: 'http://worker-1:8080' });
      const failure = client.listRunners();
      await expect(failure).rejects.toBeInstanceOf(WorkerResponseError);
      await expect(failure).rejects.toThrow('no `runners` array');
    });

    it('rejects a registry entry missing a contract-required field', async () => {
      mockFetch.mockResolvedValue(
        registryResponse({
          runners: [{ runnerId: 'runner-1', modelName: 'llama-3', state: 'READY' }],
        }),
      );

      const client = new WorkerClient({ baseUrl: 'http://worker-1:8080' });
      await expect(client.listRunners()).rejects.toThrow('runners[0].instanceId');
    });

    it('rejects a non-object registry entry', async () => {
      mockFetch.mockResolvedValue(registryResponse({ runners: ['runner-1'] }));

      const client = new WorkerClient({ baseUrl: 'http://worker-1:8080' });
      await expect(client.listRunners()).rejects.toThrow('runners[0] is not an object');
    });

    it('rejects an entry whose state is not a RunnerProcessState', async () => {
      mockFetch.mockResolvedValue(
        registryResponse({
          runners: [
            { runnerId: 'runner-1', instanceId: 'inst-1', modelName: 'llama-3', state: 'BROKEN' },
          ],
        }),
      );

      const client = new WorkerClient({ baseUrl: 'http://worker-1:8080' });
      await expect(client.listRunners()).rejects.toThrow('state must be a RunnerProcessState');
    });

    it('rejects a body that is not JSON', async () => {
      mockFetch.mockResolvedValue(new Response('<html>502 bad gateway</html>'));

      const client = new WorkerClient({ baseUrl: 'http://worker-1:8080' });
      await expect(client.listRunners()).rejects.toBeInstanceOf(WorkerResponseError);
    });

    it('propagates a transport failure instead of reporting an empty registry', async () => {
      mockFetch.mockRejectedValue(new Error('connect ECONNREFUSED'));

      const client = new WorkerClient({ baseUrl: 'http://worker-1:8080' });
      await expect(client.listRunners()).rejects.toThrow('connect ECONNREFUSED');
    });
  });

  describe('redirects (#286 security review)', () => {
    it('rejects a 302 instead of following it, and never calls the redirect target', async () => {
      const METADATA = 'http://169.254.169.254/latest/meta-data';
      const urls: string[] = [];
      // Faithful stub: real fetch replays the request (Authorization header included) against the
      // Location target unless `redirect: 'error'` is set, so the stub does the same.
      const fetchImpl = (url: string, init: RequestInit): Promise<Response> => {
        urls.push(url);
        if (url === METADATA) return Promise.resolve(new Response('{"runners":[]}'));
        if (init.redirect !== 'error') return fetchImpl(METADATA, init);
        return Promise.resolve(
          new Response(null, { status: 302, headers: { location: METADATA } }),
        );
      };
      mockFetch.mockImplementation(fetchImpl);

      const client = new WorkerClient({ baseUrl: 'http://worker-1:8080', token: 'worker-token' });
      await expect(client.listRunners()).rejects.toMatchObject({ status: 302 });

      expect(urls).toEqual(['http://worker-1:8080/runners']);
      expect(mockFetch).toHaveBeenCalledOnce();
    });

    it('passes redirect: error on every request this client makes', async () => {
      const body = JSON.stringify({
        runners: [],
        state: 'READY',
        runnerId: 'r-1',
        host: '10.0.0.1',
        port: 8000,
      });
      mockFetch.mockImplementation(() => Promise.resolve(new Response(body, { status: 200 })));

      const client = new WorkerClient({ baseUrl: 'http://worker-1:8080', token: 't' });
      await client.startRunner({
        modelName: 'm',
        runnerType: 'vllm',
        modelPath: '/p',
        requiredMemory: 1,
        tensorParallel: 1,
        devices: [],
      });
      await client.getRunner('r-1');
      await client.getRunnerByInstance('inst-1');
      await client.listRunners();
      await client.stopRunner('r-1');
      await client.streamRunnerLogs('r-1');
      await client.streamRunnerLogsByModel('m');
      await client.streamRunnerLogsByInstance('inst-1');

      expect(mockFetch).toHaveBeenCalledTimes(8);
      for (const call of mockFetch.mock.calls) {
        expect(((call as [string, RequestInit])[1] as Record<string, unknown>).redirect).toBe(
          'error',
        );
      }
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
