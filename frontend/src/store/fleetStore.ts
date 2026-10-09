import { create } from 'zustand';
import { api } from '@/api/client';
import type {
  DevicesResponse,
  FleetActionResponse,
  FleetHealthResponse,
  PlayerStatus,
  SyncState,
} from '@/api/types';
import { ApiError } from '@/api/types';
import {
  houseCatchupSession,
  houseStoppedSession,
  isEstablishedPlayback,
  LIVE_HOUSE_SESSION,
  type HouseSession,
} from '@/lib/houseSession';
import { dropStaleFollowerClaims } from '@/lib/syncGraph';

export type ConnectionState = 'connecting' | 'live' | 'reconnecting' | 'offline';

const VOLUME_HOLD_MS = 2500;
const PLAYBACK_HOLD_MS = 2000;
const MUTE_HOLD_MS = 4500;
/** Pause all and Stop all reach every player, so they hold longer than one skip. */
const FLEET_PLAYBACK_HOLD_MS = 4500;
const SYNC_HOLD_MS = 5000;
const HOUSE_CATCHUP_MS = 10_000;
/** BluOS SyncStatus often lags AddSlave by a few seconds. */
const LINK_RETRY_ATTEMPTS = 16;
const LINK_RETRY_MS = 200;
const DEFAULT_UNMUTE_VOLUME = 20;

/** A slider drag can outlast one round trip, so its hold covers the whole gesture. */
export const DRAG_VOLUME_HOLD_MS = 5000;
/** Group and ungroup take a few seconds to show up in /SyncStatus. */
export const GROUP_CHANGE_SYNC_HOLD_MS = 6000;

let houseCatchupTimer: number | undefined;
/** Latest control per device. An older failure must not roll back a newer command. */
const controlEpoch = new Map<string, number>();

interface FleetState {
  devices: PlayerStatus[];
  discoveredAt: number | null;
  discoveryMethod: string;
  sync: SyncState | null;
  health: FleetHealthResponse | null;
  connection: ConnectionState;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  toast: string | null;
  /** Device ids whose volume should not be overwritten by SSE yet */
  volumeHoldUntil: Record<string, number>;
  /** Device ids whose transport/now-playing should not be overwritten by SSE yet */
  playbackHoldUntil: Record<string, number>;
  /** Device ids whose mute should not be overwritten by SSE yet */
  muteHoldUntil: Record<string, number>;
  houseSession: HouseSession;
  globalVolumeHoldUntil: number;
  /** Ignore stale sync snapshots while BluOS catches up after add or ungroup. */
  syncHoldUntil: number;
  /** Last non-zero volume per device — restored on unmute */
  lastAudibleVolume: Record<string, number>;
  load: () => Promise<void>;
  /** Full LAN rediscovery (Rescan). */
  refresh: () => Promise<void>;
  /** Reload cached fleet + sync status without rediscovering the LAN. */
  reloadStatus: (opts?: {
    ensureLink?: { primaryId: string; slaveId: string };
  }) => Promise<void>;
  setFleet: (devices: PlayerStatus[], discoveredAt?: number | null) => void;
  upsertDevice: (device: PlayerStatus) => void;
  patchDevice: (deviceId: string, patch: Partial<PlayerStatus>) => void;
  holdVolume: (deviceId: string, ms?: number) => void;
  holdAllVolumes: (ms?: number) => void;
  holdVolumes: (deviceIds: string[], ms?: number) => void;
  holdPlayback: (deviceId: string, ms?: number) => void;
  holdMute: (deviceId: string, ms?: number) => void;
  beginHouseCatchup: (memberIds: string[], ms?: number) => void;
  beginHouseStopped: () => void;
  holdSync: (ms?: number) => void;
  setConnection: (connection: ConnectionState) => void;
  setSync: (sync: SyncState | null) => void;
  setHealth: (health: FleetHealthResponse | null) => void;
  setToast: (toast: string | null) => void;
  setAllVolumesLocal: (level: number) => void;
  setVolumesLocal: (level: number, deviceIds: string[]) => void;
  setFleetVolume: (level: number, deviceIds?: string[]) => Promise<void>;
  toggleMute: (deviceId: string) => Promise<void>;
  fleetMuteAll: (mute: boolean) => Promise<void>;
  fleetPauseAll: () => Promise<void>;
  fleetStopAll: () => Promise<void>;
  fleetRebootAll: () => Promise<void>;
  control: (
    deviceId: string,
    action: () => Promise<void>,
    optimistic?: Partial<PlayerStatus>,
  ) => Promise<void>;
}

