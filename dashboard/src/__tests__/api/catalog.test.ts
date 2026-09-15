import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api, ApiError } from '../../api/client';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function makeResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

beforeEach(() => mockFetch.mockReset());
afterEach(() => vi.restoreAllMocks());

describe('api.catalog', () => {
  it('list GETs /catalog', async () => {
    const payload = { source: 'test', runners: [], unmanagedModules: [] };
    mockFetch.mockResolvedValueOnce(makeResponse(200, payload));
    const result = await api.catalog.list();
    expect(mockFetch).toHaveBeenCalledWith('/api/catalog', expect.anything());
    expect(result).toEqual(payload);
  });

  it('refresh POSTs /catalog/refresh', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(200, { runners: [], unmanagedModules: [] }));
    await api.catalog.refresh();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/catalog/refresh');
    expect(init.method).toBe('POST');
  });

  it('import POSTs /catalog/:id/import with an encoded id', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(202, { id: 'vllm-0.21', state: 'IMPORTING' }));
    const status = await api.catalog.import('vllm-0.21');
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/catalog/vllm-0.21/import');
    expect(init.method).toBe('POST');
    expect(status).toEqual({ id: 'vllm-0.21', state: 'IMPORTING' });
  });

  it('uninstall DELETEs /catalog/:id', async () => {
    const json = vi.fn(() => Promise.reject(new SyntaxError('Unexpected end of JSON input')));
    mockFetch.mockResolvedValueOnce({ ok: true, status: 204, json });
    await expect(api.catalog.uninstall('vllm-0.21')).resolves.toBeUndefined();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/catalog/vllm-0.21');
    expect(init.method).toBe('DELETE');
    expect(json).not.toHaveBeenCalled();
  });

  it('throws ApiError with the 409 in-use code on uninstall conflict', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(409, { error: 'in use', code: 'MODULE_IN_USE' }));
    await expect(api.catalog.uninstall('vllm-0.21')).rejects.toBeInstanceOf(ApiError);
  });
});
