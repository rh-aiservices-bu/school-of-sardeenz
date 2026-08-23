import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api, ApiError } from '../../api/client';

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function makeResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

beforeEach(() => {
  mockFetch.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ApiError', () => {
  it('stores status, message, code, and details', () => {
    const err = new ApiError(404, 'Not found', 'NOT_FOUND', { resource: 'model' });
    expect(err.status).toBe(404);
    expect(err.message).toBe('Not found');
    expect(err.code).toBe('NOT_FOUND');
    expect(err.details).toEqual({ resource: 'model' });
    expect(err.name).toBe('ApiError');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ApiError);
  });

  it('works without optional fields', () => {
    const err = new ApiError(500, 'Internal server error');
    expect(err.code).toBeUndefined();
    expect(err.details).toBeUndefined();
  });
});

describe('api.cluster.getStatus', () => {
  it('returns cluster status on success', async () => {
    const payload = { status: 'HEALTHY', activeModels: 2, totalWorkers: 3 };
    mockFetch.mockResolvedValueOnce(makeResponse(200, payload));

    const result = await api.cluster.getStatus();

    expect(mockFetch).toHaveBeenCalledWith('/api/cluster/status', expect.anything());
    expect(result).toEqual(payload);
  });

  it('passes AbortSignal to fetch', async () => {
    const payload = { status: 'HEALTHY' };
    mockFetch.mockResolvedValueOnce(makeResponse(200, payload));

    const controller = new AbortController();
    await api.cluster.getStatus(controller.signal);

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/cluster/status',
      expect.objectContaining({ signal: controller.signal }),
    );
  });
});

describe('error handling', () => {
  it('throws ApiError on 404 with parsed body', async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse(404, { error: 'Model not found', code: 'MODEL_NOT_FOUND' }),
    );

    await expect(api.models.get('nonexistent')).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.status).toBe(404);
      expect(apiErr.message).toBe('Model not found');
      expect(apiErr.code).toBe('MODEL_NOT_FOUND');
      return true;
    });
  });

  it('throws ApiError on 500 with fallback message when body is unparseable', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(500, null));
    // Override json to reject — simulate unparseable body
    const fakeRes = {
      ok: false,
      status: 500,
      json: () => Promise.reject(new Error('not json')),
    };
    mockFetch.mockReset();
    mockFetch.mockResolvedValueOnce(fakeRes);

    await expect(api.cluster.getStatus()).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.status).toBe(500);
      expect(apiErr.message).toBe('HTTP 500');
      return true;
    });
  });

  it('throws ApiError on 400', async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse(400, { error: 'Bad request', code: 'VALIDATION_ERROR' }),
    );

    await expect(api.models.deploy({ name: '' } as never)).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.status).toBe(400);
      return true;
    });
  });
});

describe('api.models', () => {
  it('list without filter calls /models', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(200, { models: [] }));
    await api.models.list();
    expect(mockFetch).toHaveBeenCalledWith('/api/models', expect.anything());
  });

  it('list with state filter appends query param', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(200, { models: [] }));
    await api.models.list('ACTIVE');
    expect(mockFetch).toHaveBeenCalledWith('/api/models?state=ACTIVE', expect.anything());
  });

  it('get encodes model name in URL', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(200, { name: 'my model' }));
    await api.models.get('my model');
    expect(mockFetch).toHaveBeenCalledWith('/api/models/my%20model', expect.anything());
  });

  it('delete sends DELETE request', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(202, {}));
    await api.models.delete('llama3');
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/models/llama3',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('sleep sends POST request', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(202, {}));
    await api.models.sleep('llama3');
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/models/llama3/sleep',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('wake sends POST request', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(202, {}));
    await api.models.wake('llama3');
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/models/llama3/wake',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});

describe('api.inference.chat', () => {
  function makeStreamResponse(frames: string[], status = 200): Response {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) {
          controller.enqueue(encoder.encode(frame));
        }
        controller.close();
      },
    });
    return {
      ok: status >= 200 && status < 300,
      status,
      body: stream,
      json: () => Promise.resolve({}),
    } as unknown as Response;
  }

  beforeEach(() => {
    sessionStorage.clear();
  });

  it('delivers accumulated deltas via onChunk and calls onDone with the full text', async () => {
    mockFetch.mockResolvedValueOnce(
      makeStreamResponse([
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'Hel' } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'lo!' } }] })}\n\n`,
        'data: [DONE]\n\n',
      ]),
    );

    const onChunk = vi.fn();
    const onDone = vi.fn();
    const onError = vi.fn();
    const controller = new AbortController();

    await api.inference.chat(
      { model: 'llama-3', messages: [{ role: 'user', content: 'hi' }] },
      { onChunk, onDone, onError },
      controller.signal,
    );

    expect(onChunk).toHaveBeenNthCalledWith(1, 'Hel');
    expect(onChunk).toHaveBeenNthCalledWith(2, 'lo!');
    expect(onDone).toHaveBeenCalledWith('Hello!');
    expect(onError).not.toHaveBeenCalled();
  });

  it('clears the token and dispatches auth:unauthorized on a real 401', async () => {
    sessionStorage.setItem('sardeenz_auth_token', 'stale-token');
    mockFetch.mockResolvedValueOnce(makeStreamResponse([], 401));

    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
    const onError = vi.fn();
    const controller = new AbortController();

    await api.inference.chat(
      { model: 'llama-3', messages: [] },
      { onChunk: vi.fn(), onDone: vi.fn(), onError },
      controller.signal,
    );

    expect(sessionStorage.getItem('sardeenz_auth_token')).toBeNull();
    expect(dispatchSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'auth:unauthorized' }));
    expect(onError).toHaveBeenCalled();
  });

  it('a non-401 upstream error calls onError WITHOUT dispatching auth:unauthorized', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 502,
      body: null,
      json: () => Promise.resolve({ error: 'bad gateway' }),
    });

    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
    const onError = vi.fn();
    const controller = new AbortController();

    await api.inference.chat(
      { model: 'llama-3', messages: [] },
      { onChunk: vi.fn(), onDone: vi.fn(), onError },
      controller.signal,
    );

    expect(onError).toHaveBeenCalled();
    expect(dispatchSpy).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'auth:unauthorized' }));
  });

  it('an aborted request is swallowed — no onError, no auth:unauthorized', async () => {
    const abortError = new DOMException('The operation was aborted', 'AbortError');
    mockFetch.mockRejectedValueOnce(abortError);

    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
    const onError = vi.fn();
    const controller = new AbortController();

    await api.inference.chat(
      { model: 'llama-3', messages: [] },
      { onChunk: vi.fn(), onDone: vi.fn(), onError },
      controller.signal,
    );

    expect(onError).not.toHaveBeenCalled();
    expect(dispatchSpy).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'auth:unauthorized' }));
  });
});

describe('api.workers', () => {
  it('list returns workers', async () => {
    const payload = { workers: [{ id: 'w1', status: 'ONLINE' }] };
    mockFetch.mockResolvedValueOnce(makeResponse(200, payload));
    const result = await api.workers.list();
    expect(result).toEqual(payload);
  });

  it('get encodes worker id', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(200, { id: 'w/1' }));
    await api.workers.get('w/1');
    expect(mockFetch).toHaveBeenCalledWith('/api/workers/w%2F1', expect.anything());
  });
});
