import type { PlayerStatus } from '@/api/types';
import { deviceEndpoint, endpointsMatch } from '@/lib/endpoint';

export type FleetSortMode = 'name' | 'sync';

export function sortDevices(
  devices: PlayerStatus[],
  mode: FleetSortMode,
): PlayerStatus[] {
  if (mode === 'name') {
    return devices.slice().sort((a, b) => a.name.localeCompare(b.name));
  }
  return sortBySyncGroup(devices);
}

/** Primaries A–Z, each followed by its followers A–Z; then remaining standalones A–Z. */
export function sortBySyncGroup(devices: PlayerStatus[]): PlayerStatus[] {
  const used = new Set<string>();
  const result: PlayerStatus[] = [];

  const primaries = devices
    .filter((d) => d.sync_role === 'primary')
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const primary of primaries) {
    result.push(primary);
    used.add(primary.id);

    const primaryEp = deviceEndpoint(primary);
    // The lead's slave list is what the sync graph uses. A follower's own record
    // can lag behind it after joining, so it does not have to say synced yet.
    const followers = devices
      .filter(
        (d) =>
          !used.has(d.id) &&
          d.id !== primary.id &&
          ((d.sync_role === 'synced' && endpointsMatch(d.master, primaryEp)) ||
            primary.slaves.some((slave) => endpointsMatch(slave, deviceEndpoint(d)))),
      )
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const follower of followers) {
      result.push(follower);
      used.add(follower.id);
    }
  }

  const leftovers = devices
    .filter((d) => !used.has(d.id))
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));

  return result.concat(leftovers);
}

export function nextFleetSortMode(mode: FleetSortMode): FleetSortMode {
  return mode === 'name' ? 'sync' : 'name';
}

export function fleetSortLabel(mode: FleetSortMode): string {
  return mode === 'name' ? 'A–Z' : 'Sync';
}
