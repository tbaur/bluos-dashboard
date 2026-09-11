import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlayerStatus } from '@/api/types';
import { LIVE_HOUSE_SESSION } from '@/lib/houseSession';
import { useFleetStore } from '@/store/fleetStore';

const listDevices = vi.fn();
const refreshDevices = vi.fn();
const getSync = vi.fn();
const getFleetHealth = vi.fn();
const fleetMute = vi.fn();
const fleetPause = vi.fn();
const fleetStop = vi.fn();

vi.mock('@/api/client', () => ({
  api: {
    listDevices: (...args: unknown[]) => listDevices(...args),
    refreshDevices: (...args: unknown[]) => refreshDevices(...args),
    getSync: (...args: unknown[]) => getSync(...args),
    getFleetHealth: (...args: unknown[]) => getFleetHealth(...args),
    fleetMute: (...args: unknown[]) => fleetMute(...args),
    fleetPause: (...args: unknown[]) => fleetPause(...args),
    fleetStop: (...args: unknown[]) => fleetStop(...args),
  },
}));

const sample: PlayerStatus = {
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
  volume: 20,
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

function reset() {
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
}

describe('fleetStore remote sync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reset();
    getSync.mockResolvedValue({ groups: [], standalone_ids: [] });
    getFleetHealth.mockResolvedValue(null);
  });

  it('load merges holds instead of overwriting local state', async () => {
    useFleetStore.getState().setFleet([sample]);
    useFleetStore.getState().holdVolume('player-1', 10_000);
    useFleetStore.getState().patchDevice('player-1', { volume: 55 });

    listDevices.mockResolvedValue({
      devices: [{ ...sample, volume: 9 }],
      discovered_at: 5,
      discovery_method: 'mdns',
    });
    await useFleetStore.getState().load();

    // Server said 9, but the user is mid-drag at 55.
    expect(useFleetStore.getState().devices[0].volume).toBe(55);
  });

  it('load keeps the fleet painted while polling with devices present', async () => {
    useFleetStore.getState().setFleet([sample]);
    let release!: (value: unknown) => void;
    listDevices.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );

    const inFlight = useFleetStore.getState().load();
    // The 5s SSE-outage poll must not blank the table.
    expect(useFleetStore.getState().loading).toBe(false);

    release({ devices: [sample], discovered_at: 5, discovery_method: 'mdns' });
    await inFlight;
    expect(useFleetStore.getState().loading).toBe(false);
  });

  it('load still shows the discovery placeholder on a cold start', async () => {
    let release!: (value: unknown) => void;
    listDevices.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );

    const inFlight = useFleetStore.getState().load();
    expect(useFleetStore.getState().loading).toBe(true);

    release({ devices: [sample], discovered_at: 5, discovery_method: 'mdns' });
    await inFlight;
    expect(useFleetStore.getState().loading).toBe(false);
  });

  it('refresh merges holds instead of overwriting local state', async () => {
    useFleetStore.getState().setFleet([sample]);
    useFleetStore.getState().holdMute('player-1');
    useFleetStore.getState().patchDevice('player-1', { muted: true, volume: 0 });

    refreshDevices.mockResolvedValue({
      devices: [{ ...sample, muted: false, volume: 20 }],
      discovered_at: 7,
      discovery_method: 'both',
    });
    await useFleetStore.getState().refresh();

    expect(useFleetStore.getState().devices[0].muted).toBe(true);
    expect(useFleetStore.getState().devices[0].volume).toBe(0);
  });

  it('drops hold and volume memory for devices that left the fleet', () => {
    const second = { ...sample, id: 'player-2', volume: 30 };
    useFleetStore.getState().setFleet([sample, second]);
    useFleetStore.getState().holdVolume('player-2', 10_000);
    useFleetStore.getState().patchDevice('player-2', { volume: 44 });
    expect(useFleetStore.getState().volumeHoldUntil['player-2']).toBeGreaterThan(0);

    useFleetStore.getState().setFleet([sample]);
    expect(useFleetStore.getState().volumeHoldUntil['player-2']).toBeUndefined();
    expect(useFleetStore.getState().lastAudibleVolume['player-2']).toBeUndefined();
  });

  it('reverts mute-all when the API call fails', async () => {
    useFleetStore.getState().setFleet([{ ...sample, volume: 20, muted: false }]);
    fleetMute.mockRejectedValue(new Error('boom'));

    await useFleetStore.getState().fleetMuteAll(true);

    const device = useFleetStore.getState().devices[0];
    expect(device.muted).toBe(false);
    expect(device.volume).toBe(20);
    expect(useFleetStore.getState().muteHoldUntil['player-1']).toBeUndefined();
    expect(useFleetStore.getState().toast).toBe('Fleet mute failed');
  });

  it('reverts pause-all when the API call fails', async () => {
    useFleetStore.getState().setFleet([{ ...sample, state: 'play' }]);
    fleetPause.mockRejectedValue(new Error('boom'));

    await useFleetStore.getState().fleetPauseAll();

    expect(useFleetStore.getState().devices[0].state).toBe('play');
    expect(useFleetStore.getState().playbackHoldUntil['player-1']).toBeUndefined();
    expect(useFleetStore.getState().toast).toBe('Pause all failed');
  });

  it('reverts stop-all and the house session when the API call fails', async () => {
    useFleetStore.getState().setFleet([{ ...sample, state: 'play' }]);
    fleetStop.mockRejectedValue(new Error('boom'));

    await useFleetStore.getState().fleetStopAll();

    expect(useFleetStore.getState().devices[0].state).toBe('play');
    expect(useFleetStore.getState().houseSession).toEqual(LIVE_HOUSE_SESSION);
    expect(useFleetStore.getState().toast).toBe('Stop all failed');
  });

  it('keeps optimistic state when a fleet action succeeds', async () => {
    useFleetStore.getState().setFleet([{ ...sample, state: 'play' }]);
    fleetPause.mockResolvedValue({ succeeded: 1, failed: 0 });

    await useFleetStore.getState().fleetPauseAll();

    expect(useFleetStore.getState().devices[0].state).toBe('pause');
    expect(useFleetStore.getState().toast).toBeNull();
  });
});
