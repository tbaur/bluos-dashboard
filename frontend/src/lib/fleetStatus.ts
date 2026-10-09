import type { PlayerStatus, SyncState } from '@/api/types';
import { deviceEndpoint, endpointsMatch } from '@/lib/endpoint';
import {
  isEstablishedPlayback,
  LIVE_HOUSE_SESSION,
  type HouseSession,
} from '@/lib/houseSession';
import { formatTrackArtist, joinMeta } from '@/lib/meta';
import { streamQualityLabel } from '@/lib/streamQuality';

function isPlaying(state: string): boolean {
  return state === 'play' || state === 'stream' || state === 'connecting';
}

function isPaused(state: string): boolean {
  return state === 'pause';
}

function serviceLabel(device: PlayerStatus): string {
  return device.service && device.service !== 'Library/Input' ? device.service : '';
}

function resolveStreamMeta(focus: Cluster): string {
  for (const member of [focus.lead, ...focus.members]) {
    const label = streamQualityLabel(member.quality, member.stream_format);
    if (label) return label;
  }
  return '';
}

function nowPlayingLabel(focus: Cluster): { primary: string; detail: string } {
  const lead = focus.lead;
  const trackArtist =
    formatTrackArtist(lead.track, lead.artist) ||
    focus.members.map((m) => formatTrackArtist(m.track, m.artist)).find(Boolean) ||
    '';
  const service =
    serviceLabel(lead) ||
    focus.members.map(serviceLabel).find(Boolean) ||
    '';
  const quality = resolveStreamMeta(focus);

  return {
    primary: trackArtist || (focus.members.some((m) => isPlaying(m.state)) ? 'Playing' : 'Paused'),
    detail: joinMeta(service, quality),
  };
}

/** Track + artist identity; null when metadata is too thin to cluster. */
function streamKey(device: PlayerStatus): string | null {
  const track = device.track.trim().toLowerCase();
  const artist = device.artist.trim().toLowerCase();
  if (!track && !artist) return null;
  return `${track}\n${artist}`;
}

type Cluster = {
  members: PlayerStatus[];
  lead: PlayerStatus;
};

function pickLead(candidates: PlayerStatus[]): PlayerStatus {
  return (
    candidates.find((d) => d.sync_role === 'primary' && d.image) ??
    candidates.find((d) => d.sync_role === 'primary') ??
    candidates.find((d) => Boolean(d.image) && streamKey(d)) ??
    candidates.find((d) => Boolean(streamKey(d))) ??
    candidates.find((d) => Boolean(d.image)) ??
    candidates[0]
  );
}

function resolveImage(lead: PlayerStatus, members: PlayerStatus[]): string {
  if (lead.image) return lead.image;
  return members.find((m) => m.image)?.image ?? '';
}

function clusterStreamKey(cluster: Cluster): string | null {
  for (const member of [cluster.lead, ...cluster.members]) {
    const key = streamKey(member);
    if (key) return key;
  }
  return null;
}

function sourceKey(cluster: Cluster): string {
  const ids = [...cluster.members.map((m) => m.id)].sort().join(',');
  if (cluster.members.length > 1) return `members:${ids}`;
  const identity = clusterStreamKey(cluster);
  if (identity) return `stream:${identity.replaceAll('\n', '|')}`;
  return `members:${ids}`;
}

function roomNamesOf(members: PlayerStatus[]): string[] {
  return [...new Set(members.map((m) => m.name).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b),
  );
}

