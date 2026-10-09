import { describe, expect, it } from 'vitest';
import type { PlayerStatus, SyncState } from '@/api/types';
import {
  fleetHasActivePlayback,
  fleetHouseStatus,
  fleetHouseStatusLine,
  houseTransportTargets,
} from '@/lib/fleetStatus';
import { houseCatchupSession, houseStoppedSession } from '@/lib/houseSession';

function player(
  partial: Partial<PlayerStatus> & Pick<PlayerStatus, 'id' | 'name'>,
): PlayerStatus {
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
    last_seen: null,
    ...partial,
  };
}

function syncGroup(
  primaryId: string,
  primaryName: string,
  slaveIds: string[],
  slaveNames: string[],
): SyncState {
  return {
    groups: [
      {
        primary_id: primaryId,
        primary_name: primaryName,
        primary_ip: `10.0.0.${primaryId}`,
        group: '',
        slave_ids: slaveIds,
        slave_names: slaveNames,
      },
    ],
    standalone_ids: [],
  };
}

describe('fleetHouseStatus', () => {
  it('reports all quiet when idle', () => {
    expect(
      fleetHouseStatus(
        [player({ id: '1', name: 'Kitchen' }), player({ id: '2', name: 'Patio' })],
        null,
      ),
    ).toEqual({
      primary: 'All quiet',
      detail: '',
      meta: [],
      isIdle: true,
      isPaused: false,
      hasDominantStream: false,
      image: '',
      leadId: null,
      sourceCount: 0,
      album: '',
      rooms: [],
      sources: [],
    });
  });

  it('puts track/artist first and service second for a dominant stream', () => {
    expect(
      fleetHouseStatus(
        [
          player({
            id: '1',
            name: 'Living Room Speakers',
            state: 'stream',
            service: 'AirPlay',
            track: 'Song',
            artist: 'Artist',
            image: 'http://10.0.0.1/art.jpg',
          }),
          player({ id: '2', name: 'Kitchen' }),
        ],
        null,
      ),
    ).toMatchObject({
      primary: 'Song — Artist',
      detail: 'AirPlay',
      meta: [],
      isIdle: false,
      isPaused: false,
      hasDominantStream: true,
      image: 'http://10.0.0.1/art.jpg',
      leadId: '1',
      sourceCount: 1,
      album: '',
      rooms: ['Living Room Speakers'],
    });
  });

  it('treats one sync group as the house stream without a playing-count chip', () => {
    const status = fleetHouseStatus(
      [
        player({
          id: '1',
          name: 'Hallway Speakers',
          state: 'play',
          service: 'AirPlay',
          sync_role: 'primary',
          slaves: ['10.0.0.2:11000'],
          track: 'Plu2, Lyge, Casa Ley & VKNG',
          artist: 'Plu2, Lyge, Casa Ley & VKNG',
          image: 'http://10.0.0.1/cover.jpg',
        }),
        player({
          id: '2',
          name: 'Kitchen Speakers',
          state: 'stream',
          sync_role: 'synced',
          master: '10.0.0.1:11000',
          track: 'Plu2, Lyge, Casa Ley & VKNG',
          artist: 'Plu2, Lyge, Casa Ley & VKNG',
        }),
        player({
          id: '3',
          name: 'Front Bedroom Speakers',
          state: 'stream',
          sync_role: 'synced',
          master: '10.0.0.1:11000',
          muted: true,
        }),
        player({ id: '4', name: 'Garage', state: 'stop' }),
      ],
      {
        groups: [
          {
            primary_id: '1',
            primary_name: 'Hallway Speakers',
            primary_ip: '10.0.0.1',
            group: '',
            slave_ids: ['2', '3'],
            slave_names: ['Kitchen Speakers', 'Front Bedroom Speakers'],
          },
        ],
        standalone_ids: ['4'],
      },
    );

    expect(status).toMatchObject({
      primary: 'Plu2, Lyge, Casa Ley & VKNG',
      detail: 'AirPlay',
      meta: ['3 playing', 'Synced', '1 muted'],
      isIdle: false,
      hasDominantStream: true,
      image: 'http://10.0.0.1/cover.jpg',
      leadId: '1',
      sourceCount: 1,
    });
  });

  it('uses follower artwork when the primary has none', () => {
    const status = fleetHouseStatus(
      [
        player({
          id: '1',
          name: 'Hallway',
          state: 'play',
          sync_role: 'primary',
          track: 'Track',
          artist: 'Artist',
        }),
        player({
          id: '2',
          name: 'Kitchen',
          state: 'stream',
          sync_role: 'synced',
          master: '10.0.0.1:11000',
          track: 'Track',
          artist: 'Artist',
          image: 'http://10.0.0.2/from-follower.jpg',
        }),
      ],
      syncGroup('1', 'Hallway', ['2'], ['Kitchen']),
    );

    expect(status.hasDominantStream).toBe(true);
    expect(status.image).toBe('http://10.0.0.2/from-follower.jpg');
    expect(status.leadId).toBe('1');
  });

  it('merges parallel endpoints on the same stream without room-count chrome', () => {
    const status = fleetHouseStatus(
      [
        player({
          id: '1',
          name: 'Front Bedroom Speakers',
          state: 'play',
          service: 'AirPlay',
          track: 'Joni',
          artist: 'Moomin',
          image: 'http://art/a.jpg',
        }),
        player({
          id: '2',
          name: 'Hallway Speakers',
          state: 'stream',
          service: 'AirPlay',
          track: 'Joni',
          artist: 'Moomin',
        }),
        player({
          id: '3',
          name: 'Kitchen Speakers',
          state: 'stream',
          service: 'AirPlay',
          track: 'Joni',
          artist: 'Moomin',
        }),
      ],
      null,
    );

    expect(status).toMatchObject({
      hasDominantStream: true,
      sourceCount: 1,
      primary: 'Joni — Moomin',
      detail: 'AirPlay',
      image: 'http://art/a.jpg',
      leadId: '1',
      meta: ['3 playing'],
    });
  });

  it('appends stream format and bitrate when BluOS reports them', () => {
    const status = fleetHouseStatus(
      [
        player({
          id: '1',
          name: 'Kitchen',
          state: 'play',
          service: 'Spotify',
          track: 'Song',
          artist: 'Artist',
          quality: '320000',
          stream_format: 'Ogg Vorbis',
        }),
      ],
      null,
    );

    expect(status.primary).toBe('Song — Artist');
    expect(status.detail).toBe('Spotify / Ogg Vorbis / 320 kbps');
  });

  it('withholds art when two different streams are playing', () => {
    const status = fleetHouseStatus(
      [
        player({
          id: '1',
          name: 'Hallway',
          state: 'play',
          sync_role: 'primary',
          service: 'AirPlay',
          track: 'Party',
          artist: 'A',
          image: 'http://art/party.jpg',
          slaves: ['10.0.0.2:11000'],
        }),
        player({
          id: '2',
          name: 'Kitchen',
          state: 'stream',
          sync_role: 'synced',
          master: '10.0.0.1:11000',
          track: 'Party',
          artist: 'A',
        }),
        player({
          id: '3',
          name: 'Bedroom',
          state: 'play',
          service: 'TIDAL connect',
          track: 'Quiet',
          artist: 'B',
          image: 'http://art/quiet.jpg',
        }),
      ],
      {
        groups: [
          {
            primary_id: '1',
            primary_name: 'Hallway',
            primary_ip: '10.0.0.1',
            group: '',
            slave_ids: ['2'],
            slave_names: ['Kitchen'],
          },
        ],
        standalone_ids: ['3'],
      },
    );

    expect(status).toMatchObject({
      primary: '2 sources',
      detail: 'Mixed playback across the house',
      hasDominantStream: false,
      image: '',
      leadId: null,
      sourceCount: 2,
      meta: ['3 playing', 'Synced'],
    });
  });

  it('withholds art when two inferred sync groups play different tracks', () => {
    const status = fleetHouseStatus(
      [
        player({
          id: '1',
          name: 'Small',
          state: 'play',
          sync_role: 'primary',
          track: 'A',
          artist: 'A',
          slaves: ['10.0.0.2:11000'],
        }),
        player({
          id: '2',
          name: 'SmallFollower',
          state: 'stream',
          sync_role: 'synced',
          master: '10.0.0.1:11000',
          track: 'A',
          artist: 'A',
        }),
        player({
          id: '3',
          name: 'Hallway',
          state: 'play',
          sync_role: 'primary',
          track: 'B',
          artist: 'B',
          image: 'http://art/b.jpg',
          slaves: ['10.0.0.4:11000', '10.0.0.5:11000'],
        }),
        player({
          id: '4',
          name: 'Kitchen',
          state: 'stream',
          sync_role: 'synced',
          master: '10.0.0.3:11000',
          track: 'B',
          artist: 'B',
        }),
        player({
          id: '5',
          name: 'Patio',
          state: 'stream',
          sync_role: 'synced',
          master: '10.0.0.3:11000',
          track: 'B',
          artist: 'B',
        }),
      ],
      null,
    );

    expect(status.hasDominantStream).toBe(false);
    expect(status.sourceCount).toBe(2);
    expect(status.image).toBe('');
  });

  it('formats a tooltip line', () => {
    expect(
      fleetHouseStatusLine(
        [
          player({
            id: '1',
            name: 'Living',
            state: 'stream',
            service: 'TIDAL connect',
            track: 'Sapana',
          }),
        ],
        null,
      ),
    ).toBe('Sapana / TIDAL connect');
  });

  it('detects active playback including connecting', () => {
    expect(fleetHasActivePlayback([player({ id: '1', name: 'A' })])).toBe(false);
    expect(
      fleetHasActivePlayback([player({ id: '1', name: 'A', state: 'stream' })]),
    ).toBe(true);
    expect(
      fleetHasActivePlayback([player({ id: '1', name: 'A', state: 'connecting' })]),
    ).toBe(true);
  });

  it('clusters orphan sync members as one dominant stream', () => {
    const status = fleetHouseStatus(
      [
        player({
          id: '2',
          name: 'Kitchen',
          state: 'play',
          service: 'AirPlay',
          track: 'Song',
          artist: 'Artist',
          sync_role: 'synced',
          master: '10.0.0.9:11000',
          image: 'http://art/a.jpg',
        }),
        player({
          id: '3',
          name: 'Patio',
          state: 'stream',
          service: 'AirPlay',
          track: 'Song',
          artist: 'Artist',
          sync_role: 'synced',
          master: '10.0.0.9:11000',
        }),
      ],
      {
        groups: [
          {
            primary_id: 'orphan-dead',
            primary_name: 'Offline primary',
            primary_ip: '10.0.0.9',
            primary_endpoint: '10.0.0.9:11000',
            group: '',
            slave_ids: ['2', '3'],
            slave_names: ['Kitchen', 'Patio'],
          },
        ],
        standalone_ids: [],
      },
    );
    expect(status.hasDominantStream).toBe(true);
    expect(status.sourceCount).toBe(1);
    expect(status.primary).toBe('Song — Artist');
    expect(status.meta).toContain('2 playing');
  });

  it('keeps a paused house stream instead of going idle', () => {
    const status = fleetHouseStatus(
      [
        player({
          id: '1',
          name: 'Kitchen',
          state: 'pause',
          service: 'TIDAL connect',
          track: 'Sapana',
          artist: 'Artist',
          album: 'Night',
          image: 'http://art/a.jpg',
        }),
        player({ id: '2', name: 'Patio', state: 'stop' }),
      ],
      null,
    );
    expect(status).toMatchObject({
      primary: 'Sapana — Artist',
      detail: 'TIDAL connect',
      isIdle: false,
      isPaused: true,
      hasDominantStream: true,
      leadId: '1',
      album: 'Night',
      rooms: ['Kitchen'],
      sourceCount: 1,
    });
    expect(status.meta).toContain('Paused');
  });

  it('lists mixed sources so the remote can focus one', () => {
    const status = fleetHouseStatus(
      [
        player({
          id: '1',
          name: 'Hallway',
          state: 'play',
          track: 'Party',
          artist: 'A',
          image: 'http://art/party.jpg',
        }),
        player({
          id: '2',
          name: 'Bedroom',
          state: 'play',
          track: 'Quiet',
          artist: 'B',
          image: 'http://art/quiet.jpg',
        }),
      ],
      null,
    );
    expect(status.sourceCount).toBe(2);
    expect(status.hasDominantStream).toBe(false);
    expect(status.sources).toHaveLength(2);
    expect(status.sources.map((s) => s.primary).sort()).toEqual(['Party — A', 'Quiet — B']);
  });

  it('keeps one house stream while AirPlay rooms are playing without titles yet', () => {
    const status = fleetHouseStatus(
      [
        player({ id: '1', name: 'Hallway', state: 'connecting' }),
        player({ id: '2', name: 'Kitchen', state: 'stream' }),
        player({ id: '3', name: 'Patio', state: 'play' }),
      ],
      null,
    );
    expect(status.sourceCount).toBe(1);
    expect(status.hasDominantStream).toBe(true);
    expect(status.primary).toBe('Playing');
    expect(status.rooms.sort()).toEqual(['Hallway', 'Kitchen', 'Patio']);
  });

  it('does not treat connecting-only rooms as a house stream', () => {
    const status = fleetHouseStatus(
      [
        player({
          id: '1',
          name: 'Hallway',
          state: 'connecting',
          track: 'unspoken',
          artist: 'A',
        }),
        player({ id: '2', name: 'Kitchen', state: 'connecting' }),
        player({ id: '3', name: 'Patio', state: 'stop' }),
      ],
      null,
    );
    expect(status.isIdle).toBe(true);
    expect(status.sourceCount).toBe(0);
    expect(status.primary).toBe('All quiet');
  });

  it('stays idle after stop even with leftover paused metadata', () => {
    const status = fleetHouseStatus(
      [
        player({
          id: '1',
          name: 'Hallway',
          state: 'pause',
          track: 'unspoken',
          artist: 'A',
        }),
        player({ id: '2', name: 'Kitchen', state: 'connecting' }),
      ],
      null,
      houseStoppedSession(),
    );
    expect(status.isIdle).toBe(true);
    expect(status.primary).toBe('All quiet');
  });

  it('shows the house stream if stop failed and rooms are still playing', () => {
    const status = fleetHouseStatus(
      [
        player({
          id: '1',
          name: 'Hallway',
          state: 'play',
          track: 'unspoken',
          artist: 'A',
        }),
      ],
      null,
      houseStoppedSession(),
    );
    expect(status.isIdle).toBe(false);
    expect(status.primary).toBe('unspoken — A');
  });

  it('folds rooms still missing metadata into the titled house stream', () => {
    const status = fleetHouseStatus(
      [
        player({
          id: '1',
          name: 'Hallway',
          state: 'play',
          track: 'unspoken',
          artist: 'A',
          image: 'http://art/a.jpg',
        }),
        player({ id: '2', name: 'Kitchen', state: 'connecting' }),
        player({ id: '3', name: 'Office', state: 'stream' }),
      ],
      null,
    );
    expect(status.sourceCount).toBe(1);
    expect(status.primary).toBe('unspoken — A');
    expect(status.rooms.sort()).toEqual(['Hallway', 'Kitchen', 'Office']);
  });

  it('keeps connecting rooms on the house stream even with leftover titles', () => {
    const status = fleetHouseStatus(
      [
        player({
          id: '1',
          name: 'Hallway',
          state: 'play',
          track: 'unspoken',
          artist: 'A',
          image: 'http://art/a.jpg',
        }),
        player({
          id: '2',
          name: 'Kitchen',
          state: 'connecting',
          track: 'old song',
          artist: 'B',
        }),
        player({
          id: '3',
          name: 'Office',
          state: 'connecting',
          track: 'unspoken',
          artist: 'A',
        }),
      ],
      null,
    );
    expect(status.sourceCount).toBe(1);
    expect(status.hasDominantStream).toBe(true);
    expect(status.primary).toBe('unspoken — A');
    expect(status.rooms.sort()).toEqual(['Hallway', 'Kitchen', 'Office']);
  });

  it('merges the same track when only some rooms have reported a service yet', () => {
    const status = fleetHouseStatus(
      [
        player({
          id: '1',
          name: 'Hallway',
          state: 'play',
          service: 'AirPlay',
          track: 'unspoken',
          artist: 'A',
        }),
        player({
          id: '2',
          name: 'Kitchen',
          state: 'stream',
          track: 'unspoken',
          artist: 'A',
        }),
      ],
      null,
    );
    expect(status.sourceCount).toBe(1);
    expect(status.primary).toBe('unspoken — A');
    expect(status.detail).toBe('AirPlay');
  });

  it('targets the sync primary, or the stream lead for ungrouped rooms', () => {
    const grouped = [
      player({
        id: '1',
        name: 'Hallway',
        sync_role: 'primary',
        state: 'play',
        track: 'A',
        artist: 'A',
      }),
      player({
        id: '2',
        name: 'Kitchen',
        sync_role: 'synced',
        master: '10.0.0.1:11000',
        state: 'stream',
        track: 'A',
        artist: 'A',
      }),
    ];
    const groupedStatus = fleetHouseStatus(grouped, syncGroup('1', 'Hallway', ['2'], ['Kitchen']));
    expect(houseTransportTargets(groupedStatus.sources[0], grouped)).toEqual(['1']);

    const parallel = [
      player({ id: '1', name: 'Front', state: 'play', track: 'Joni', artist: 'M' }),
      player({ id: '2', name: 'Hall', state: 'stream', track: 'Joni', artist: 'M' }),
    ];
    const parallelStatus = fleetHouseStatus(parallel, null);
    expect(houseTransportTargets(parallelStatus.sources[0], parallel)).toEqual(['1']);
  });

  it('collapses a skip split back into one house stream', () => {
    const devices = [
      player({
        id: '1',
        name: 'Hallway',
        state: 'play',
        track: 'Next',
        artist: 'B',
        image: 'http://art/b.jpg',
      }),
      player({
        id: '2',
        name: 'Kitchen',
        state: 'play',
        track: 'Sapana',
        artist: 'Artist',
      }),
    ];
    const split = fleetHouseStatus(devices, null);
    expect(split.sourceCount).toBe(2);
    const held = fleetHouseStatus(devices, null, houseCatchupSession(['1', '2']));
    expect(held.sourceCount).toBe(1);
    expect(held.hasDominantStream).toBe(true);
    expect(held.primary).toBe('Next — B');
    expect(held.rooms.sort()).toEqual(['Hallway', 'Kitchen']);
    expect(held.image).toBe('http://art/b.jpg');
  });

  it('keeps held rooms when some members stop during skip', () => {
    const devices = [
      player({
        id: '1',
        name: 'Hallway',
        state: 'play',
        track: 'Next',
        artist: 'B',
        image: 'http://art/b.jpg',
      }),
      player({ id: '2', name: 'Kitchen', state: 'stop' }),
    ];
    const status = fleetHouseStatus(devices, null);
    expect(status.rooms).toEqual(['Hallway']);
    const held = fleetHouseStatus(devices, null, houseCatchupSession(['1', '2']));
    expect(held.rooms.sort()).toEqual(['Hallway', 'Kitchen']);
    expect(held.sourceCount).toBe(1);
  });

  it('does not collapse when a new room is a real second source', () => {
    const devices = [
      player({
        id: '1',
        name: 'Hallway',
        state: 'play',
        track: 'Sapana',
        artist: 'Artist',
      }),
      player({
        id: '3',
        name: 'Bedroom',
        state: 'play',
        track: 'Quiet',
        artist: 'B',
      }),
    ];
    const held = fleetHouseStatus(devices, null, houseCatchupSession(['1', '2']));
    expect(held.sourceCount).toBe(2);
    expect(held.hasDominantStream).toBe(false);
  });

  it('keeps another paused stream visible during play catchup', () => {
    const devices = [
      player({ id: '1', name: 'Hallway', state: 'play', track: 'A', artist: 'A' }),
      player({ id: '2', name: 'Kitchen', state: 'pause', track: 'B', artist: 'B' }),
    ];
    const status = fleetHouseStatus(devices, null, houseCatchupSession(['1']));
    expect(status.sourceCount).toBe(2);
    expect(status.sources.map((source) => source.primary).sort()).toEqual(['A', 'B']);
  });

  it('pins connecting rooms as one stream during play catchup', () => {
    const status = fleetHouseStatus(
      [
        player({ id: '1', name: 'Hallway', state: 'connecting' }),
        player({ id: '2', name: 'Kitchen', state: 'connecting' }),
        player({ id: '3', name: 'Patio', state: 'play' }),
      ],
      null,
      houseCatchupSession(['1', '2', '3']),
    );
    expect(status.sourceCount).toBe(1);
    expect(status.hasDominantStream).toBe(true);
    expect(status.rooms.sort()).toEqual(['Hallway', 'Kitchen', 'Patio']);
  });
});
