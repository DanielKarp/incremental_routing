import { describe, expect, it } from 'vitest';
import { scrollToShow, startsHigh } from './scroll';

describe('how far the panel scrolls to show something', () => {
  // The panel from y = 0 to 1000, with the bar with Undo stuck over its foot from 945.
  it("doesn't scroll for something in view, so a smooth scroll on its way goes on", () => {
    expect(scrollToShow(100, 200, 0, 945)).toBe(0);
    expect(scrollToShow(0, 945, 0, 945)).toBe(0);
    // The missed-trip warning in the stop chooser's header, stuck at the top of the panel.
    expect(scrollToShow(82, 211, 0, 945)).toBe(0);
  });

  it('scrolls down just far enough, clear of the bar', () => {
    // A departure button under the bar, as Tab leaves it.
    expect(scrollToShow(972, 1000, 0, 945)).toBe(67);
    expect(scrollToShow(930, 958, 0, 945)).toBe(25);
    expect(scrollToShow(1200, 1240, 0, 945)).toBe(307);
  });

  it('scrolls up just far enough, clear of the stuck header', () => {
    // A stop under the stop chooser's header, which ends at 69.
    expect(scrollToShow(36, 72, 69, 945)).toBe(-45);
    expect(scrollToShow(-500, -460, 0, 945)).toBe(-512);
  });

  it('brings something taller than the room to its top, so its beginning shows', () => {
    // Next leg after an add on a phone on its side: 375 px tall, with 320 px above the bar.
    expect(scrollToShow(-72, 303, 0, 320)).toBe(-84);
    expect(scrollToShow(100, 500, 0, 320)).toBe(88);
    expect(scrollToShow(100, 397, 0, 320)).toBe(88);
    // Not when it fits with room to spare: then it comes to the foot.
    expect(scrollToShow(100, 395, 0, 320)).toBe(87);
  });
});

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