/** Playing (or paused) sync groups first, then each free candidate as its own cluster. */
function clustersFromCandidates(
  devices: PlayerStatus[],
  sync: SyncState | null,
  candidates: PlayerStatus[],
): Cluster[] {
  if (candidates.length === 0) return [];

  const wanted = new Set(candidates.map((d) => d.id));
  const byId = new Map(devices.map((d) => [d.id, d]));
  const claimed = new Set<string>();
  const clusters: Cluster[] = [];

  const pushGroup = (primary: PlayerStatus, followers: PlayerStatus[]) => {
    const members = [primary, ...followers].filter((d) => wanted.has(d.id));
    if (members.length === 0) return;
    for (const member of members) claimed.add(member.id);
    clusters.push({ members, lead: pickLead(members) });
  };

  if (sync?.groups.length) {
    for (const group of sync.groups) {
      const primary = byId.get(group.primary_id);
      const followers = group.slave_ids
        .map((id) => byId.get(id))
        .filter((d): d is PlayerStatus => Boolean(d));
      if (!primary) {
        const orphanMembers = followers.filter((d) => wanted.has(d.id));
        if (orphanMembers.length === 0) continue;
        const lead = pickLead(orphanMembers);
        pushGroup(
          lead,
          orphanMembers.filter((d) => d.id !== lead.id),
        );
        continue;
      }
      pushGroup(primary, followers);
    }
  } else {
    const primaries = candidates
      .filter((d) => d.sync_role === 'primary')
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const primary of primaries) {
      const primaryEp = deviceEndpoint(primary);
      const followers = candidates.filter(
        (d) =>
          d.sync_role === 'synced' &&
          !claimed.has(d.id) &&
          (endpointsMatch(d.master, primaryEp) ||
            primary.slaves.some((slave) =>
              endpointsMatch(slave, deviceEndpoint(d)),
            )),
      );
      pushGroup(primary, followers);
    }
  }

  const free = candidates
    .filter((d) => !claimed.has(d.id))
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const device of free) {
    clusters.push({ members: [device], lead: device });
  }

  return clusters;
}

function isSettling(cluster: Cluster): boolean {
  if (!clusterStreamKey(cluster)) return true;
  return cluster.members.every((member) => member.state === 'connecting');
}

function attachMembers(host: Cluster, extra: Cluster[]): void {
  host.members = [...host.members, ...extra.flatMap((cluster) => cluster.members)];
  host.lead = pickLead([host.lead, ...extra.map((cluster) => cluster.lead)]);
}

/**
 * Same track+artist is one stream. Untitled or still-connecting rooms join
 * the largest titled stream, or form one "Playing" stream if nothing is titled.
 */
function mergeByStreamIdentity(clusters: Cluster[]): Cluster[] {
  const settled: Cluster[] = [];
  const settling: Cluster[] = [];
  for (const cluster of clusters) {
    if (isSettling(cluster)) settling.push(cluster);
    else settled.push(cluster);
  }

  const keyed = new Map<string, Cluster[]>();
  for (const cluster of settled) {
    const key = clusterStreamKey(cluster);
    if (!key) continue;
    const list = keyed.get(key) ?? [];
    list.push(cluster);
    keyed.set(key, list);
  }

  const merged: Cluster[] = [];
  for (const list of keyed.values()) {
    const members = list.flatMap((cluster) => cluster.members);
    merged.push({ members, lead: pickLead(list.map((cluster) => cluster.lead)) });
  }

  if (settling.length > 0) {
    if (merged.length === 0) {
      merged.push({
        members: settling.flatMap((cluster) => cluster.members),
        lead: pickLead(settling.map((cluster) => cluster.lead)),
      });
    } else {
      const host = merged.reduce((a, b) =>
        a.members.length >= b.members.length ? a : b,
      );
      attachMembers(host, settling);
    }
  }

  return merged.sort((a, b) => {
    if (b.members.length !== a.members.length) {
      return b.members.length - a.members.length;
    }
    return a.lead.name.localeCompare(b.lead.name);
  });
}

export type HouseStreamSource = {
  key: string;
  leadId: string | null;
  primary: string;
  detail: string;
  image: string;
  album: string;
  roomNames: string[];
  playing: boolean;
  memberIds: string[];
};

function clusterToSource(cluster: Cluster): HouseStreamSource {
  const { primary, detail } = nowPlayingLabel(cluster);
  const album =
    cluster.lead.album.trim() ||
    cluster.members.find((m) => m.album.trim())?.album.trim() ||
    '';
  return {
    key: sourceKey(cluster),
    leadId: cluster.lead.id,
    primary,
    detail,
    image: resolveImage(cluster.lead, cluster.members),
    album,
    roomNames: roomNamesOf(cluster.members),
    playing: cluster.members.some((m) => isPlaying(m.state)),
    memberIds: cluster.members.map((m) => m.id),
  };
}

