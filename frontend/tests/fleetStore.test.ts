import { beforeEach, describe, expect, it } from 'vitest';
import { LIVE_HOUSE_SESSION } from '@/lib/houseSession';
import { useFleetStore } from '@/store/fleetStore';
import type { PlayerStatus } from '@/api/types';

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

describe('fleetStore', () => {
  beforeEach(() => {
    useFleetStore.setState({
      devices: [],
      discoveredAt: null,
      discoveryMethod: '',
      sync: null,
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
    useFleetStore.getState().beginHouseCatchup([]);
  });

  it('sets fleet devices', () => {
    useFleetStore.getState().setFleet([sample], 123);
    const state = useFleetStore.getState();
    expect(state.devices).toHaveLength(1);
    expect(state.discoveredAt).toBe(123);
    expect(state.loading).toBe(false);
  });

  it('sets all volumes locally', () => {
    useFleetStore.getState().setFleet([sample, { ...sample, id: 'player-2', volume: 5 }]);
    useFleetStore.getState().setAllVolumesLocal(42);
    expect(useFleetStore.getState().devices.every((d) => d.volume === 42)).toBe(true);
  });

  it('preserves local volume while hold is active', () => {
    useFleetStore.getState().setFleet([sample]);
    useFleetStore.getState().holdVolume('player-1', 10_000);
    useFleetStore.getState().patchDevice('player-1', { volume: 55 });
    useFleetStore.getState().setFleet([{ ...sample, volume: 9, state: 'stop' }]);
    expect(useFleetStore.getState().devices[0].volume).toBe(55);
  });

  it('preserves optimistic mute while mute hold is active', () => {
    useFleetStore.getState().setFleet([sample]);
    useFleetStore.getState().holdMute('player-1');
    useFleetStore.getState().patchDevice('player-1', { muted: true, volume: 0 });
    useFleetStore.getState().setFleet([{ ...sample, muted: false, volume: 20 }]);
    expect(useFleetStore.getState().devices[0].muted).toBe(true);
    expect(useFleetStore.getState().devices[0].volume).toBe(0);
  });

  it('does not freeze mute during transport hold', () => {
    useFleetStore.getState().setFleet([sample]);
    useFleetStore.getState().holdPlayback('player-1', 10_000);
    useFleetStore.getState().setFleet([{ ...sample, muted: true, volume: 0 }]);
    expect(useFleetStore.getState().devices[0].muted).toBe(true);
    expect(useFleetStore.getState().devices[0].volume).toBe(0);
  });

  it('keeps now-playing through an empty poll while playback is held', () => {
    const playing = {
      ...sample,
      image: 'http://art/a.jpg',
      totlen: 200,
      secs: 40,
      state: 'play',
    };
    useFleetStore.getState().setFleet([playing]);
    useFleetStore.getState().holdPlayback('player-1', 10_000);
    useFleetStore.getState().setFleet([
      {
        ...playing,
        track: '',
        artist: '',
        album: '',
        image: '',
        totlen: 0,
        secs: 0,
        state: 'stop',
      },
    ]);
    const device = useFleetStore.getState().devices[0];
    expect(device.track).toBe('Track');
    expect(device.artist).toBe('Artist');
    expect(device.image).toBe('http://art/a.jpg');
    expect(device.totlen).toBe(200);
    expect(device.secs).toBe(40);
    expect(device.state).toBe('play');
  });

  it('accepts a new track while playback is held', () => {
    useFleetStore.getState().setFleet([{ ...sample, totlen: 200, secs: 40, state: 'play' }]);
    useFleetStore.getState().holdPlayback('player-1', 10_000);
    useFleetStore.getState().setFleet([
      { ...sample, track: 'Next', artist: 'Other', totlen: 180, secs: 1, state: 'play' },
    ]);
    const device = useFleetStore.getState().devices[0];
    expect(device.track).toBe('Next');
    expect(device.secs).toBe(1);
    expect(device.totlen).toBe(180);
  });

  it('keeps artwork through a new track while playback is held', () => {
    useFleetStore.getState().setFleet([
      { ...sample, image: 'http://art/a.jpg', totlen: 200, secs: 40, state: 'play' },
    ]);
    useFleetStore.getState().holdPlayback('player-1', 10_000);
    useFleetStore.getState().setFleet([
      {
        ...sample,
        track: 'Next',
        artist: 'Other',
        image: 'http://art/b.jpg',
        totlen: 180,
        secs: 1,
        state: 'play',
      },
    ]);
    const device = useFleetStore.getState().devices[0];
    expect(device.track).toBe('Next');
    expect(device.image).toBe('http://art/a.jpg');
  });

  it('keeps duration when a new track has no totlen yet', () => {
    useFleetStore.getState().setFleet([
      { ...sample, totlen: 200, secs: 40, state: 'play', can_seek: true },
    ]);
    useFleetStore.getState().holdPlayback('player-1', 10_000);
    useFleetStore.getState().setFleet([
      {
        ...sample,
        track: 'Next',
        artist: 'Other',
        totlen: 0,
        secs: 0,
        state: 'play',
        can_seek: false,
      },
    ]);
    const device = useFleetStore.getState().devices[0];
    expect(device.track).toBe('Next');
    expect(device.totlen).toBe(200);
    expect(device.can_seek).toBe(false);
    expect(device.secs).toBe(0);
  });

  it('pins house catchup membership across skip', () => {
    useFleetStore.getState().beginHouseCatchup(['1', '2']);
    expect(useFleetStore.getState().houseSession).toEqual({
      phase: 'catchup',
      memberIds: ['1', '2'],
    });
  });

  it('stop replaces catchup with a stopped session', () => {
    useFleetStore.getState().beginHouseCatchup(['1', '2']);
    useFleetStore.getState().beginHouseStopped();
    expect(useFleetStore.getState().houseSession).toEqual({
      phase: 'stopped',
      memberIds: [],
    });
  });

  it('starts house catchup when playback starts', async () => {
    useFleetStore.getState().setFleet([sample]);
    useFleetStore.getState().beginHouseStopped();
    await useFleetStore.getState().control('player-1', async () => undefined, { state: 'play' });
    expect(useFleetStore.getState().houseSession.phase).toBe('catchup');
    expect(useFleetStore.getState().houseSession.memberIds).toContain('player-1');
  });

  it('holds playback for skip with no optimistic patch', async () => {
    useFleetStore.getState().setFleet([sample]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const finished = useFleetStore.getState().control('player-1', () => gate);
    expect(useFleetStore.getState().playbackHoldUntil['player-1']).toBeGreaterThan(Date.now());
    release();
    await finished;
    expect(useFleetStore.getState().playbackHoldUntil['player-1']).toBeGreaterThan(Date.now());
  });

  it('does not hold playback for a volume-only patch', async () => {
    useFleetStore.getState().setFleet([sample]);
    await useFleetStore.getState().control('player-1', async () => undefined, { volume: 40 });
    expect(useFleetStore.getState().playbackHoldUntil['player-1'] ?? 0).toBe(0);
    expect(useFleetStore.getState().devices[0].volume).toBe(40);
  });

  it('clears leftover SYNCED when the runtime group snapshot is empty', () => {
    const follower = {
      ...sample,
      id: 'player-2',
      name: 'Den',
      sync_role: 'synced' as const,
      master: '192.168.1.10:11000',
    };
    useFleetStore.getState().setFleet([sample, follower]);
    useFleetStore.getState().setSync({ groups: [], standalone_ids: [sample.id, follower.id] });
    const den = useFleetStore.getState().devices.find((d) => d.id === 'player-2');
    expect(den?.sync_role).toBe('standalone');
    expect(den?.master).toBe('');
  });

  it('ignores a late group snapshot while an ungroup hold is active', () => {
    useFleetStore.getState().setSync({ groups: [], standalone_ids: [sample.id] });
    useFleetStore.getState().holdSync(10_000);
    useFleetStore.getState().setSync({
      groups: [
        {
          primary_id: sample.id,
          primary_name: sample.name,
          primary_ip: sample.ip,
          primary_endpoint: `${sample.ip}:11000`,
          group: '',
          slave_ids: ['player-2'],
          slave_names: ['Den'],
        },
      ],
      standalone_ids: [],
    });
    expect(useFleetStore.getState().sync?.groups).toEqual([]);
  });
});
