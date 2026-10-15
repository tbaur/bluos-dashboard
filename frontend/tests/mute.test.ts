import { describe, expect, it } from 'vitest';
import {
  audibleDevices,
  mutedPatch,
  ownVolumePatch,
  unmutedPatch,
  unmuteLevel,
  unmuteTitle,
} from '@/lib/mute';

const audible = { muted: false, volume: 60, mute_volume: null };
const muted = { muted: true, volume: 0, mute_volume: 50 };

describe('mute helpers', () => {
  it('unmuteLevel uses muteVolume while muted and the volume otherwise', () => {
    expect(unmuteLevel(audible)).toBe(60);
    expect(unmuteLevel(muted)).toBe(50);
    expect(unmuteLevel({ muted: true, volume: 0 })).toBe(0);
  });

  it('mute and unmute patches match what BluOS reports', () => {
    expect(mutedPatch(audible)).toEqual({ muted: true, volume: 0, mute_volume: 60 });
    expect(unmutedPatch(muted)).toEqual({ muted: false, volume: 50, mute_volume: null });
  });

  it("a room's own volume write unmutes it", () => {
    expect(ownVolumePatch(muted, 40)).toEqual({ volume: 40, muted: false, mute_volume: null });
    expect(ownVolumePatch(audible, 40)).toEqual({ volume: 40 });
    expect(ownVolumePatch(undefined, 40)).toEqual({ volume: 40 });
  });

  it('audibleDevices drops muted rooms', () => {
    expect(audibleDevices([audible, muted])).toEqual([audible]);
  });

  it('unmuteTitle names the return level only when the player reported one', () => {
    expect(unmuteTitle(muted)).toBe('Unmute (returns to 50)');
    expect(unmuteTitle(audible)).toBeUndefined();
    expect(unmuteTitle({ muted: true, volume: 0, mute_volume: null })).toBeUndefined();
  });
});
