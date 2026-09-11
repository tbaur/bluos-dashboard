/** Artwork URL vetting for images supplied by LAN players. */

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);
const INLINE_IMAGE = /^data:image\/(?:png|jpeg|jpg|gif|webp|avif);/i;

/**
 * Album art URLs arrive from BluOS players and the streaming services behind
 * them, so they are untrusted strings. Permit only http(s), same-origin paths,
 * and inline images; anything else (javascript:, file:, blob:) yields '' so the
 * caller renders its empty state instead.
 */
export function safeImageSrc(src: string | null | undefined): string {
  const value = (src ?? '').trim();
  if (!value) return '';
  if (INLINE_IMAGE.test(value)) return value;
  try {
    const url = new URL(value, window.location.origin);
    return ALLOWED_PROTOCOLS.has(url.protocol) ? value : '';
  } catch {
    return '';
  }
}
