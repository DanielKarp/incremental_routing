import { describe, expect, it } from 'vitest';
import { startsHigh } from './scroll';

describe('whether the stop chooser needs bringing up', () => {
  // A panel from y = 0 to 1000.
  it('leaves it where it starts in the upper half of the panel', () => {
    expect(startsHigh(0, 0, 1000)).toBe(true);
    expect(startsHigh(480, 0, 1000)).toBe(true);
    expect(startsHigh(500, 0, 1000)).toBe(true);
  });

  it('brings it up when it starts above the panel, or low in it, or below it', () => {
    expect(startsHigh(-621, 0, 1000)).toBe(false); // Picked from far down the list.
    expect(startsHigh(-1, 0, 1000)).toBe(false);
    expect(startsHigh(501, 0, 1000)).toBe(false);
    expect(startsHigh(1400, 0, 1000)).toBe(false);
  });

  it('measures from where the panel is, as on a phone under the map', () => {
    expect(startsHigh(400, 380, 1000)).toBe(true);
    expect(startsHigh(300, 380, 1000)).toBe(false);
    expect(startsHigh(800, 380, 1000)).toBe(false);
  });
});
