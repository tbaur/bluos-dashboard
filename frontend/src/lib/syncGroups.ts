import type { PlayerStatus, SyncGroup, SyncState } from '@/api/types';
import { deviceEndpoint } from '@/lib/endpoint';

/** Every room that leads or follows in some group. */
export function occupiedRoomIds(groups: readonly SyncGroup[]): Set<string> {
  const ids = new Set<string>();
  for (const group of groups) {
    ids.add(group.primary_id);
    for (const slaveId of group.slave_ids) ids.add(slaveId);
  }
  return ids;
}

function byName(a: PlayerStatus, b: PlayerStatus): number {
  return a.name.localeCompare(b.name);
}

/** Rooms not in any multi-room group, A–Z. Prefers the API's standalone_ids. */
export function freeRooms(
  devices: readonly PlayerStatus[],
  sync: SyncState | null,
  groups: readonly SyncGroup[],
): PlayerStatus[] {
  const occupied = occupiedRoomIds(groups);
  const standaloneIds = new Set(sync?.standalone_ids ?? []);
  return devices
    .filter((d) => {
      if (occupied.has(d.id)) return false;
      if (standaloneIds.size > 0) return standaloneIds.has(d.id);
      return d.sync_role === 'standalone';
    })
    .sort(byName);
}

/** Free rooms that could follow `primaryId`. */
export function availableFollowers(
  devices: readonly PlayerStatus[],
  sync: SyncState | null,
  groups: readonly SyncGroup[],
  primaryId: string,
): PlayerStatus[] {
  return freeRooms(devices, sync, groups).filter((d) => d.id !== primaryId);
}

/** Sync state for `groups`: every room outside them is standalone. */
export function syncStateFor(
  groups: SyncGroup[],
  devices: readonly PlayerStatus[],
): SyncState {
  const occupied = occupiedRoomIds(groups);
  return {
    groups,
    standalone_ids: devices.map((d) => d.id).filter((id) => !occupied.has(id)),
  };
}

/** Groups after `follower` joins `lead`, creating the group when needed. */
export function withFollower(
  groups: readonly SyncGroup[],
  lead: PlayerStatus,
  follower: PlayerStatus,
): SyncGroup[] {
  const next = groups.map((g) => ({
    ...g,
    slave_ids: [...g.slave_ids],
    slave_names: [...g.slave_names],
  }));
  const existing = next.find((g) => g.primary_id === lead.id);
  if (!existing) {
    next.push({
      primary_id: lead.id,
      primary_name: lead.name,
      primary_ip: lead.ip,
      primary_endpoint: deviceEndpoint(lead),
      group: lead.group || '',
      slave_ids: [follower.id],
      slave_names: [follower.name],
    });
  } else if (!existing.slave_ids.includes(follower.id)) {
    existing.slave_ids.push(follower.id);
    existing.slave_names.push(follower.name);
  }
  return next;
}

/** Groups after `slaveIds` leave `primaryId`. A group with no followers left is gone. */
export function withoutFollowers(
  groups: readonly SyncGroup[],
  primaryId: string,
  slaveIds: readonly string[],
): SyncGroup[] {
  const remove = new Set(slaveIds);
  return groups
    .map((g) => {
      if (g.primary_id !== primaryId) return g;
      const keep = g.slave_ids
        .map((id, index) => ({ id, name: g.slave_names[index] ?? id }))
        .filter((member) => !remove.has(member.id));
      return {
        ...g,
        slave_ids: keep.map((member) => member.id),
        slave_names: keep.map((member) => member.name),
      };
    })
    .filter((g) => g.slave_ids.length > 0);
}

export function roomCountLabel(n: number): string {
  return n === 1 ? '1 room' : `${n} rooms`;
}
