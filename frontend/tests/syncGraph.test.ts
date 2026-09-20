import { describe, expect, it } from 'vitest';
import type { PlayerStatus, SyncState } from '@/api/types';
import { displaySyncRole, dropStaleFollowerClaims } from '@/lib/syncGraph';

function player(partial: Partial<PlayerStatus> & Pick<PlayerStatus, 'id'>): PlayerStatus {
  return {
    ip: '10.0.0.1',
    name: partial.id,
    model: 'NODE',
    brand: 'Bluesound',
    full_model: 'Bluesound NODE',
    device_class: 'streamer',
    mac: '',
    status: 'online',
    state: 'stop',
    service: '',
    service_id: '',
    volume: 10,
    muted: false,
    db: '',
    fw: '',
    master: '',
    group: '',
    group_volume: null,
    slaves: [],
    sync_role: 'standalone',
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
    last_seen: 1,
    ...partial,
  };
}

describe('syncGraph', () => {
  it('keeps device role when no sync snapshot is loaded yet', () => {
    const follower = player({ id: 'patio', sync_role: 'synced', master: '10.0.0.1:11000' });
    expect(displaySyncRole(follower, null)).toBe('synced');
    expect(dropStaleFollowerClaims([follower], null)[0].sync_role).toBe('synced');
  });

  it('hides leftover SYNCED once the runtime group is gone', () => {
    const lead = player({ id: 'living', name: 'Living', sync_role: 'standalone' });
    const patio = player({
      id: 'patio',
      name: 'Patio',
      sync_role: 'synced',
      master: '10.0.0.1:11000',
    });
    const sync: SyncState = { groups: [], standalone_ids: ['living', 'patio'] };
    expect(displaySyncRole(patio, sync)).toBe('standalone');
    const next = dropStaleFollowerClaims([lead, patio], sync);
    expect(next[1].sync_role).toBe('standalone');
    expect(next[1].master).toBe('');
  });

  it('keeps a confirmed follower and orphan listed in the graph', () => {
    const patio = player({ id: 'patio', sync_role: 'synced', master: '10.0.0.8:11000' });
    const sync: SyncState = {
      groups: [
        {
          primary_id: 'orphan-dead',
          primary_name: 'Offline primary',
          primary_ip: '10.0.0.8',
          primary_endpoint: '10.0.0.8:11000',
          group: '',
          slave_ids: ['patio'],
          slave_names: ['Patio'],
        },
      ],
      standalone_ids: [],
    };
    expect(displaySyncRole(patio, sync)).toBe('synced');
    expect(dropStaleFollowerClaims([patio], sync)[0].sync_role).toBe('synced');
  });
});
