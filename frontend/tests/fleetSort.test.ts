import { describe, expect, it } from 'vitest';
import type { PlayerStatus } from '@/api/types';
import {
  fleetSortLabel,
  nextFleetSortMode,
  sortBySyncGroup,
  sortDevices,
} from '@/lib/fleetSort';

function player(partial: Partial<PlayerStatus> & Pick<PlayerStatus, 'id' | 'name'>): PlayerStatus {
  return {
    ip: partial.ip ?? `10.0.0.${partial.id}`,
    model: '',
    brand: '',
    full_model: '',
    device_class: '',
    mac: '',
    status: 'online',
    state: 'stop',
    service: '',
    service_id: '',
    volume: 20,
    muted: false,
    db: '',
    fw: '',
    master: partial.master ?? '',
    group: '',
    group_volume: null,
    slaves: partial.slaves ?? [],
    sync_role: partial.sync_role ?? 'standalone',
    battery: null,
    track: '',
    artist: '',
    album: '',
    quality: '',
    stream_format: '',
    image: '',
    secs: 0,
    totlen: 0,
    can_seek: false,
    input_type_index: '',
    consecutive_failures: 0,
    last_seen: null,
    ...partial,
  };
}

describe('fleetSort', () => {
  it('sorts alphabetically by name', () => {
    const devices = [
      player({ id: '2', name: 'Patio' }),
      player({ id: '1', name: 'Kitchen' }),
    ];
    expect(sortDevices(devices, 'name').map((d) => d.name)).toEqual([
      'Kitchen',
      'Patio',
    ]);
  });

  it('clusters sync groups with primary then followers', () => {
    const devices = [
      player({ id: 'k', name: 'Kitchen', sync_role: 'synced', master: '10.0.0.1', ip: '10.0.0.2' }),
      player({
        id: 'l',
        name: 'Living',
        sync_role: 'primary',
        ip: '10.0.0.1',
        slaves: ['10.0.0.2', '10.0.0.3'],
      }),
      player({ id: 'p', name: 'Patio', sync_role: 'standalone', ip: '10.0.0.9' }),
      player({ id: 'r', name: 'Roaming', sync_role: 'synced', master: '10.0.0.1', ip: '10.0.0.3' }),
      player({
        id: 'c',
        name: 'C658',
        sync_role: 'primary',
        ip: '10.0.0.5',
        slaves: ['10.0.0.6'],
      }),
      player({ id: 'rec', name: 'Rec', sync_role: 'synced', master: '10.0.0.5', ip: '10.0.0.6' }),
    ];

    expect(sortBySyncGroup(devices).map((d) => d.name)).toEqual([
      'C658',
      'Rec',
      'Living',
      'Kitchen',
      'Roaming',
      'Patio',
    ]);
  });

  it('groups a follower its lead lists even before the follower reports the lead', () => {
    const devices = [
      player({ id: 'a', name: 'Alpha', sync_role: 'primary', ip: '10.0.0.1', slaves: ['10.0.0.2'] }),
      player({ id: 'b', name: 'Bravo', sync_role: 'synced', master: '10.0.0.1', ip: '10.0.0.2' }),
      player({ id: 'c', name: 'Charlie', sync_role: 'primary', ip: '10.0.0.3', slaves: ['10.0.0.9'] }),
      player({ id: 'd', name: 'Delta', sync_role: 'standalone', ip: '10.0.0.4' }),
      // Joined Charlie, but its own record has not caught up yet.
      player({ id: 'z', name: 'Zulu', sync_role: 'standalone', master: '', ip: '10.0.0.9' }),
    ];

    expect(sortBySyncGroup(devices).map((d) => d.name)).toEqual([
      'Alpha',
      'Bravo',
      'Charlie',
      'Zulu',
      'Delta',
    ]);
  });

  it('toggles sort mode labels', () => {
    expect(nextFleetSortMode('name')).toBe('sync');
    expect(nextFleetSortMode('sync')).toBe('name');
    expect(fleetSortLabel('name')).toBe('A–Z');
    expect(fleetSortLabel('sync')).toBe('Sync');
  });
});
