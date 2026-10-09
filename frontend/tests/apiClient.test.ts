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

  const id = 'player-1';
  it.each([
    ['listDevices', () => api.listDevices(), 'GET', '/devices'],
    ['refreshDevices', () => api.refreshDevices(), 'POST', '/devices/refresh'],
    ['getDevice', () => api.getDevice(id), 'GET', `/devices/${id}`],
    ['play', () => api.play(id), 'POST', `/devices/${id}/play`],
    ['pause', () => api.pause(id), 'POST', `/devices/${id}/pause`],
    ['stop', () => api.stop(id), 'POST', `/devices/${id}/stop`],
    ['skip', () => api.skip(id), 'POST', `/devices/${id}/skip`],
    ['back', () => api.back(id), 'POST', `/devices/${id}/back`],
    ['seek', () => api.seek(id, 42), 'POST', `/devices/${id}/seek`, { seconds: 42 }],
    ['setShuffle', () => api.setShuffle(id, 1), 'POST', `/devices/${id}/shuffle`, { state: 1 }],
    ['setRepeat', () => api.setRepeat(id, 2), 'POST', `/devices/${id}/repeat`, { state: 2 }],
    ['adjustVolume', () => api.adjustVolume(id, -2), 'POST', `/devices/${id}/volume/adjust`, { delta: -2 }],
    ['diagnose', () => api.diagnose(id), 'GET', `/devices/${id}/diagnose`],
    ['getSettings', () => api.getSettings(id, 'audio'), 'GET', `/devices/${id}/settings/audio`],
    ['getUpgrade', () => api.getUpgrade(id), 'GET', `/devices/${id}/upgrade`],
    ['fleetFirmware', () => api.fleetFirmware(), 'GET', '/fleet/firmware'],
    ['fleetUpgrades', () => api.fleetUpgrades(), 'GET', '/fleet/upgrades'],
    ['getFleetHealth', () => api.getFleetHealth(), 'GET', '/fleet/health'],
    ['reboot', () => api.reboot(id), 'POST', `/devices/${id}/reboot`],
    ['setVolume', () => api.setVolume(id, 30), 'POST', `/devices/${id}/volume`, { level: 30 }],
    ['setFleetVolume', () => api.setFleetVolume(30), 'POST', '/fleet/volume', { level: 30 }],
    [
      'setFleetVolume scoped',
      () => api.setFleetVolume(30, [id]),
      'POST',
      '/fleet/volume',
      { level: 30, device_ids: [id] },
    ],
    ['fleetMute', () => api.fleetMute(true), 'POST', '/fleet/mute', { mute: true }],
    ['fleetPause', () => api.fleetPause(), 'POST', '/fleet/pause'],
    ['fleetStop', () => api.fleetStop(), 'POST', '/fleet/stop'],
    ['fleetReboot', () => api.fleetReboot(), 'POST', '/fleet/reboot'],
    ['setMute', () => api.setMute(id, false), 'POST', `/devices/${id}/mute`, { mute: false }],
    ['getQueue', () => api.getQueue(id), 'GET', `/devices/${id}/queue`],
    ['clearQueue', () => api.clearQueue(id), 'POST', `/devices/${id}/queue/clear`],
    ['getInputs', () => api.getInputs(id), 'GET', `/devices/${id}/inputs`],
    ['setInput', () => api.setInput(id, 'spdif-1'), 'POST', `/devices/${id}/input`, { input: 'spdif-1' }],
    ['getBluetooth', () => api.getBluetooth(id), 'GET', `/devices/${id}/bluetooth`],
    ['setBluetooth', () => api.setBluetooth(id, 3), 'POST', `/devices/${id}/bluetooth`, { mode: 3 }],
    ['getPresets', () => api.getPresets(id), 'GET', `/devices/${id}/presets`],
    ['playPreset', () => api.playPreset(id, 4), 'POST', `/devices/${id}/presets/4/play`],
    ['getSync', () => api.getSync(), 'GET', '/sync'],
    [
      'syncAdd',
      () => api.syncAdd('lead', id),
      'POST',
      '/sync/add',
      { master_id: 'lead', slave_id: id },
    ],
    ['syncEnable', () => api.syncEnable('lead'), 'POST', '/sync/enable', { primary_id: 'lead' }],
    [
      'syncRemove',
      () => api.syncRemove('lead', id),
      'POST',
      '/sync/remove',
      { master_id: 'lead', slave_id: id },
    ],
    ['syncBreak', () => api.syncBreak(), 'POST', '/sync/break'],
    [
      'moveQueueItem',
      () => api.moveQueueItem(id, 1, 3),
      'POST',
      `/devices/${id}/queue/move`,
      { from_index: 1, to_index: 3 },
    ],
  ] as const)('%s calls %s %s', async (_name, call, method, path, body?: object) => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({}),
    });
    vi.stubGlobal('fetch', fetchMock);

    await call();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/v1${path}`);
    expect(init.method ?? 'GET').toBe(method);
    expect(new Headers(init.headers).get('X-BSD-Request')).toBe('1');
    expect(init.body === undefined ? undefined : JSON.parse(String(init.body))).toEqual(body);
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
