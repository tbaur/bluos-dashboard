import { create } from 'zustand';
import { api } from '@/api/client';
import type { FleetHealthResponse, PlayerStatus, SyncState } from '@/api/types';
import { ApiError } from '@/api/types';
import {
  houseCatchupSession,
  houseStoppedSession,
  LIVE_HOUSE_SESSION,
  type HouseSession,
} from '@/lib/houseSession';

export type ConnectionState = 'connecting' | 'live' | 'reconnecting' | 'offline';

const VOLUME_HOLD_MS = 2500;
const PLAYBACK_HOLD_MS = 2000;
const MUTE_HOLD_MS = 4500;
const HOUSE_CATCHUP_MS = 10_000;

let houseCatchupTimer: number | undefined;

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
  /** Ignore stale sync snapshots while BluOS catches up after AddSlave. */
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

function activeHouseIds(devices: PlayerStatus[], extra: string[]): string[] {
  const ids = new Set(extra);
  for (const device of devices) {
    if (
      device.state === 'play' ||
      device.state === 'stream' ||
      device.state === 'connecting'
    ) {
      ids.add(device.id);
    }
  }
  return [...ids];
}

function stampHold(
  current: Record<string, number>,
  ids: Iterable<string>,
  until: number,
): Record<string, number> {
  const next = { ...current };
  for (const id of ids) {
    next[id] = until;
  }
  return next;
}

