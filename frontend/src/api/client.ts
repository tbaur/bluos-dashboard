import type {
  ApiErrorBody,
  AudioInput,
  BluetoothResponse,
  DeviceSettingsResponse,
  DiagnoseResponse,
  DevicesResponse,
  FleetActionResponse,
  FleetFirmwareResponse,
  FleetHealthResponse,
  FleetUpgradeResponse,
  PlayerStatus,
  Preset,
  QueueResponse,
  SyncState,
  UpgradeStatus,
} from './types';
import { ApiError } from './types';
import { apiToken } from './auth';

const BASE = '/api/v1';
const FETCH_TIMEOUT_MS = 15_000;

async function parseError(response: Response): Promise<ApiError> {
  try {
    const body = (await response.json()) as ApiErrorBody;
    return new ApiError(response.status, body);
  } catch {
    return new ApiError(response.status, {
      error: 'http_error',
      message: response.statusText || 'Request failed',
      code: 'http_error',
      request_id: response.headers.get('X-Request-ID') || '-',
    });
  }
}

function abortWhenEither(left: AbortSignal, right: AbortSignal): AbortSignal {
  const merged = new AbortController();
  const abort = () => merged.abort();
  if (left.aborted || right.aborted) {
    abort();
    return merged.signal;
  }
  left.addEventListener('abort', abort, { once: true });
  right.addEventListener('abort', abort, { once: true });
  return merged.signal;
}

function timeoutError(): ApiError {
  return new ApiError(408, {
    error: 'timeout',
    message: 'Request timed out',
    code: 'timeout',
    request_id: '-',
  });
}

