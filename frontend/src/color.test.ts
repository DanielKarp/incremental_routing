import { describe, expect, it } from 'vitest';
import { isPale } from './color';

describe('isPale', () => {
  it('picks out route colours too light for the map by themselves', () => {
    expect(isPale('FFFF33')).toBe(true); // BART yellow
    expect(isPale('dcddde')).toBe(true); // Caltrain local
    expect(isPale('0099CC')).toBe(false); // BART blue
    expect(isPale('E31837')).toBe(false);
    expect(isPale('FAA61A')).toBe(false); // orange is dark enough
  });

  it('treats a missing or malformed colour as the default, which is dark', () => {
    expect(isPale(null)).toBe(false);
    expect(isPale(undefined)).toBe(false);
    expect(isPale('FFF')).toBe(false);
  });
});
