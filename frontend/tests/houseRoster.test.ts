import { describe, expect, it } from 'vitest';
import type { PlayerStatus } from '@/api/types';
import type { HouseStreamSource } from '@/lib/fleetStatus';
import {
  alsoPlayingMeta,
  focusedSource,
  otherStreams,
  rosterHeading,
  speakerRoleLabel,
  speakerRoster,
  streamPlaceLabel,
} from '@/lib/houseRoster';

function source(partial: Partial<HouseStreamSource> & Pick<HouseStreamSource, 'key'>): HouseStreamSource {
  return {
    leadId: null,
    primary: 'Track',
    detail: '',
    image: '',
    album: '',
    roomNames: [],
    playing: true,
    memberIds: [],
    ...partial,
  };
}

function device(
  partial: Partial<PlayerStatus> & Pick<PlayerStatus, 'id' | 'name'>,
): PlayerStatus {
  return {
    ip: '10.0.0.1',
    model: 'NODE',
    brand: 'Bluesound',
    full_model: 'NODE',
    device_class: 'streamer',
    mac: '',
    status: 'online',
    state: 'play',
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

describe('speakerRoleLabel', () => {
  it('names a lone player without implying a sync group', () => {
    expect(speakerRoleLabel('standalone', 1)).toBe('Playing');
    expect(speakerRoleLabel('primary', 1)).toBe('Lead');
  });

  it('separates sync followers from players streaming the same audio on their own', () => {
    expect(speakerRoleLabel('primary', 7)).toBe('Lead');
    expect(speakerRoleLabel('synced', 7)).toBe('Synced');
    expect(speakerRoleLabel('standalone', 7)).toBe('Direct');
  });
});

describe('rosterHeading', () => {
  it('names a player, a BluOS group, and a shared stream', () => {
    expect(rosterHeading([{ role: 'standalone' }])).toBe('Player');
    expect(rosterHeading([{ role: 'primary' }, { role: 'synced' }])).toBe('In this group');
    expect(rosterHeading([{ role: 'primary' }, { role: 'standalone' }])).toBe('On this stream');
  });
});

describe('streamPlaceLabel', () => {
  it('uses the room name for one player and a count for a stream', () => {
    expect(streamPlaceLabel(1, 'Hallway')).toBe('Hallway');
    expect(streamPlaceLabel(7, 'Kitchen')).toBe('7 speakers');
  });
});

describe('speakerRoster', () => {
  it('orders the lead, then synced followers, then direct players', () => {
    const stream = source({
      key: 'house',
      memberIds: ['direct', 'follow', 'lead'],
      roomNames: ['Patio', 'Kitchen', 'Hallway'],
    });
    const rows = speakerRoster(
      stream,
      [
        device({ id: 'direct', name: 'Patio', sync_role: 'standalone', volume: 11 }),
        device({ id: 'follow', name: 'Kitchen', sync_role: 'synced', volume: 22, muted: true }),
        device({ id: 'lead', name: 'Hallway', sync_role: 'primary', volume: 33 }),
      ],
      null,
    );

    expect(rows.map((row) => row.roleLabel)).toEqual(['Lead', 'Synced', 'Direct']);
    expect(rows.map((row) => row.name)).toEqual(['Hallway', 'Kitchen', 'Patio']);
    expect(rows[1]).toMatchObject({ muted: true, volume: 22 });
  });

  it('uses the sync group when a follower still looks standalone', () => {
    const stream = source({
      key: 'pair',
      memberIds: ['follow', 'lead'],
      roomNames: ['Kitchen', 'Hallway'],
    });
    const rows = speakerRoster(
      stream,
      [
        device({ id: 'lead', name: 'Hallway', sync_role: 'primary', volume: 20 }),
        device({ id: 'follow', name: 'Kitchen', sync_role: 'standalone', volume: 20 }),
      ],
      {
        groups: [
          {
            primary_id: 'lead',
            primary_name: 'Hallway',
            primary_ip: '10.0.0.1',
            group: '',
            slave_ids: ['follow'],
            slave_names: ['Kitchen'],
          },
        ],
        standalone_ids: [],
      },
    );

    expect(rows.map((row) => [row.name, row.roleLabel])).toEqual([
      ['Hallway', 'Lead'],
      ['Kitchen', 'Synced'],
    ]);
  });
});

describe('focusedSource', () => {
  it('follows the chosen players after their track key changes', () => {
    const before = [
      source({ key: 'stream:house|artist', memberIds: ['big'], primary: 'House' }),
      source({ key: 'stream:other|artist', memberIds: ['solo'], primary: 'Other' }),
    ];
    expect(focusedSource(before, ['solo'])?.primary).toBe('Other');

    const afterSkip = [
      source({ key: 'stream:house|artist', memberIds: ['big'], primary: 'House' }),
      source({ key: 'stream:next|artist', memberIds: ['solo'], primary: 'Next' }),
    ];
    expect(focusedSource(afterSkip, ['solo'])?.primary).toBe('Next');
    expect(focusedSource(afterSkip, null)?.primary).toBe('House');
  });

  it('follows the lead when direct rooms stay on the old audio', () => {
    const afterSkip = [
      source({
        key: 'stream:old|artist',
        memberIds: ['d1', 'd2', 'd3', 'd4', 'd5'],
        primary: 'Old',
      }),
      source({ key: 'stream:next|artist', memberIds: ['lead', 'follow'], primary: 'Next' }),
    ];
    expect(focusedSource(afterSkip, ['lead'])?.primary).toBe('Next');
  });
});

describe('alsoPlayingMeta', () => {
  it('counts one, a few, and the overflow past three', () => {
    expect(alsoPlayingMeta(0)).toBe('');
    expect(alsoPlayingMeta(1)).toBe('1 other stream');
    expect(alsoPlayingMeta(3)).toBe('3 other streams');
    expect(alsoPlayingMeta(4)).toBe('3 other streams + 1 more');
    expect(alsoPlayingMeta(5)).toBe('3 other streams + 2 more');
  });
});

describe('otherStreams', () => {
  it('omits the stream the house panel is showing', () => {
    const sources = [source({ key: 'a' }), source({ key: 'b' }), source({ key: 'c' })];
    expect(otherStreams(sources, 'b').map((item) => item.key)).toEqual(['a', 'c']);
  });
});
