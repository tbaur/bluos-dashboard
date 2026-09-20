import type { PlayerStatus } from '@/api/types';

export type VolumePeerGroup = 'bluesound' | 'ci-s2' | 'independent';

type DeviceModelFields = Pick<PlayerStatus, 'model' | 'brand' | 'full_model'>;

function normalizeModelText(...parts: Array<string | undefined | null>): string {
  return parts
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Bluesound / bluesound.com players (Pulse, Node, and other same-scale rooms). */
export function isBluesoundDevice(device: DeviceModelFields): boolean {
  const text = normalizeModelText(device.brand, device.model, device.full_model);
  if (!text) return false;
  const compact = text.replace(/\s+/g, '');
  return text.includes('bluesound') || compact.includes('bluesoundcom');
}

/** NAD CI S2 zones — different amp power / volume scale than residential BluOS. */
export function isCiS2Device(device: DeviceModelFields): boolean {
  const text = normalizeModelText(device.brand, device.model, device.full_model);
  if (!text) return false;
  const compact = text.replace(/\s+/g, '');
  return text.includes('ci s2') || compact.includes('cis2');
}

/** House-slider peer set. CI S2 wins over a Bluesound brand string. */
export function volumePeerGroup(device: DeviceModelFields): VolumePeerGroup {
  if (isCiS2Device(device)) return 'ci-s2';
  if (isBluesoundDevice(device)) return 'bluesound';
  return 'independent';
}

export function partitionVolumeGroups(devices: PlayerStatus[]): {
  bluesound: PlayerStatus[];
  ciS2: PlayerStatus[];
  independent: PlayerStatus[];
} {
  const bluesound: PlayerStatus[] = [];
  const ciS2: PlayerStatus[] = [];
  const independent: PlayerStatus[] = [];
  for (const device of devices) {
    const group = volumePeerGroup(device);
    if (group === 'ci-s2') ciS2.push(device);
    else if (group === 'bluesound') bluesound.push(device);
    else independent.push(device);
  }
  return { bluesound, ciS2, independent };
}
