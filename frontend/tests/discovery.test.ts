import { describe, expect, it } from 'vitest';
import { discoveryLabel, playerCountLabel } from '@/lib/discovery';

describe('discoveryLabel', () => {
  it('names known discovery methods', () => {
    expect(discoveryLabel('mdns+lsdp')).toBe('mDNS + LSDP');
    expect(discoveryLabel('both')).toBe('mDNS + LSDP');
    expect(discoveryLabel('lsdp')).toBe('LSDP');
  });

  it('passes unknown methods through', () => {
    expect(discoveryLabel('static')).toBe('static');
    expect(discoveryLabel('')).toBe('');
  });
});

describe('playerCountLabel', () => {
  it('singularizes one player', () => {
    expect(playerCountLabel(1)).toBe('1 player');
    expect(playerCountLabel(0)).toBe('0 players');
    expect(playerCountLabel(10)).toBe('10 players');
  });
});
