import type { PlayerStatus, SyncRole, SyncState } from '@/api/types';

function membership(sync: SyncState): { followerIds: Set<string>; primaryIds: Set<string> } {
  const followerIds = new Set<string>();
  const primaryIds = new Set<string>();
  for (const group of sync.groups) {
    primaryIds.add(group.primary_id);
    for (const id of group.slave_ids) followerIds.add(id);
  }
  return { followerIds, primaryIds };
}

/** Fleet-row role from the group graph, not a leftover per-player master field. */
export function displaySyncRole(
  device: Pick<PlayerStatus, 'id' | 'sync_role'>,
  sync: SyncState | null,
): SyncRole {
  if (!sync) return device.sync_role;
  const { followerIds, primaryIds } = membership(sync);
  if (followerIds.has(device.id)) return 'synced';
  if (primaryIds.has(device.id)) return 'primary';
  return 'standalone';
}

/** Drop SYNCED/PRIMARY leftovers once the runtime group graph no longer lists them. */
export function dropStaleFollowerClaims(
  devices: PlayerStatus[],
  sync: SyncState | null,
): PlayerStatus[] {
  if (!sync) return devices;
  const { followerIds, primaryIds } = membership(sync);
  let changed = false;
  const next = devices.map((device) => {
    if (device.sync_role === 'synced' && !followerIds.has(device.id)) {
      changed = true;
      return { ...device, sync_role: 'standalone' as const, master: '', slaves: [] };
    }
    if (device.sync_role === 'primary' && !primaryIds.has(device.id)) {
      changed = true;
      return { ...device, sync_role: 'standalone' as const, slaves: [], group: '' };
    }
    return device;
  });
  return changed ? next : devices;
}