/** Freeze transport/now-playing; mute and volume have their own holds. */
function applyPlaybackHold(incoming: PlayerStatus, previous: PlayerStatus): PlayerStatus {
  const keepMeta = !hasTrackMeta(incoming) && hasTrackMeta(previous);
  const keepSecs = keepMeta || (hasTrackMeta(incoming) && isSameTrack(incoming, previous));
  const meta = keepMeta ? previous : incoming;
  return {
    ...incoming,
    state: previous.state,
    shuffle: previous.shuffle,
    repeat: previous.repeat,
    secs: keepSecs ? previous.secs : incoming.secs,
    track: meta.track,
    artist: meta.artist,
    album: meta.album,
    image: previous.image || incoming.image,
    totlen: keepMeta || incoming.totlen <= 0 ? previous.totlen : incoming.totlen,
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
  return (
    Date.now() < state.syncHoldUntil &&
    (state.sync?.groups.length ?? 0) > 0 &&
    (incoming?.groups.length ?? 0) < (state.sync?.groups.length ?? 0)
  );
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
      devices: mergedDeviceList(state, devices),
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
      return {
        devices: exists
          ? state.devices.map((d) => (d.id === device.id ? merged : d))
          : [...state.devices, merged],
      };
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

  holdSync: (ms = 5000) => set({ syncHoldUntil: Date.now() + ms }),

  setConnection: (connection) => set({ connection }),
  setSync: (sync) =>
    set((state) => {
      // Drop stale sync while BluOS catches up after AddSlave (SSE often races ahead).
      if (isStaleSync(state, sync)) return {};
      return { sync, syncHoldUntil: 0 };
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

    if (scoped) {
      get().holdVolumes(ids);
      get().setVolumesLocal(clamped, ids);
    } else {
      get().holdAllVolumes();
      get().setAllVolumesLocal(clamped);
    }
    try {
      const result = await api.setFleetVolume(clamped, scoped ? ids : undefined);
      if (scoped) {
        get().holdVolumes(ids);
        get().setVolumesLocal(clamped, ids);
      } else {
        get().holdAllVolumes();
        get().setAllVolumesLocal(clamped);
      }
      if (clamped > 0) {
        set((state) => {
          const lastAudibleVolume = { ...state.lastAudibleVolume };
          for (const id of ids) {
            lastAudibleVolume[id] = clamped;
          }
          return { lastAudibleVolume };
        });
      }
      if (result.failed > 0) {
        set({
          toast: `Volume ${clamped}: ${result.succeeded} ok, ${result.failed} failed`,
        });
      }
    } catch (err) {
      set({
        globalVolumeHoldUntil: scoped ? get().globalVolumeHoldUntil : 0,
        toast:
          err instanceof ApiError
            ? `${err.message} (${err.requestId})`
            : 'Failed to set volume',
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
      const restore =
        get().lastAudibleVolume[deviceId] ??
        (device.volume > 0 ? device.volume : 20);
      await get().control(
        deviceId,
        () => api.setMute(deviceId, false),
        { muted: false, volume: restore },
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

    if (mute) {
      set((state) => {
        const lastAudibleVolume = { ...state.lastAudibleVolume };
        const until = Date.now() + MUTE_HOLD_MS;
        const ids = state.devices.map((d) => d.id);
        for (const device of state.devices) {
          if (device.volume > 0) lastAudibleVolume[device.id] = device.volume;
        }
        return {
          lastAudibleVolume,
          muteHoldUntil: stampHold(state.muteHoldUntil, ids, until),
          volumeHoldUntil: stampHold(state.volumeHoldUntil, ids, until),
          devices: state.devices.map((d) => ({ ...d, muted: true, volume: 0 })),
        };
      });
    } else {
      set((state) => {
        const until = Date.now() + MUTE_HOLD_MS;
        const ids = state.devices.map((d) => d.id);
        return {
          muteHoldUntil: stampHold(state.muteHoldUntil, ids, until),
          volumeHoldUntil: stampHold(state.volumeHoldUntil, ids, until),
          devices: state.devices.map((d) => ({
            ...d,
            muted: false,
            volume: state.lastAudibleVolume[d.id] ?? (d.volume > 0 ? d.volume : 20),
          })),
        };
      });
    }

    try {
      const result = await api.fleetMute(mute);
      if (result.failed > 0) {
        set({
          toast: `Fleet ${mute ? 'mute' : 'unmute'}: ${result.succeeded} ok, ${result.failed} failed`,
        });
      }
    } catch (err) {
      // Undo the optimistic paint and release the holds so server truth returns.
      set((state) => ({
        devices: revertFields(state.devices, before, ['muted', 'volume']),
        muteHoldUntil: releaseHold(state.muteHoldUntil, before.keys()),
        volumeHoldUntil: releaseHold(state.volumeHoldUntil, before.keys()),
        toast:
          err instanceof ApiError
            ? `${err.message} (${err.requestId})`
            : 'Fleet mute failed',
      }));
    }
  },

  fleetPauseAll: async () => {
    const before = new Map(get().devices.map((d) => [d.id, d]));
    set((state) => {
      const playbackHoldUntil = { ...state.playbackHoldUntil };
      const until = Date.now() + MUTE_HOLD_MS;
      for (const device of state.devices) {
        playbackHoldUntil[device.id] = until;
      }
      return {
        playbackHoldUntil,
        devices: state.devices.map((d) => ({
          ...d,
          state: d.state === 'play' || d.state === 'stream' ? 'pause' : d.state,
        })),
      };
    });
    try {
      const result = await api.fleetPause();
      if (result.failed > 0) {
        set({
          toast: `Pause all: ${result.succeeded} ok, ${result.failed} failed`,
        });
      }
    } catch (err) {
      set((state) => ({
        devices: revertFields(state.devices, before, ['state']),
        playbackHoldUntil: releaseHold(state.playbackHoldUntil, before.keys()),
        toast:
          err instanceof ApiError
            ? `${err.message} (${err.requestId})`
            : 'Pause all failed',
      }));
    }
  },

  fleetStopAll: async () => {
    const before = new Map(get().devices.map((d) => [d.id, d]));
    get().beginHouseStopped();
    set((state) => {
      const until = Date.now() + MUTE_HOLD_MS;
      const ids = state.devices.map((d) => d.id);
      return {
        playbackHoldUntil: stampHold(state.playbackHoldUntil, ids, until),
        devices: state.devices.map((d) => ({ ...d, state: 'stop' })),
      };
    });
    try {
      const result = await api.fleetStop();
      if (result.failed > 0) {
        set({
          toast: `Stop all: ${result.succeeded} ok, ${result.failed} failed`,
        });
      }
    } catch (err) {
      // Also drop the "stopped" house session — nothing actually stopped.
      clearHouseCatchupTimer();
      set((state) => ({
        devices: revertFields(state.devices, before, ['state']),
        playbackHoldUntil: releaseHold(state.playbackHoldUntil, before.keys()),
        houseSession: LIVE_HOUSE_SESSION,
        toast:
          err instanceof ApiError
            ? `${err.message} (${err.requestId})`
            : 'Stop all failed',
      }));
    }
  },

  fleetRebootAll: async () => {
    const count = get().devices.length;
    if (count === 0) return;
    try {
      const result = await api.fleetReboot();
      if (result.failed > 0) {
        set({
          toast: `Reboot: ${result.succeeded} ok, ${result.failed} failed`,
        });
      } else {
        set({
          toast: `Reboot sent to ${result.succeeded} player${result.succeeded === 1 ? '' : 's'}`,
        });
      }
    } catch (err) {
      set({
        toast:
          err instanceof ApiError
            ? `${err.message} (${err.requestId})`
            : 'Fleet reboot failed',
      });
    }
  },

  load: async () => {
    // `load` doubles as the 5s poll while SSE is down. Only show the discovery
    // placeholder when there is nothing to show, or the fleet blanks every tick.
    set({ loading: get().devices.length === 0, error: null });
    try {
      const [fleet, sync, health] = await Promise.all([
        api.listDevices(),
        api.getSync(),
        api.getFleetHealth().catch(() => get().health),
      ]);
      set((state) => ({
        devices: mergedDeviceList(state, fleet.devices),
        ...prunedHolds(state, fleet.devices),
        discoveredAt: fleet.discovered_at,
        discoveryMethod: fleet.discovery_method,
        ...(isStaleSync(state, sync) ? {} : { sync, syncHoldUntil: 0 }),
        health: health ?? state.health,
        loading: false,
      }));
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Failed to load devices';
      set({ loading: false, error: message });
    }
  },

  refresh: async () => {
    set({ refreshing: true, error: null });
    try {
      const [fleet, sync, health] = await Promise.all([
        api.refreshDevices(),
        api.getSync(),
        api.getFleetHealth().catch(() => get().health),
      ]);
      set((state) => ({
        devices: mergedDeviceList(state, fleet.devices),
        ...prunedHolds(state, fleet.devices),
        discoveredAt: fleet.discovered_at,
        discoveryMethod: fleet.discovery_method,
        ...(isStaleSync(state, sync) ? {} : { sync, syncHoldUntil: 0 }),
        health: health ?? state.health,
        refreshing: false,
      }));
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Refresh failed';
      set({ refreshing: false, error: message, toast: message });
    }
  },

  reloadStatus: async (opts) => {
    const ensure = opts?.ensureLink;
    const linkPresent = (sync: SyncState | null | undefined) => {
      if (!ensure) return true;
      return Boolean(
        sync?.groups.some(
          (g) =>
            g.primary_id === ensure.primaryId && g.slave_ids.includes(ensure.slaveId),
        ),
      );
    };

    const attempts = ensure ? 16 : 1;
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const [fleet, sync, health] = await Promise.all([
          api.listDevices(),
          api.getSync(),
          api.getFleetHealth().catch(() => get().health),
        ]);
        if (!linkPresent(sync)) {
          // BluOS SyncStatus often lags AddSlave — keep optimistic sync painted.
          set((state) => ({
            devices: mergedDeviceList(state, fleet.devices),
            ...prunedHolds(state, fleet.devices),
            discoveredAt: fleet.discovered_at,
            discoveryMethod: fleet.discovery_method,
            health: health ?? state.health,
          }));
          await new Promise((r) => window.setTimeout(r, 200));
          continue;
        }
        set((state) => ({
          devices: mergedDeviceList(state, fleet.devices),
          ...prunedHolds(state, fleet.devices),
          discoveredAt: fleet.discovered_at,
          discoveryMethod: fleet.discovery_method,
          sync,
          health: health ?? state.health,
          syncHoldUntil: 0,
        }));
        return;
      } catch (err) {
        lastError = err;
        if (attempt < attempts - 1) {
          await new Promise((r) => window.setTimeout(r, 200));
          continue;
        }
      }
    }

    if (lastError) {
      const message =
        lastError instanceof ApiError ? lastError.message : 'Status reload failed';
      set({ error: message, toast: message });
    }
  },

  control: async (deviceId, action, optimistic) => {
    const previous = get().devices.find((d) => d.id === deviceId);
    const volumeOnly = isVolumeOnlyPatch(optimistic);
    const mutePatch = isMutePatch(optimistic);
    if (optimistic?.state === 'play' || optimistic?.state === 'stream') {
      get().beginHouseCatchup(activeHouseIds(get().devices, [deviceId]));
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
      if (previous) {
        get().patchDevice(deviceId, previous);
      }
      const message =
        err instanceof ApiError
          ? `${err.message} (${err.requestId})`
          : 'Control command failed';
      set({ toast: message });
    }
  },
}));
