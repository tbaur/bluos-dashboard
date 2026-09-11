import { describe, expect, it } from 'vitest';
import { safeImageSrc } from '@/lib/artwork';

describe('safeImageSrc', () => {
  it('allows player and CDN artwork over http(s)', () => {
    expect(safeImageSrc('http://192.168.1.10:11000/Artwork?service=Local')).toBe(
      'http://192.168.1.10:11000/Artwork?service=Local',
    );
    expect(safeImageSrc('https://cdn.example.com/a.jpg')).toBe(
      'https://cdn.example.com/a.jpg',
    );
  });

  it('allows same-origin paths', () => {
    expect(safeImageSrc('/assets/cover.png')).toBe('/assets/cover.png');
  });

  it('allows inline images', () => {
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    expect(safeImageSrc(png)).toBe(png);
  });

  it('rejects script and other hostile schemes from a device', () => {
    expect(safeImageSrc('javascript:alert(1)')).toBe('');
    expect(safeImageSrc('JavaScript:alert(1)')).toBe('');
    expect(safeImageSrc('file:///etc/passwd')).toBe('');
    expect(safeImageSrc('data:text/html,<script>alert(1)</script>')).toBe('');
  });

  it('treats blank and missing artwork as empty', () => {
    expect(safeImageSrc('')).toBe('');
    expect(safeImageSrc('   ')).toBe('');
    expect(safeImageSrc(null)).toBe('');
    expect(safeImageSrc(undefined)).toBe('');
  });
});
