import { describe, expect, it } from 'vitest';
import type { PlayerStatus, SyncGroup } from '@/api/types';
import {
  availableFollowers,
  freeRooms,
  occupiedRoomIds,
  roomCountLabel,
  syncStateFor,
  withFollower,
  withoutFollowers,
} from '@/lib/syncGroups';

function room(id: string, name: string, over: Partial<PlayerStatus> = {}): PlayerStatus {
  return {
    id,
    name,
    ip: `10.0.0.${id.charCodeAt(0)}`,
    port: 11000,
    sync_role: 'standalone',
    group: '',
    slaves: [],
    ...over,
  } as PlayerStatus;
}

const alpha = room('a', 'Alpha');
const bravo = room('b', 'Bravo');
const charlie = room('c', 'Charlie');

const group: SyncGroup = {
  primary_id: 'a',
  primary_name: 'Alpha',
  primary_ip: alpha.ip,
  primary_endpoint: `${alpha.ip}:11000`,
  group: '',
  slave_ids: ['b'],
  slave_names: ['Bravo'],
};

describe('syncGroups', () => {
  it('collects every lead and follower', () => {
    expect([...occupiedRoomIds([group])].sort()).toEqual(['a', 'b']);
  });

  it('lists free rooms A–Z, preferring the API standalone list', () => {
    const devices = [charlie, bravo, alpha];
    expect(freeRooms(devices, null, []).map((d) => d.id)).toEqual(['a', 'b', 'c']);
    expect(freeRooms(devices, null, [group]).map((d) => d.id)).toEqual(['c']);
    const sync = { groups: [], standalone_ids: ['b'] };
    expect(freeRooms(devices, sync, []).map((d) => d.id)).toEqual(['b']);
    const synced = room('d', 'Delta', { sync_role: 'synced' });
    expect(freeRooms([synced], null, [])).toEqual([]);
  });

  it('never offers the lead as its own follower', () => {
    expect(availableFollowers([alpha, bravo], null, [], 'a').map((d) => d.id)).toEqual(['b']);
  });

  it('builds sync state with everyone outside the groups standalone', () => {
    expect(syncStateFor([group], [alpha, bravo, charlie])).toEqual({
      groups: [group],
      standalone_ids: ['c'],
    });
  });

  it('adds a follower to an existing group without mutating it', () => {
    const next = withFollower([group], alpha, charlie);
    expect(next[0].slave_ids).toEqual(['b', 'c']);
    expect(next[0].slave_names).toEqual(['Bravo', 'Charlie']);
    expect(group.slave_ids).toEqual(['b']);
    expect(withFollower(next, alpha, charlie)[0].slave_ids).toEqual(['b', 'c']);
  });

  it('creates a group for a new lead', () => {
    const [created] = withFollower([], bravo, charlie);
    expect(created).toMatchObject({
      primary_id: 'b',
      primary_name: 'Bravo',
      slave_ids: ['c'],
      slave_names: ['Charlie'],
    });
  });

  it('removes followers and drops a group that is left empty', () => {
    const two = withFollower([group], alpha, charlie);
    expect(withoutFollowers(two, 'a', ['b'])[0].slave_names).toEqual(['Charlie']);
    expect(withoutFollowers(two, 'a', ['b', 'c'])).toEqual([]);
    expect(withoutFollowers(two, 'other', ['b'])).toEqual(two);
  });

  it('labels room counts', () => {
    expect(roomCountLabel(1)).toBe('1 room');
    expect(roomCountLabel(3)).toBe('3 rooms');
  });
});
