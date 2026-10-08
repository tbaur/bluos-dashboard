import { describe, expect, it, vi, afterEach } from 'vitest';
import { api } from '@/api/client';
import { ApiError } from '@/api/types';

describe('api client', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('parses structured API errors with request id', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        headers: new Headers({ 'X-Request-ID': 'req-abc' }),
        json: async () => ({
          error: 'device_not_found',
          message: 'Device is not in the discovered set',
          code: 'device_not_found',
          request_id: 'req-abc',
        }),
      }),
    );

    await expect(api.getDevice('missing')).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.status).toBe(404);
      expect(apiErr.code).toBe('device_not_found');
      expect(apiErr.requestId).toBe('req-abc');
      return true;
    });
  });

  it('falls back when error body is not JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Server Error',
        headers: new Headers(),
        json: async () => {
          throw new Error('not json');
        },
      }),
    );

    await expect(api.listDevices()).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.message).toBe('Server Error');
      expect(apiErr.code).toBe('http_error');
      return true;
    });
  });

  it('returns undefined for 204 responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 204,
        headers: new Headers(),
      }),
    );

    await expect(api.toggle('player-1')).resolves.toBeUndefined();
  });

  it('times out when the server never responds', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        });
      }),
    );
    const pending = api.listDevices();
    const expectation = expect(pending).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.status).toBe(408);
      expect(apiErr.code).toBe('timeout');
      return true;
    });
    await vi.advanceTimersByTimeAsync(15_000);
    await expectation;
    vi.useRealTimers();
  });

  it('does not treat a caller abort as a timeout', async () => {
    const caller = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        });
      }),
    );
    const pending = api.getQueue('player-1', { signal: caller.signal });
    caller.abort();
    await expect(pending).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(DOMException);
      expect((err as DOMException).name).toBe('AbortError');
      return true;
    });
  });

  it('posts settings writes without a client-supplied path', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
      headers: new Headers(),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      api.setSetting('player-kitchen', 'channelMode', 'left'),
    ).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/devices/player-kitchen/settings',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          id: 'channelMode',
          value: 'left',
        }),
      }),
    );
  });
});
