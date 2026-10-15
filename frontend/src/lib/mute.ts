import type { PlayerStatus } from '@/api/types';

type MuteFields = Pick<PlayerStatus, 'muted' | 'volume' | 'mute_volume'>;

/** Level the player returns to on unmute. BluOS reports a muted player's volume as 0. */
export function unmuteLevel(device: MuteFields): number {
  return device.muted ? (device.mute_volume ?? device.volume) : device.volume;
}

/** Optimistic state for a mute, matching what BluOS reports for a muted player. */
export function mutedPatch(device: MuteFields): Partial<PlayerStatus> {
  return { muted: true, volume: 0, mute_volume: unmuteLevel(device) };
}

/** Optimistic state for an unmute: the player returns to its own pre-mute level. */
export function unmutedPatch(device: MuteFields): Partial<PlayerStatus> {
  return { muted: false, volume: unmuteLevel(device), mute_volume: null };
}

/** Optimistic state for a room's own volume write. BluOS unmutes on any level change. */
export function ownVolumePatch(device: MuteFields | undefined, level: number): Partial<PlayerStatus> {
  return device?.muted ? { volume: level, muted: false, mute_volume: null } : { volume: level };
}

/** Rooms that a shared slider moves. Muted rooms are skipped and stay muted. */
export function audibleDevices<T extends Pick<PlayerStatus, 'muted'>>(devices: T[]): T[] {
  return devices.filter((d) => !d.muted);
}

/** Tooltip for an Unmute button, when the player reported its pre-mute level. */
export function unmuteTitle(device: MuteFields): string | undefined {
  if (!device.muted || device.mute_volume == null) return undefined;
  return `Unmute (returns to ${device.mute_volume})`;
}