async function request<T>(
  path: string,
  init?: RequestInit & { json?: unknown },
): Promise<T> {
  const headers = new Headers(init?.headers);
  let body = init?.body;
  if (init?.json !== undefined) {
    headers.set('Content-Type', 'application/json');
    body = JSON.stringify(init.json);
  }
  headers.set('X-BSD-Request', '1');
  if (apiToken) {
    headers.set('Authorization', `Bearer ${apiToken}`);
  }
  const rest = { ...(init ?? {}) } as RequestInit & { json?: unknown };
  delete rest.json;
  const timeoutController = new AbortController();
  const timeoutId = window.setTimeout(() => timeoutController.abort(), FETCH_TIMEOUT_MS);
  const userSignal = rest.signal;
  const signal = userSignal
    ? abortWhenEither(userSignal, timeoutController.signal)
    : timeoutController.signal;
  try {
    const response = await fetch(`${BASE}${path}`, {
      ...rest,
      headers,
      body,
      credentials: 'include',
      signal,
    });
    if (!response.ok) {
      throw await parseError(response);
    }
    if (response.status === 204) {
      return undefined as T;
    }
    return (await response.json()) as T;
  } catch (err) {
    if (err instanceof ApiError) {
      throw err;
    }
    if (err instanceof DOMException && err.name === 'AbortError') {
      // Caller cancelled (unmount / newer control) — not a server timeout.
      if (userSignal?.aborted) throw err;
      throw timeoutError();
    }
    throw err;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

export const api = {
  listDevices: () => request<DevicesResponse>('/devices'),
  refreshDevices: () =>
    request<DevicesResponse>('/devices/refresh', { method: 'POST' }),
  getDevice: (id: string) => request<PlayerStatus>(`/devices/${id}`),
  play: (id: string) => request<void>(`/devices/${id}/play`, { method: 'POST' }),
  pause: (id: string) => request<void>(`/devices/${id}/pause`, { method: 'POST' }),
  stop: (id: string) => request<void>(`/devices/${id}/stop`, { method: 'POST' }),
  skip: (id: string) => request<void>(`/devices/${id}/skip`, { method: 'POST' }),
  back: (id: string) => request<void>(`/devices/${id}/back`, { method: 'POST' }),
  toggle: (id: string) => request<void>(`/devices/${id}/toggle`, { method: 'POST' }),
  seek: (id: string, seconds: number) =>
    request<void>(`/devices/${id}/seek`, { method: 'POST', json: { seconds } }),
  setShuffle: (id: string, state: 0 | 1) =>
    request<void>(`/devices/${id}/shuffle`, { method: 'POST', json: { state } }),
  setRepeat: (id: string, state: 0 | 1 | 2) =>
    request<void>(`/devices/${id}/repeat`, { method: 'POST', json: { state } }),
  adjustVolume: (id: string, delta: number) =>
    request<void>(`/devices/${id}/volume/adjust`, { method: 'POST', json: { delta } }),
  diagnose: (id: string, init?: RequestInit) =>
    request<DiagnoseResponse>(`/devices/${id}/diagnose`, { cache: 'no-store', ...init }),
  getSettings: (id: string, pageId: 'audio' | 'player', init?: RequestInit) =>
    request<DeviceSettingsResponse>(`/devices/${id}/settings/${pageId}`, init),
  setSetting: (id: string, settingId: string, value: string) =>
    request<void>(`/devices/${id}/settings`, {
      method: 'POST',
      json: { id: settingId, value },
    }),
  getUpgrade: (id: string, init?: RequestInit) =>
    request<UpgradeStatus>(`/devices/${id}/upgrade`, init),
  fleetFirmware: () => request<FleetFirmwareResponse>('/fleet/firmware'),
  fleetUpgrades: () => request<FleetUpgradeResponse>('/fleet/upgrades'),
  getFleetHealth: () => request<FleetHealthResponse>('/fleet/health'),
  reboot: (id: string) =>
    request<void>(`/devices/${id}/reboot`, { method: 'POST' }),
  setVolume: (id: string, level: number) =>
    request<void>(`/devices/${id}/volume`, { method: 'POST', json: { level } }),
  setFleetVolume: (level: number, deviceIds?: string[]) => {
    const body =
      deviceIds === undefined
        ? { level }
        : { level, device_ids: deviceIds };
    return request<{
      level: number;
      succeeded: number;
      failed: number;
      results: { device_id: string; name: string; ok: boolean }[];
    }>('/fleet/volume', {
      method: 'POST',
      json: body,
    });
  },
  fleetMute: (mute: boolean) =>
    request<{
      action: string;
      succeeded: number;
      failed: number;
      results: { device_id: string; name: string; ok: boolean }[];
    }>('/fleet/mute', { method: 'POST', json: { mute } }),
  fleetPause: () =>
    request<{
      action: string;
      succeeded: number;
      failed: number;
      results: { device_id: string; name: string; ok: boolean }[];
    }>('/fleet/pause', { method: 'POST' }),
  fleetStop: () =>
    request<{
      action: string;
      succeeded: number;
      failed: number;
      results: { device_id: string; name: string; ok: boolean }[];
    }>('/fleet/stop', { method: 'POST' }),
  fleetReboot: () =>
    request<{
      action: string;
      succeeded: number;
      failed: number;
      results: { device_id: string; name: string; ok: boolean }[];
    }>('/fleet/reboot', { method: 'POST' }),
  setMute: (id: string, mute: boolean) =>
    request<void>(`/devices/${id}/mute`, { method: 'POST', json: { mute } }),
  getQueue: (id: string, init?: RequestInit) =>
    request<QueueResponse>(`/devices/${id}/queue`, init),
  clearQueue: (id: string) =>
    request<void>(`/devices/${id}/queue/clear`, { method: 'POST' }),
  getInputs: (id: string, init?: RequestInit) =>
    request<AudioInput[]>(`/devices/${id}/inputs`, init),
  setInput: (id: string, input: string) =>
    request<void>(`/devices/${id}/input`, { method: 'POST', json: { input } }),
  getBluetooth: (id: string, init?: RequestInit) =>
    request<BluetoothResponse>(`/devices/${id}/bluetooth`, init),
  setBluetooth: (id: string, mode: 0 | 1 | 2 | 3) =>
    request<void>(`/devices/${id}/bluetooth`, { method: 'POST', json: { mode } }),
  getPresets: (id: string, init?: RequestInit) =>
    request<Preset[]>(`/devices/${id}/presets`, init),
  playPreset: (id: string, presetId: string | number) =>
    request<void>(`/devices/${id}/presets/${presetId}/play`, { method: 'POST' }),
  getSync: () => request<SyncState>('/sync'),
  syncAdd: (masterId: string, slaveId: string) =>
    request<void>('/sync/add', {
      method: 'POST',
      json: { master_id: masterId, slave_id: slaveId },
    }),
  syncEnable: (primaryId: string) =>
    request<{
      action: string;
      primary_id: string;
      succeeded: number;
      failed: number;
      results: { device_id: string; name: string; ok: boolean }[];
    }>('/sync/enable', {
      method: 'POST',
      json: { primary_id: primaryId },
    }),
  syncRemove: (masterId: string, slaveId: string) =>
    request<void>('/sync/remove', {
      method: 'POST',
      json: { master_id: masterId, slave_id: slaveId },
    }),
  syncBreak: () => request<FleetActionResponse>('/sync/break', { method: 'POST' }),
  moveQueueItem: (id: string, fromIndex: number, toIndex: number) =>
    request<void>(`/devices/${id}/queue/move`, {
      method: 'POST',
      json: { from_index: fromIndex, to_index: toIndex },
    }),
};