export type FleetHouseStatus = {
  /** Main line: track, multi-source count, or idle copy. */
  primary: string;
  /** Optional service / format under the title. */
  detail: string;
  /** Short chips: playing count, synced, muted. */
  meta: string[];
  isIdle: boolean;
  /** Nothing playing, but a paused stream still has metadata. */
  isPaused: boolean;
  /** True when every playing room is on one stream. Art does not depend on this. */
  hasDominantStream: boolean;
  image: string;
  leadId: string | null;
  /** Distinct playback sources (sync groups / identities), not player count. */
  sourceCount: number;
  album: string;
  rooms: string[];
  sources: HouseStreamSource[];
};

function emptyHouseStatus(partial: Partial<FleetHouseStatus> = {}): FleetHouseStatus {
  return {
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
    ...partial,
  };
}

function liveCandidates(devices: PlayerStatus[]): PlayerStatus[] {
  const playing = devices.some((device) => isEstablishedPlayback(device.state));
  if (playing) {
    return devices.filter(
      (device) =>
        isEstablishedPlayback(device.state) ||
        device.state === 'connecting' ||
        (isPaused(device.state) && Boolean(streamKey(device))),
    );
  }
  return devices.filter((device) => isPaused(device.state) && streamKey(device));
}

function houseStreams(devices: PlayerStatus[], sync: SyncState | null): HouseStreamSource[] {
  const candidates = liveCandidates(devices);
  return mergeByStreamIdentity(clustersFromCandidates(devices, sync, candidates)).map(
    clusterToSource,
  );
}

function houseMeta(
  devices: PlayerStatus[],
  sync: SyncState | null,
  playingCount: number,
  hasSources: boolean,
): string[] {
  const meta: string[] = [];
  if (playingCount > 1) meta.push(`${playingCount} playing`);
  if (playingCount === 0 && hasSources) meta.push('Paused');
  const groupCount =
    sync?.groups.length ?? devices.filter((d) => d.sync_role === 'primary').length;
  if (groupCount === 1) meta.push('Synced');
  else if (groupCount > 0) meta.push(`${groupCount} groups`);
  const mutedCount = devices.filter((d) => d.muted).length;
  if (mutedCount > 0) meta.push(`${mutedCount} muted`);
  return meta;
}

function finalizeHouseStatus(
  devices: PlayerStatus[],
  sync: SyncState | null,
  sources: HouseStreamSource[],
): FleetHouseStatus {
  const playingCount = devices.filter((d) => isPlaying(d.state)).length;
  const meta = houseMeta(devices, sync, playingCount, sources.length > 0);
  if (sources.length === 0) return emptyHouseStatus({ meta });

  const isPausedHouse = playingCount === 0;
  if (sources.length > 1) {
    return emptyHouseStatus({
      primary: `${sources.length} sources`,
      detail: isPausedHouse ? 'Mixed paused rooms' : 'Mixed playback across the house',
      meta,
      isIdle: false,
      isPaused: isPausedHouse,
      hasDominantStream: false,
      sourceCount: sources.length,
      sources,
    });
  }

  const focus = sources[0];
  return {
    primary: focus.primary,
    detail: focus.detail,
    meta,
    isIdle: false,
    isPaused: isPausedHouse,
    hasDominantStream: true,
    image: focus.image,
    leadId: focus.leadId,
    sourceCount: 1,
    album: focus.album,
    rooms: focus.roomNames,
    sources,
  };
}

function sessionKeys(members: PlayerStatus[]): Set<string> {
  const keys = new Set<string>();
  for (const member of members) {
    const key = streamKey(member);
    if (key) keys.add(key);
  }
  return keys;
}

