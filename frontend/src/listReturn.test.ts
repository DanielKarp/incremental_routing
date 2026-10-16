import { describe, expect, it } from 'vitest';
import { returnScrollTop } from './listReturn';

const spot = { key: 'caltrain', scrollTop: 1036, rowTop: 1340 };

describe('putting the list of lines back after the stop chooser', () => {
  it('scrolls exactly as before while the row is where it was', () => {
    expect(returnScrollTop(spot, 1340)).toBe(1036);
    expect(returnScrollTop(spot, 1340.4)).toBe(1036); // Not a move, just rounding.
    expect(returnScrollTop({ ...spot, scrollTop: 1036.5 }, 1340)).toBe(1036.5);
  });

  it('follows the row when it has moved, so it is back where it was on screen', () => {
    // A notice above the list has gone, so the row is 60 px higher in the panel.
    expect(returnScrollTop(spot, 1280)).toBe(976);
    // The list was found again, and the line is further down it.
    expect(returnScrollTop(spot, 2500)).toBe(2196);
    // Never above the top of the panel.
    expect(returnScrollTop({ ...spot, scrollTop: 20 }, 1200)).toBe(0);
  });

  it("scrolls as before when the line isn't listed any more, or wasn't then", () => {
    expect(returnScrollTop(spot, null)).toBe(1036);
    expect(returnScrollTop({ ...spot, rowTop: null }, 1340)).toBe(1036);
  });
});
