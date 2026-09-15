/**
 * Tests for notification API client methods.
 *
 * Following the pattern from client.test.ts — mocking fetch with vi.fn()
 * and testing HTTP request construction and error handling.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api, ApiError } from '../../api/client.js';

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

describe('api.notifications.list', () => {
  it('calls /api/notifications with no query params when no args', async () => {
    const payload = { notifications: [] };
    mockFetch.mockResolvedValueOnce(makeResponse(200, payload));

    const result = await api.notifications.list();

    expect(mockFetch).toHaveBeenCalledWith('/api/notifications', expect.anything());
    expect(result).toEqual(payload);
  });

  it('includes limit query param when provided', async () => {
    const payload = { notifications: [] };
    mockFetch.mockResolvedValueOnce(makeResponse(200, payload));

    await api.notifications.list(50);

    expect(mockFetch).toHaveBeenCalledWith('/api/notifications?limit=50', expect.anything());
  });

  it('includes offset query param when provided', async () => {
    const payload = { notifications: [] };
    mockFetch.mockResolvedValueOnce(makeResponse(200, payload));

    await api.notifications.list(undefined, 20);

    expect(mockFetch).toHaveBeenCalledWith('/api/notifications?offset=20', expect.anything());
  });

  it('includes both limit and offset query params when provided', async () => {
    const payload = { notifications: [] };
    mockFetch.mockResolvedValueOnce(makeResponse(200, payload));

    await api.notifications.list(100, 50);

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/notifications?limit=100&offset=50',
      expect.anything(),
    );
  });

  it('passes AbortSignal to fetch', async () => {
    const payload = { notifications: [] };
    mockFetch.mockResolvedValueOnce(makeResponse(200, payload));

    const controller = new AbortController();
    await api.notifications.list(200, undefined, controller.signal);

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/notifications?limit=200',
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it('returns notifications array', async () => {
    const payload = {
      notifications: [
        {
          id: 'n1',
          title: 'Test',
          variant: 'info',
          timestamp: '2024-01-01T00:00:00Z',
          isRead: false,
        },
      ],
    };
    mockFetch.mockResolvedValueOnce(makeResponse(200, payload));

    const result = await api.notifications.list();

    expect(result.notifications).toHaveLength(1);
    expect(result.notifications[0].id).toBe('n1');
  });
});

describe('api.notifications.markRead', () => {
  it('sends POST to /api/notifications/:id/read', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(200, {}));

    await api.notifications.markRead('notif-123');

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/notifications/notif-123/read',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('encodes notification ID in URL', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(200, {}));

    await api.notifications.markRead('notif/special id');

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/notifications/notif%2Fspecial%20id/read',
      expect.anything(),
    );
  });

  it('returns on success', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(200, {}));

    const result = await api.notifications.markRead('n1');

    expect(result).toBeDefined();
  });

  it('throws ApiError on 404', async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse(404, { error: 'Notification not found', code: 'NOTIFICATION_NOT_FOUND' }),
    );

    await expect(api.notifications.markRead('nonexistent')).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.status).toBe(404);
      expect(apiErr.message).toBe('Notification not found');
      return true;
    });
  });
});

describe('api.notifications.markAllRead', () => {
  it('sends POST to /api/notifications/read-all', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(200, {}));

    await api.notifications.markAllRead();

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/notifications/read-all',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('returns on success', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(200, {}));

    const result = await api.notifications.markAllRead();

    expect(result).toBeDefined();
  });
});

describe('api.notifications.remove', () => {
  it('sends DELETE to /api/notifications/:id', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(200, {}));

    await api.notifications.remove('notif-123');

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/notifications/notif-123',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('encodes notification ID in URL', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(200, {}));

    await api.notifications.remove('notif/special id');

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/notifications/notif%2Fspecial%20id',
      expect.anything(),
    );
  });

  it('returns on success', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(200, {}));

    const result = await api.notifications.remove('n1');

    expect(result).toBeDefined();
  });

  it('throws ApiError on 404', async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse(404, { error: 'Notification not found', code: 'NOTIFICATION_NOT_FOUND' }),
    );

    await expect(api.notifications.remove('nonexistent')).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.status).toBe(404);
      return true;
    });
  });
});

describe('api.notifications.clearAll', () => {
  it('sends DELETE to /api/notifications', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(200, {}));

    await api.notifications.clearAll();

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/notifications',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('returns on success', async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(200, {}));

    const result = await api.notifications.clearAll();

    expect(result).toBeDefined();
  });
});

describe('api.notifications error handling', () => {
  it('throws ApiError on 500 server error', async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse(500, { error: 'Internal server error', code: 'INTERNAL_ERROR' }),
    );

    await expect(api.notifications.list()).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.status).toBe(500);
      expect(apiErr.message).toBe('Internal server error');
      return true;
    });
  });

  it('throws ApiError on 400 validation error', async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse(400, { error: 'Invalid limit parameter', code: 'VALIDATION_ERROR' }),
    );

    await expect(api.notifications.list(-1)).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.status).toBe(400);
      return true;
    });
  });

  it('handles network errors gracefully', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    await expect(api.notifications.list()).rejects.toThrow('Network error');
  });
});