function hasForeignSource(
  devices: PlayerStatus[],
  sessionIds: Set<string>,
  keys: Set<string>,
): boolean {
  if (keys.size === 0) return false;
  return devices.some((device) => {
    if (sessionIds.has(device.id) || !isEstablishedPlayback(device.state)) return false;
    const key = streamKey(device);
    return Boolean(key && !keys.has(key));
  });
}

function catchupMembers(
  devices: PlayerStatus[],
  pinned: PlayerStatus[],
  sessionIds: Set<string>,
  keys: Set<string>,
): PlayerStatus[] {
  const extra = devices.filter((device) => {
    if (sessionIds.has(device.id)) return false;
    if (device.state === 'connecting') return true;
    if (!isEstablishedPlayback(device.state) && !isPaused(device.state)) return false;
    const key = streamKey(device);
    return !key || keys.size === 0 || keys.has(key);
  });
  return [...pinned, ...extra];
}

/** Pin rooms as one stream while skip/play catch up. A new titled outsider stays mixed. */
function applyCatchup(
  live: FleetHouseStatus,
  devices: PlayerStatus[],
  sync: SyncState | null,
  memberIds: readonly string[],
): FleetHouseStatus {
  if (memberIds.length === 0) return live;
  const sessionIds = new Set(memberIds);
  const byId = new Map(devices.map((device) => [device.id, device]));
  const pinned = memberIds
    .map((id) => byId.get(id))
    .filter((device): device is PlayerStatus => Boolean(device));
  if (pinned.length === 0) return live;

  const keys = sessionKeys(pinned);
  if (hasForeignSource(devices, sessionIds, keys)) return live;

  const members = catchupMembers(devices, pinned, sessionIds, keys);
  const pinnedSource = clusterToSource({ members, lead: pickLead(members) });
  const pinnedIds = new Set(pinnedSource.memberIds);
  const others = live.sources.filter(
    (source) => !source.memberIds.some((id) => pinnedIds.has(id)),
  );
  return finalizeHouseStatus(devices, sync, [pinnedSource, ...others]);
}

/** Command the sync primary, or the stream lead — never every AirPlay room. */
export function houseTransportTargets(
  source: HouseStreamSource,
  devices: PlayerStatus[],
): string[] {
  const byId = new Map(devices.map((d) => [d.id, d]));
  const members = source.memberIds
    .map((id) => byId.get(id))
    .filter((d): d is PlayerStatus => Boolean(d));
  const primary = members.find((d) => d.sync_role === 'primary');
  if (primary) return [primary.id];
  if (source.leadId && byId.has(source.leadId)) return [source.leadId];
  return members[0] ? [members[0].id] : [];
}

/** Structured house status for the fleet remote panel. */
export function fleetHouseStatus(
  devices: PlayerStatus[],
  sync: SyncState | null,
  session: HouseSession = LIVE_HOUSE_SESSION,
): FleetHouseStatus {
  if (devices.length === 0) {
    return emptyHouseStatus({ primary: 'No players' });
  }

  const stopped =
    session.phase === 'stopped' &&
    !devices.some((device) => isEstablishedPlayback(device.state));
  if (stopped) {
    return emptyHouseStatus({ meta: houseMeta(devices, sync, 0, false) });
  }

  const live = finalizeHouseStatus(devices, sync, houseStreams(devices, sync));
  if (session.phase === 'catchup') {
    return applyCatchup(live, devices, sync, session.memberIds);
  }
  return live;
}

/** Flat string for titles/tooltips. */
export function houseStatusLine(status: FleetHouseStatus): string {
  const parts = [status.primary, ...status.meta];
  if (status.detail) parts.splice(1, 0, status.detail);
  return joinMeta(...parts);
}

export function fleetHouseStatusLine(
  devices: PlayerStatus[],
  sync: SyncState | null,
  session: HouseSession = LIVE_HOUSE_SESSION,
): string {
  return houseStatusLine(fleetHouseStatus(devices, sync, session));
}

export function fleetHasActivePlayback(devices: PlayerStatus[]): boolean {
  return devices.some((d) => isPlaying(d.state));
}