function hasTrackMeta(device: PlayerStatus): boolean {
  return Boolean(device.track.trim() || device.artist.trim());
}

function isSameTrack(left: PlayerStatus, right: PlayerStatus): boolean {
  return left.track === right.track && left.artist === right.artist;
}

function isVolumeOnlyPatch(patch?: Partial<PlayerStatus>): boolean {
  if (!patch || patch.volume === undefined) return false;
  return (
    patch.state === undefined &&
    patch.muted === undefined &&
    patch.secs === undefined &&
    patch.shuffle === undefined &&
    patch.repeat === undefined
  );
}

function isMutePatch(patch?: Partial<PlayerStatus>): boolean {
  return Boolean(patch && patch.muted !== undefined);
}

/** Copy of `current` with every id in `ids` set to `value`. */
function setEach(
  current: Record<string, number>,
  ids: Iterable<string>,
  value: number,
): Record<string, number> {
  const next = { ...current };
  for (const id of ids) {
    next[id] = value;
  }
  return next;
}

/** Freeze transport/now-playing; mute and volume have their own holds. */
function applyPlaybackHold(incoming: PlayerStatus, previous: PlayerStatus): PlayerStatus {
  // After Stop an empty track is the truth, not a skip in progress. A stopped
  // player sends no more updates, so a kept title would never be corrected.
  const stopped = previous.state === 'stop';
  const keepMeta = !stopped && !hasTrackMeta(incoming) && hasTrackMeta(previous);
  const keepSecs = keepMeta || (hasTrackMeta(incoming) && isSameTrack(incoming, previous));
  const meta = keepMeta ? previous : incoming;
  // A skip often arrives with an empty image for a moment. Keep the last cover
  // then. A new track that already has its own image must replace it, or the
  // hold eats the only event and the old cover stays up.
  const image = stopped ? incoming.image : incoming.image || previous.image;
  return {
    ...incoming,
    state: previous.state,
    shuffle: previous.shuffle,
    repeat: previous.repeat,
    secs: keepSecs ? previous.secs : incoming.secs,
    track: meta.track,
    artist: meta.artist,
    album: meta.album,
    image,
    totlen: keepMeta || (!stopped && incoming.totlen <= 0) ? previous.totlen : incoming.totlen,
    quality: meta.quality,
    stream_format: meta.stream_format,
    service: meta.service,
    service_id: meta.service_id,
    can_seek: keepMeta ? previous.can_seek : incoming.can_seek,
  };
}

type RemoteHolds = {
  volumeHoldUntil: Record<string, number>;
  playbackHoldUntil: Record<string, number>;
  muteHoldUntil: Record<string, number>;
  globalVolumeHoldUntil: number;
  now: number;
};

function mergeRemoteDevice(
  incoming: PlayerStatus,
  previous: PlayerStatus | undefined,
  holds: RemoteHolds,
): PlayerStatus {
  if (!previous) return incoming;
  let next = incoming;
  const holdMute = (holds.muteHoldUntil[incoming.id] ?? 0) > holds.now;
  const holdVolume =
    holds.globalVolumeHoldUntil > holds.now ||
    (holds.volumeHoldUntil[incoming.id] ?? 0) > holds.now;
  if (holdMute) {
    next = { ...next, muted: previous.muted, volume: previous.volume };
  } else if (holdVolume) {
    next = { ...next, volume: previous.volume };
  }
  if ((holds.playbackHoldUntil[incoming.id] ?? 0) > holds.now) {
    next = applyPlaybackHold(next, previous);
  }
  return next;
}

