import { describe, expect, it } from 'vitest';
import { formatDeviceHardware, formatDeviceHost } from '@/lib/endpoint';

describe('formatDeviceHardware', () => {
  it('appends CI zone next to the model', () => {
    expect(
      formatDeviceHardware({
        full_model: 'NAD CI S2',
        model: 'CI S2',
        zone: 1,
      }),
    ).toBe('NAD CI S2 / Zone 1');
    expect(
      formatDeviceHardware({
        full_model: 'NAD CI S2',
        model: 'CI S2',
        zone: 2,
      }),
    ).toBe('NAD CI S2 / Zone 2');
  });

  it('keeps ordinary players unlabeled', () => {
    expect(
      formatDeviceHardware({
        full_model: 'Bluesound NODE',
        model: 'NODE',
        zone: null,
      }),
    ).toBe('Bluesound NODE');
  });
});

describe('formatDeviceHost', () => {
  it('omits the default BluOS port', () => {
    expect(formatDeviceHost({ ip: '192.168.1.30', port: 11000 })).toBe('192.168.1.30');
    expect(formatDeviceHost({ ip: '192.168.1.30', port: 11010 })).toBe('192.168.1.30:11010');
  });
});
