import { useEffect, useRef, useState } from 'react';
import { api } from '@/api/client';
import type { PlayerStatus, SyncState } from '@/api/types';
import { houseTransportTargets, type HouseStreamSource } from '@/lib/fleetStatus';
import { displaySyncRole } from '@/lib/syncGraph';
import { useFleetStore } from '@/store/fleetStore';

type Command = (id: string) => Promise<void>;

/** Followers of the commanded player. Direct rooms are not told to pause or skip. */
function syncedFollowerIds(
  memberIds: readonly string[],
  commandedIds: readonly string[],
  devices: readonly PlayerStatus[],
  sync: SyncState | null,
): string[] {
  const commanded = new Set(commandedIds);
  const byId = new Map(devices.map((device) => [device.id, device]));
  return memberIds.filter((id) => {
    if (commanded.has(id)) return false;
    const device = byId.get(id);
    return Boolean(device && displaySyncRole(device, sync) === 'synced');
  });
}

/**
 * Send `fn` to each target. Followers are held first and painted after, so
 * the whole group moves together even though only the lead was commanded.
 */
async function sendToTargets(
  ids: readonly string[],
  followers: readonly string[],
  fn: Command,
  optimistic?: Partial<PlayerStatus>,
): Promise<void> {
  const store = useFleetStore.getState();
  for (const id of followers) store.holdPlayback(id);
  await Promise.all(ids.map((id) => store.control(id, () => fn(id), optimistic)));
  if (!optimistic) return;
  for (const id of followers) {
    store.patchDevice(id, optimistic);
    store.holdPlayback(id);
  }
}

/** Keep the remote on the skipped players and hold them in catchup until status arrives. */
function pinSkip(pinStream: (ids: string[]) => void, ids: string[], followers: string[]): void {
  pinStream([...ids]);
  useFleetStore.getState().beginHouseCatchup([...ids, ...followers]);
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    tag === 'BUTTON' ||
    target.isContentEditable
  );
}

interface HouseTransportOptions {
  focused: HouseStreamSource | null;
  targets: string[];
  streamPlaying: boolean;
  allMuted: boolean;
  devices: PlayerStatus[];
  sync: SyncState | null;
  /** Keep the remote on these players while a skip catches up. */
  pinStream: (memberIds: string[]) => void;
}

/**
 * Transport for the focused house stream, from buttons and from the keyboard
 * (Space/K play-pause, arrows or J/L skip, M mute all). `busy` names the
 * button whose command is in flight.
 */
export function useHouseTransport(options: HouseTransportOptions) {
  const [busy, setBusy] = useState<string | null>(null);
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });

  const run = (key: string, action: () => Promise<unknown>) => {
    setBusy(key);
    void action().finally(() => setBusy(null));
  };

  const command = (
    key: string,
    fn: Command,
    optimistic?: Partial<PlayerStatus>,
    ids = options.targets,
  ) => {
    if (ids.length === 0) return;
    const { focused, devices, sync, pinStream } = options;
    const followers = syncedFollowerIds(focused?.memberIds ?? ids, ids, devices, sync);
    if (key === 'skip' || key === 'back') pinSkip(pinStream, ids, followers);
    run(key, () => sendToTargets(ids, followers, fn, optimistic));
  };

  const toggleStream = () => {
    if (!options.focused) return;
    const nextState = options.streamPlaying ? 'pause' : 'play';
    command('play', (id) => api.toggle(id), { state: nextState });
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTypingTarget(event.target)) return;
      const store = useFleetStore.getState();
      const { focused, streamPlaying, allMuted, pinStream } = latest.current;
      const ids = focused ? houseTransportTargets(focused, store.devices) : [];
      const followers = syncedFollowerIds(focused?.memberIds ?? ids, ids, store.devices, store.sync);
      const send = (fn: Command, optimistic?: Partial<PlayerStatus>) => {
        if (ids.length > 0) void sendToTargets(ids, followers, fn, optimistic);
      };
      if (event.key === ' ' || event.key === 'k') {
        if (!focused) return;
        event.preventDefault();
        send((id) => api.toggle(id), { state: streamPlaying ? 'pause' : 'play' });
      } else if (event.key === 'ArrowRight' || event.key === 'l') {
        if (ids.length === 0) return;
        event.preventDefault();
        pinSkip(pinStream, ids, followers);
        send((id) => api.skip(id));
      } else if (event.key === 'ArrowLeft' || event.key === 'j') {
        if (ids.length === 0) return;
        event.preventDefault();
        pinSkip(pinStream, ids, followers);
        send((id) => api.back(id));
      } else if (event.key === 'm' || event.key === 'M') {
        event.preventDefault();
        void store.fleetMuteAll(!allMuted);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return { busy, run, command, toggleStream };
}
