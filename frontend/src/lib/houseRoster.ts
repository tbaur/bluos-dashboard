import type { PlayerStatus, SyncRole, SyncState } from '@/api/types';
import type { HouseStreamSource } from '@/lib/fleetStatus';
import { displaySyncRole } from '@/lib/syncGraph';

/** Also playing stays one row of tiles. The rest open from the count. */
export const ALSO_PLAYING_VISIBLE = 3;

const ROLE_RANK: Record<SyncRole, number> = {
  primary: 0,
  synced: 1,
  standalone: 2,
};

export type SpeakerRosterRow = {
  id: string;
  name: string;
  role: SyncRole;
  roleLabel: string;
  volume: number;
  muted: boolean;
};

/** One player, a BluOS group, or several players on the same audio. */
export function rosterHeading(rows: readonly Pick<SpeakerRosterRow, 'role'>[]): string {
  if (rows.length <= 1) return 'Player';
  if (rows.every((row) => row.role !== 'standalone')) return 'In this group';
  return 'On this stream';
}

/**
 * Lead and synced are the BluOS group. Standalone members on the same
 * stream were started on their own, not joined as followers.
 */
export function speakerRoleLabel(role: SyncRole, memberCount: number): string {
  if (role === 'primary') return 'Lead';
  if (role === 'synced') return 'Synced';
  if (memberCount === 1) return 'Playing';
  return 'Direct';
}

/** One room keeps its name. A stream with several players is a count. */
export function streamPlaceLabel(memberCount: number, onlyName: string): string {
  if (memberCount <= 1) return onlyName;
  return `${memberCount} speakers`;
}

export function speakerRoster(
  source: HouseStreamSource,
  devices: readonly PlayerStatus[],
  sync: SyncState | null,
): SpeakerRosterRow[] {
  const byId = new Map(devices.map((device) => [device.id, device]));
  const members: PlayerStatus[] = [];
  for (const id of source.memberIds) {
    const device = byId.get(id);
    if (device) members.push(device);
  }
  const memberCount = members.length;
  const roleOf = (device: PlayerStatus): SyncRole => displaySyncRole(device, sync);
  return members
    .map((device) => ({
      id: device.id,
      name: device.name,
      role: roleOf(device),
      roleLabel: speakerRoleLabel(roleOf(device), memberCount),
      volume: device.volume,
      muted: device.muted,
    }))
    .sort((a, b) => {
      const left = byId.get(a.id);
      const right = byId.get(b.id);
      const rank =
        ROLE_RANK[left ? roleOf(left) : 'standalone'] - ROLE_RANK[right ? roleOf(right) : 'standalone'];
      if (rank !== 0) return rank;
      return a.name.localeCompare(b.name);
    });
}

export function alsoPlayingMeta(otherCount: number): string {
  if (otherCount <= 0) return '';
  if (otherCount === 1) return '1 other stream';
  if (otherCount <= ALSO_PLAYING_VISIBLE) return `${otherCount} other streams`;
  const more = otherCount - ALSO_PLAYING_VISIBLE;
  return `${ALSO_PLAYING_VISIBLE} other streams + ${more} more`;
}

export function otherStreams(
  sources: readonly HouseStreamSource[],
  focusKey: string,
): HouseStreamSource[] {
  return sources.filter((source) => source.key !== focusKey);
}