function clearHouseCatchupTimer() {
  if (houseCatchupTimer !== undefined) {
    window.clearTimeout(houseCatchupTimer);
    houseCatchupTimer = undefined;
  }
}

function holdsOf(state: FleetState, now: number): RemoteHolds {
  return {
    volumeHoldUntil: state.volumeHoldUntil,
    playbackHoldUntil: state.playbackHoldUntil,
    muteHoldUntil: state.muteHoldUntil,
    globalVolumeHoldUntil: state.globalVolumeHoldUntil,
    now,
  };
}

/**
 * Fold a server device list into local state. Every path that accepts a remote
 * fleet goes through here — SSE and REST alike — so an in-flight volume drag or
 * skip is never stomped by whichever transport happens to answer first.
 */
function mergedDeviceList(state: FleetState, incoming: PlayerStatus[]): PlayerStatus[] {
  const holds = holdsOf(state, Date.now());
  const byId = new Map(state.devices.map((d) => [d.id, d]));
  return incoming.map((device) => mergeRemoteDevice(device, byId.get(device.id), holds));
}

/** Drop hold/volume memory for ids that left the fleet or whose window lapsed. */
function pruneById(
  entries: Record<string, number>,
  liveIds: Set<string>,
  now: number,
): Record<string, number> {
  const next: Record<string, number> = {};
  let dropped = false;
  for (const [id, value] of Object.entries(entries)) {
    if (liveIds.has(id) && value > now) next[id] = value;
    else dropped = true;
  }
  return dropped ? next : entries;
}

function pruneKeys(
  entries: Record<string, number>,
  liveIds: Set<string>,
): Record<string, number> {
  const next: Record<string, number> = {};
  let dropped = false;
  for (const [id, value] of Object.entries(entries)) {
    if (liveIds.has(id)) next[id] = value;
    else dropped = true;
  }
  return dropped ? next : entries;
}

/** Hold maps and volume memory, trimmed to the devices the server still reports. */
function prunedHolds(
  state: FleetState,
  incoming: PlayerStatus[],
): Pick<
  FleetState,
  'volumeHoldUntil' | 'playbackHoldUntil' | 'muteHoldUntil' | 'lastAudibleVolume'
> {
  const liveIds = new Set(incoming.map((d) => d.id));
  const now = Date.now();
  return {
    volumeHoldUntil: pruneById(state.volumeHoldUntil, liveIds, now),
    playbackHoldUntil: pruneById(state.playbackHoldUntil, liveIds, now),
    muteHoldUntil: pruneById(state.muteHoldUntil, liveIds, now),
    lastAudibleVolume: pruneKeys(state.lastAudibleVolume, liveIds),
  };
}

/** True when a sync snapshot is older than the group we optimistically painted. */
function isStaleSync(state: FleetState, incoming: SyncState | null): boolean {
  if (Date.now() >= state.syncHoldUntil) return false;
  const currentCount = state.sync?.groups.length ?? 0;
  const incomingCount = incoming?.groups.length ?? 0;
  if (currentCount > 0 && incomingCount < currentCount) return true;
  return currentCount === 0 && incomingCount > 0;
}

/** Restore named fields from a pre-action snapshot so a failed write is undone. */
function revertFields<K extends keyof PlayerStatus>(
  devices: PlayerStatus[],
  snapshot: Map<string, PlayerStatus>,
  fields: readonly K[],
): PlayerStatus[] {
  return devices.map((device) => {
    const before = snapshot.get(device.id);
    if (!before) return device;
    const patch = {} as Pick<PlayerStatus, K>;
    for (const field of fields) {
      patch[field] = before[field];
    }
    return { ...device, ...patch };
  });
}

function releaseHold(entries: Record<string, number>, ids: Iterable<string>): Record<string, number> {
  const next = { ...entries };
  for (const id of ids) delete next[id];
  return next;
}

