import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlayerStatus } from '@/api/types';
import { ApiError } from '@/api/types';
import { LIVE_HOUSE_SESSION } from '@/lib/houseSession';
import { useFleetStore } from '@/store/fleetStore';

const listDevices = vi.fn();
const refreshDevices = vi.fn();
const getSync = vi.fn();
const getFleetHealth = vi.fn();
const setFleetVolume = vi.fn();
const setMute = vi.fn();
const fleetMute = vi.fn();
const fleetReboot = vi.fn();

vi.mock('@/api/client', () => ({
  api: {
    listDevices: (...args: unknown[]) => listDevices(...args),
    refreshDevices: (...args: unknown[]) => refreshDevices(...args),
    getSync: (...args: unknown[]) => getSync(...args),
    getFleetHealth: (...args: unknown[]) => getFleetHealth(...args),
    setFleetVolume: (...args: unknown[]) => setFleetVolume(...args),
    setMute: (...args: unknown[]) => setMute(...args),
    fleetMute: (...args: unknown[]) => fleetMute(...args),
    fleetReboot: (...args: unknown[]) => fleetReboot(...args),
  },
}));

const base: PlayerStatus = {
  id: 'player-1',
  ip: '192.168.1.10',
  name: 'Kitchen',
  model: 'NODE',
  brand: 'Bluesound',
  full_model: 'Bluesound NODE',
  device_class: 'streamer',
  mac: '90:56:82:00:00:01',
  status: 'online',
  state: 'play',
  service: 'Spotify',
  service_id: 'Spotify',
  volume: 30,
  muted: false,
  db: '-40',
  fw: '4.0',
  master: '',
  group: '',
  group_volume: null,
  slaves: [],
  sync_role: 'standalone',
  battery: null,
  track: 'Track',
  artist: 'Artist',
  album: 'Album',
  quality: '',
  stream_format: '',
  image: '',
  secs: 0,
  totlen: 0,
  can_seek: false,
  input_type_index: '',
  consecutive_failures: 0,
  last_seen: 1,
};

const second: PlayerStatus = { ...base, id: 'player-2', name: 'Den', volume: 40 };

const health = {
  started_at: 1,
  observed_at: 2,
  window_seconds: 86_400,
  presence_window_seconds: 43_200,
  circuit_failure_threshold: 5,
  first_online: {},
  drops: [],
};

function apiError(message: string): ApiError {
  return new ApiError(502, { error: 'x', message, code: 'x', request_id: 'req-9' });
}

function fleetResponse(devices: PlayerStatus[]) {
  return { devices, discovered_at: 9, discovery_method: 'mdns' };
}

function result(succeeded: number, failed: number) {
  return { action: 'x', level: 0, succeeded, failed, results: [] };
}

const store = () => useFleetStore.getState();
const device = (id: string) => store().devices.find((d) => d.id === id)!;

