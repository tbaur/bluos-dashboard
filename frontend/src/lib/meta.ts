/**
 * Separator for compact meta lines (volume/dB, service/format, status chips).
 * Slash stays legible next to signed values like ``-28.9 dB``; middots do not.
 */
export const META_SEP = ' / ';

export function joinMeta(
  ...parts: Array<string | number | null | undefined | false>
): string {
  return parts.filter((part): part is string | number => Boolean(part)).join(META_SEP);
}

const TITLE_SEP = ' — ';

/** Track — artist, but never "Mossera — Mossera" when BluOS repeats the name. */
export function formatTrackArtist(track: string, artist: string): string {
  const title = track.trim();
  const name = artist.trim();
  if (!title) return name;
  if (!name) return title;
  if (title.localeCompare(name, undefined, { sensitivity: 'accent' }) === 0) {
    return title;
  }
  return `${title}${TITLE_SEP}${name}`;
}