/** Volume to restore on unmute: the last audible level, else the current one, else a default. */
function unmuteVolume(state: FleetState, device: PlayerStatus): number {
  return (
    state.lastAudibleVolume[device.id] ??
    (device.volume > 0 ? device.volume : DEFAULT_UNMUTE_VOLUME)
  );
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

/** Toast text for a failed call, with the request id so it can be found in the logs. */
function errorToast(err: unknown, fallback: string): string {
  return err instanceof ApiError ? `${err.message} (${err.requestId})` : fallback;
}

function partialToast(label: string, result: { succeeded: number; failed: number }): string {
  return `${label}: ${result.succeeded} ok, ${result.failed} failed`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

type FleetSnapshot = {
  fleet: DevicesResponse;
  sync: SyncState;
  health: FleetHealthResponse | null;
};

async function fetchSnapshot(
  devices: () => Promise<DevicesResponse>,
  lastHealth: FleetHealthResponse | null,
): Promise<FleetSnapshot> {
  const [fleet, sync, health] = await Promise.all([
    devices(),
    api.getSync(),
    api.getFleetHealth().catch(() => lastHealth),
  ]);
  return { fleet, sync, health };
}

/**
 * State update for a REST snapshot. With `acceptSync` false the painted sync
 * graph stays, because BluOS has not caught up with a group change yet.
 */
function snapshotPatch(
  state: FleetState,
  snapshot: FleetSnapshot,
  acceptSync: boolean,
): Partial<FleetState> {
  const { fleet, sync, health } = snapshot;
  return {
    devices: dropStaleFollowerClaims(
      mergedDeviceList(state, fleet.devices),
      acceptSync ? sync : state.sync,
    ),
    ...prunedHolds(state, fleet.devices),
    discoveredAt: fleet.discovered_at,
    discoveryMethod: fleet.discovery_method,
    health: health ?? state.health,
    ...(acceptSync ? { sync, syncHoldUntil: 0 } : {}),
  };
}

type SetFleetState = (
  partial: Partial<FleetState> | ((state: FleetState) => Partial<FleetState>),
) => void;

/** Run a house-wide action. Partial failure is a toast; a failed call runs `undo`. */
async function runFleetAction(
  set: SetFleetState,
  label: string,
  call: () => Promise<FleetActionResponse>,
  undo: () => void,
): Promise<void> {
  try {
    const result = await call();
    if (result.failed > 0) set({ toast: partialToast(label, result) });
  } catch (err) {
    undo();
    set({ toast: errorToast(err, `${label} failed`) });
  }
}

export const useFleetStore = create<FleetState>((set, get) => ({
  devices: [],
  discoveredAt: null,
  discoveryMethod: '',
  sync: null,
  health: null,
  connection: 'connecting',
  loading: true,
  refreshing: false,
  error: null,
  toast: null,
  volumeHoldUntil: {},
  playbackHoldUntil: {},
  muteHoldUntil: {},
  houseSession: LIVE_HOUSE_SESSION,
  globalVolumeHoldUntil: 0,
  syncHoldUntil: 0,
  lastAudibleVolume: {},

  setFleet: (devices, discoveredAt = null) =>
    set((state) => ({
      devices: dropStaleFollowerClaims(mergedDeviceList(state, devices), state.sync),
      ...prunedHolds(state, devices),
      discoveredAt: discoveredAt ?? state.discoveredAt,
      loading: false,
      error: null,
    })),

  upsertDevice: (device) =>
    set((state) => {
      const previous = state.devices.find((d) => d.id === device.id);
      const merged = mergeRemoteDevice(device, previous, holdsOf(state, Date.now()));
      const exists = Boolean(previous);
      const nextDevices = exists
        ? state.devices.map((d) => (d.id === device.id ? merged : d))
        : [...state.devices, merged];
      return { devices: dropStaleFollowerClaims(nextDevices, state.sync) };
    }),

  patchDevice: (deviceId, patch) =>
    set((state) => {
      const lastAudibleVolume = { ...state.lastAudibleVolume };
      if (typeof patch.volume === 'number' && patch.volume > 0) {
        lastAudibleVolume[deviceId] = patch.volume;
      }
      return {
        lastAudibleVolume,
        devices: state.devices.map((d) => (d.id === deviceId ? { ...d, ...patch } : d)),
      };
    }),

  holdVolume: (deviceId, ms = VOLUME_HOLD_MS) =>
    set((state) => ({
      volumeHoldUntil: {
        ...state.volumeHoldUntil,
        [deviceId]: Date.now() + ms,
      },
    })),

  holdAllVolumes: (ms = VOLUME_HOLD_MS) => {
    const until = Date.now() + ms;
    set((state) => {
      const volumeHoldUntil = { ...state.volumeHoldUntil };
      for (const device of state.devices) {
        volumeHoldUntil[device.id] = until;
      }
      return { volumeHoldUntil, globalVolumeHoldUntil: until };
    });
  },

  holdVolumes: (deviceIds, ms = VOLUME_HOLD_MS) => {
    if (deviceIds.length === 0) return;
    const until = Date.now() + ms;
    const idSet = new Set(deviceIds);
    set((state) => {
      const volumeHoldUntil = { ...state.volumeHoldUntil };
      for (const id of idSet) {
        volumeHoldUntil[id] = until;
      }
      return { volumeHoldUntil };
    });
  },

  holdPlayback: (deviceId, ms = PLAYBACK_HOLD_MS) =>
    set((state) => ({
      playbackHoldUntil: {
        ...state.playbackHoldUntil,
        [deviceId]: Date.now() + ms,
      },
    })),

  holdMute: (deviceId, ms = MUTE_HOLD_MS) =>
    set((state) => ({
      muteHoldUntil: {
        ...state.muteHoldUntil,
        [deviceId]: Date.now() + ms,
      },
    })),

  beginHouseCatchup: (memberIds, ms = HOUSE_CATCHUP_MS) => {
    clearHouseCatchupTimer();
    if (memberIds.length === 0) {
      set({ houseSession: LIVE_HOUSE_SESSION });
      return;
    }
    set({ houseSession: houseCatchupSession(memberIds) });
    houseCatchupTimer = window.setTimeout(() => {
      houseCatchupTimer = undefined;
      set({ houseSession: LIVE_HOUSE_SESSION });
    }, ms);
  },

  beginHouseStopped: () => {
    clearHouseCatchupTimer();
    set({ houseSession: houseStoppedSession() });
  },

  holdSync: (ms = SYNC_HOLD_MS) => set({ syncHoldUntil: Date.now() + ms }),

  setConnection: (connection) => set({ connection }),
  setSync: (sync) =>
    set((state) => {
      // Drop stale sync while BluOS catches up after add/ungroup (SSE often races).
      if (isStaleSync(state, sync)) return {};
      return {
        sync,
        syncHoldUntil: 0,
        devices: dropStaleFollowerClaims(state.devices, sync),
      };
    }),
  setHealth: (health) => set({ health }),
  setToast: (toast) => set({ toast }),

  setAllVolumesLocal: (level) =>
    set((state) => ({
      devices: state.devices.map((d) => ({ ...d, volume: level })),
    })),

  setVolumesLocal: (level, deviceIds) => {
    const idSet = new Set(deviceIds);
    set((state) => ({
      devices: state.devices.map((d) => (idSet.has(d.id) ? { ...d, volume: level } : d)),
    }));
  },

  setFleetVolume: async (level, deviceIds) => {
    const clamped = Math.max(0, Math.min(100, Math.round(level)));
    // undefined → whole fleet; explicit [] is a caller bug (no-op).
    if (deviceIds !== undefined && deviceIds.length === 0) return;
    const scoped = deviceIds !== undefined;
    const ids = scoped ? deviceIds : get().devices.map((d) => d.id);
    if (ids.length === 0) return;

    // Painted again after the call, so the hold outlasts the round trip.
    const paint = () => {
      if (scoped) {
        get().holdVolumes(ids);
        get().setVolumesLocal(clamped, ids);
      } else {
        get().holdAllVolumes();
        get().setAllVolumesLocal(clamped);
      }
    };
    paint();
    try {
      const result = await api.setFleetVolume(clamped, scoped ? ids : undefined);
      paint();
      if (clamped > 0) {
        set((state) => ({
          lastAudibleVolume: setEach(state.lastAudibleVolume, ids, clamped),
        }));
      }
      if (result.failed > 0) set({ toast: partialToast(`Volume ${clamped}`, result) });
    } catch (err) {
      set({
        globalVolumeHoldUntil: scoped ? get().globalVolumeHoldUntil : 0,
        toast: errorToast(err, 'Failed to set volume'),
      });
      try {
        const fleet = await api.listDevices();
        set((state) => ({ devices: mergedDeviceList(state, fleet.devices) }));
      } catch {
        // ignore secondary failure
      }
    }
  },

  toggleMute: async (deviceId) => {
    const device = get().devices.find((d) => d.id === deviceId);
    if (!device) return;

    if (device.muted) {
      await get().control(
        deviceId,
        () => api.setMute(deviceId, false),
        { muted: false, volume: unmuteVolume(get(), device) },
      );
      return;
    }

    if (device.volume > 0) {
      set((state) => ({
        lastAudibleVolume: {
          ...state.lastAudibleVolume,
          [deviceId]: device.volume,
        },
      }));
    }
    await get().control(
      deviceId,
      () => api.setMute(deviceId, true),
      { muted: true, volume: 0 },
    );
  },

  fleetMuteAll: async (mute) => {
    const devices = get().devices;
    if (devices.length === 0) return;
    const before = new Map(devices.map((d) => [d.id, d]));

    set((state) => {
      const until = Date.now() + MUTE_HOLD_MS;
      const ids = state.devices.map((d) => d.id);
      const audible = state.devices.filter((d) => d.volume > 0);
      return {
        lastAudibleVolume: mute
          ? { ...state.lastAudibleVolume, ...Object.fromEntries(audible.map((d) => [d.id, d.volume])) }
          : state.lastAudibleVolume,
        muteHoldUntil: setEach(state.muteHoldUntil, ids, until),
        volumeHoldUntil: setEach(state.volumeHoldUntil, ids, until),
        devices: state.devices.map((d) =>
          mute
            ? { ...d, muted: true, volume: 0 }
            : { ...d, muted: false, volume: unmuteVolume(state, d) },
        ),
      };
    });

    // A failure releases the holds as well, so server truth returns.
    await runFleetAction(set, `Fleet ${mute ? 'mute' : 'unmute'}`, () => api.fleetMute(mute), () =>
      set((state) => ({
        devices: revertFields(state.devices, before, ['muted', 'volume']),
        muteHoldUntil: releaseHold(state.muteHoldUntil, before.keys()),
        volumeHoldUntil: releaseHold(state.volumeHoldUntil, before.keys()),
      })),
    );
  },

  fleetPauseAll: async () => {
    const before = new Map(get().devices.map((d) => [d.id, d]));
    set((state) => ({
      playbackHoldUntil: setEach(
        state.playbackHoldUntil,
        before.keys(),
        Date.now() + FLEET_PLAYBACK_HOLD_MS,
      ),
      devices: state.devices.map((d) => ({
        ...d,
        state: isEstablishedPlayback(d.state) ? 'pause' : d.state,
      })),
    }));
    await runFleetAction(set, 'Pause all', api.fleetPause, () =>
      set((state) => ({
        devices: revertFields(state.devices, before, ['state']),
        playbackHoldUntil: releaseHold(state.playbackHoldUntil, before.keys()),
      })),
    );
  },

  fleetStopAll: async () => {
    const before = new Map(get().devices.map((d) => [d.id, d]));
    get().beginHouseStopped();
    set((state) => ({
      playbackHoldUntil: setEach(
        state.playbackHoldUntil,
        before.keys(),
        Date.now() + FLEET_PLAYBACK_HOLD_MS,
      ),
      devices: state.devices.map((d) => ({ ...d, state: 'stop' })),
    }));
    await runFleetAction(set, 'Stop all', api.fleetStop, () => {
      // Also drop the "stopped" house session — nothing actually stopped.
      clearHouseCatchupTimer();
      set((state) => ({
        devices: revertFields(state.devices, before, ['state']),
        playbackHoldUntil: releaseHold(state.playbackHoldUntil, before.keys()),
        houseSession: LIVE_HOUSE_SESSION,
      }));
    });
  },

  fleetRebootAll: async () => {
    if (get().devices.length === 0) return;
    try {
      const result = await api.fleetReboot();
      const sent = `Reboot sent to ${result.succeeded} player${result.succeeded === 1 ? '' : 's'}`;
      set({ toast: result.failed > 0 ? partialToast('Reboot', result) : sent });
    } catch (err) {
      set({ toast: errorToast(err, 'Fleet reboot failed') });
    }
  },

  load: async () => {
    // `load` doubles as the 5s poll while SSE is down. Only show the discovery
    // placeholder when there is nothing to show, or the fleet blanks every tick.
    set({ loading: get().devices.length === 0, error: null });
    try {
      const snapshot = await fetchSnapshot(api.listDevices, get().health);
      set((state) => ({
        ...snapshotPatch(state, snapshot, !isStaleSync(state, snapshot.sync)),
        loading: false,
      }));
    } catch (err) {
      set({ loading: false, error: errorMessage(err, 'Failed to load devices') });
    }
  },

  refresh: async () => {
    set({ refreshing: true, error: null });
    try {
      const snapshot = await fetchSnapshot(api.refreshDevices, get().health);
      set((state) => ({
        ...snapshotPatch(state, snapshot, !isStaleSync(state, snapshot.sync)),
        refreshing: false,
      }));
    } catch (err) {
      const message = errorMessage(err, 'Refresh failed');
      set({ refreshing: false, error: message, toast: message });
    }
  },

  reloadStatus: async (opts) => {
    const ensure = opts?.ensureLink;
    const linkPresent = (sync: SyncState) =>
      !ensure ||
      sync.groups.some(
        (g) => g.primary_id === ensure.primaryId && g.slave_ids.includes(ensure.slaveId),
      );

    const attempts = ensure ? LINK_RETRY_ATTEMPTS : 1;
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const snapshot = await fetchSnapshot(api.listDevices, get().health);
        const linked = linkPresent(snapshot.sync);
        // Until the link shows up, keep the optimistic sync graph painted.
        set((state) => snapshotPatch(state, snapshot, linked));
        if (linked) return;
      } catch (err) {
        lastError = err;
      }
      if (attempt < attempts - 1) await sleep(LINK_RETRY_MS);
    }

    if (lastError) {
      const message = errorMessage(lastError, 'Status reload failed');
      set({ error: message, toast: message });
    }
  },

  control: async (deviceId, action, optimistic) => {
    const epoch = (controlEpoch.get(deviceId) ?? 0) + 1;
    controlEpoch.set(deviceId, epoch);
    const previous = get().devices.find((d) => d.id === deviceId);
    const volumeOnly = isVolumeOnlyPatch(optimistic);
    const mutePatch = isMutePatch(optimistic);
    if (optimistic?.state !== undefined && isEstablishedPlayback(optimistic.state)) {
      get().beginHouseCatchup([deviceId]);
    }
    if (mutePatch) {
      get().holdMute(deviceId);
    } else if (!volumeOnly) {
      get().holdPlayback(deviceId);
    }
    if (optimistic?.volume !== undefined) {
      get().holdVolume(deviceId);
    }
    if (optimistic) {
      get().patchDevice(deviceId, optimistic);
    }
    try {
      await action();
      if (mutePatch) {
        get().holdMute(deviceId);
      } else if (!volumeOnly) {
        get().holdPlayback(deviceId);
      }
      if (optimistic?.volume !== undefined) {
        get().holdVolume(deviceId);
      }
    } catch (err) {
      // A newer nudge or skip owns the row. Reverting this attempt would undo it.
      if (previous && controlEpoch.get(deviceId) === epoch) {
        get().patchDevice(deviceId, previous);
      }
      set({ toast: errorToast(err, 'Control command failed') });
    }
  },
}));