beforeEach(() => {
  vi.clearAllMocks();
  useFleetStore.setState({
    devices: [],
    discoveredAt: null,
    discoveryMethod: '',
    sync: null,
    health: null,
    connection: 'connecting',
    loading: true,
    refreshing: false,
    error: null,
    toast: null,
    volumeHoldUntil: {},
    playbackHoldUntil: {},
    muteHoldUntil: {},
    houseSession: LIVE_HOUSE_SESSION,
    globalVolumeHoldUntil: 0,
    syncHoldUntil: 0,
    lastAudibleVolume: {},
  });
  getSync.mockResolvedValue({ groups: [], standalone_ids: [] });
  getFleetHealth.mockResolvedValue(health);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('setFleetVolume', () => {
  it('paints every player, holds the global volume, and remembers it for unmute', async () => {
    store().setFleet([base, second]);
    setFleetVolume.mockResolvedValue(result(2, 0));

    await store().setFleetVolume(55.4);

    expect(setFleetVolume).toHaveBeenCalledWith(55, undefined);
    expect(store().devices.map((d) => d.volume)).toEqual([55, 55]);
    expect(store().globalVolumeHoldUntil).toBeGreaterThan(Date.now());
    expect(store().lastAudibleVolume).toEqual({ 'player-1': 55, 'player-2': 55 });
    expect(store().toast).toBeNull();
  });

  it('only touches the listed players when scoped, and reports partial failure', async () => {
    store().setFleet([base, second]);
    setFleetVolume.mockResolvedValue(result(0, 1));

    await store().setFleetVolume(120, ['player-2']);

    expect(setFleetVolume).toHaveBeenCalledWith(100, ['player-2']);
    expect(device('player-1').volume).toBe(30);
    expect(device('player-2').volume).toBe(100);
    expect(store().globalVolumeHoldUntil).toBe(0);
    expect(store().toast).toBe('Volume 100: 0 ok, 1 failed');
  });

  it('ignores an explicit empty list', async () => {
    store().setFleet([base]);
    await store().setFleetVolume(10, []);
    expect(setFleetVolume).not.toHaveBeenCalled();
  });

  it('drops the global hold and reloads server truth when the call fails', async () => {
    store().setFleet([base, second]);
    setFleetVolume.mockRejectedValue(apiError('Volume failed'));
    listDevices.mockResolvedValue(fleetResponse([base, second]));

    await store().setFleetVolume(5);

    expect(store().globalVolumeHoldUntil).toBe(0);
    expect(store().toast).toBe('Volume failed (req-9)');
    expect(listDevices).toHaveBeenCalledOnce();
  });
});

describe('toggleMute', () => {
  it('mutes to zero and restores the last audible volume on unmute', async () => {
    store().setFleet([base]);
    setMute.mockResolvedValue(undefined);

    await store().toggleMute('player-1');
    expect(device('player-1')).toMatchObject({ muted: true, volume: 0 });
    expect(setMute).toHaveBeenLastCalledWith('player-1', true);

    await store().toggleMute('player-1');
    expect(device('player-1')).toMatchObject({ muted: false, volume: 30 });
    expect(setMute).toHaveBeenLastCalledWith('player-1', false);
  });

  it('unmutes a player that was already silent to the default level', async () => {
    store().setFleet([{ ...base, muted: true, volume: 0 }]);
    setMute.mockResolvedValue(undefined);
    await store().toggleMute('player-1');
    expect(device('player-1').volume).toBe(20);
  });

  it('puts the player back and names the request when mute fails', async () => {
    store().setFleet([base]);
    setMute.mockRejectedValue(apiError('Mute failed'));

    await store().toggleMute('player-1');

    expect(device('player-1')).toMatchObject({ muted: false, volume: 30 });
    expect(store().toast).toBe('Mute failed (req-9)');
  });

  it('does nothing for an unknown player', async () => {
    await store().toggleMute('missing');
    expect(setMute).not.toHaveBeenCalled();
  });
});

describe('house-wide actions', () => {
  it('unmute all restores each player and reports partial failure', async () => {
    store().setFleet([{ ...base, muted: true, volume: 0 }, second]);
    useFleetStore.setState({ lastAudibleVolume: { 'player-1': 25 } });
    fleetMute.mockResolvedValue(result(1, 1));

    await store().fleetMuteAll(false);

    expect(device('player-1')).toMatchObject({ muted: false, volume: 25 });
    expect(device('player-2')).toMatchObject({ muted: false, volume: 40 });
    expect(store().toast).toBe('Fleet unmute: 1 ok, 1 failed');
  });

  it('reboot all reports how many players got the command', async () => {
    store().setFleet([base]);
    fleetReboot.mockResolvedValueOnce(result(1, 0));
    await store().fleetRebootAll();
    expect(store().toast).toBe('Reboot sent to 1 player');

    store().setFleet([base, second]);
    fleetReboot.mockResolvedValueOnce(result(2, 0));
    await store().fleetRebootAll();
    expect(store().toast).toBe('Reboot sent to 2 players');

    fleetReboot.mockResolvedValueOnce(result(1, 1));
    await store().fleetRebootAll();
    expect(store().toast).toBe('Reboot: 1 ok, 1 failed');

    fleetReboot.mockRejectedValueOnce(new Error('network'));
    await store().fleetRebootAll();
    expect(store().toast).toBe('Fleet reboot failed');
  });

  it('reboot all does nothing with an empty fleet', async () => {
    await store().fleetRebootAll();
    expect(fleetReboot).not.toHaveBeenCalled();
  });
});

describe('loading the fleet', () => {
  it('keeps the last health report when the health call fails', async () => {
    useFleetStore.setState({ health });
    listDevices.mockResolvedValue(fleetResponse([base]));
    getFleetHealth.mockRejectedValue(new Error('down'));

    await store().load();

    expect(store().health).toBe(health);
    expect(store().discoveredAt).toBe(9);
    expect(store().loading).toBe(false);
  });

  it('load and refresh surface their errors', async () => {
    listDevices.mockRejectedValue(apiError('Backend down'));
    await store().load();
    expect(store()).toMatchObject({ loading: false, error: 'Backend down' });

    refreshDevices.mockRejectedValue(new Error('network'));
    await store().refresh();
    expect(store()).toMatchObject({
      refreshing: false,
      error: 'Refresh failed',
      toast: 'Refresh failed',
    });
  });

  it('reloadStatus keeps retrying until the new link shows up', async () => {
    store().setFleet([base, second]);
    const linked = {
      groups: [{ primary_id: 'player-1', slave_ids: ['player-2'] }],
      standalone_ids: [],
    };
    listDevices.mockResolvedValue(fleetResponse([base, second]));
    getSync
      .mockResolvedValueOnce({ groups: [], standalone_ids: ['player-1', 'player-2'] })
      .mockResolvedValueOnce(linked);

    await store().reloadStatus({ ensureLink: { primaryId: 'player-1', slaveId: 'player-2' } });

    expect(getSync).toHaveBeenCalledTimes(2);
    expect(store().sync).toEqual(linked);
  });

  it('reloadStatus reports a failure once it runs out of attempts', async () => {
    listDevices.mockRejectedValue(new Error('network'));
    await store().reloadStatus();
    expect(store()).toMatchObject({
      error: 'Status reload failed',
      toast: 'Status reload failed',
    });
  });
});

describe('holds and sessions', () => {
  it('house catchup returns to live when its window ends', () => {
    vi.useFakeTimers();
    store().beginHouseCatchup(['player-1'], 1000);
    expect(store().houseSession.phase).toBe('catchup');
    vi.advanceTimersByTime(1000);
    expect(store().houseSession).toEqual(LIVE_HOUSE_SESSION);

    store().beginHouseCatchup([]);
    expect(store().houseSession).toEqual(LIVE_HOUSE_SESSION);
  });

  it('holdAllVolumes covers every player and the global slider', () => {
    store().setFleet([base, second]);
    store().holdAllVolumes(1000);
    expect(Object.keys(store().volumeHoldUntil)).toEqual(['player-1', 'player-2']);
    expect(store().globalVolumeHoldUntil).toBeGreaterThan(Date.now());

    store().holdVolumes([]);
    expect(Object.keys(store().volumeHoldUntil)).toHaveLength(2);
  });

  it('simple setters store what they are given', () => {
    store().setConnection('live');
    store().setHealth(health);
    expect(store().connection).toBe('live');
    expect(store().health).toBe(health);
  });
});
