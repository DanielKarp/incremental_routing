import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DWELL_MS, HoverIntent, LEAVE_MS, REST_PX } from './hoverIntent';

describe('telling pointing at a row from passing over it', () => {
  let wanted: (string | null)[];
  let intent: HoverIntent<string>;

  beforeEach(() => {
    vi.useFakeTimers();
    wanted = [];
    intent = new HoverIntent<string>((key) => wanted.push(key));
  });
  afterEach(() => {
    intent.dispose();
    vi.useRealTimers();
  });

  it('wants a row once the pointer has rested on it', () => {
    intent.move('N', 100, 100);
    vi.advanceTimersByTime(DWELL_MS - 1);
    expect(wanted).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(wanted).toEqual(['N']);
  });

  it('wants only the row the pointer stops on when it sweeps down the list', () => {
    for (const [i, key] of ['N', 'J', 'KT', 'L', 'M'].entries()) {
      intent.move(key, 100, 100 + i * 40);
      vi.advanceTimersByTime(DWELL_MS / 2);
    }
    vi.advanceTimersByTime(DWELL_MS);
    expect(wanted).toEqual(['M']);
  });

  it('keeps waiting through a little jitter, but starts again when the pointer moves on', () => {
    intent.move('N', 100, 100);
    vi.advanceTimersByTime(DWELL_MS - 100);
    intent.move('N', 100 + REST_PX, 100); // A hand on the mouse.
    vi.advanceTimersByTime(100);
    expect(wanted).toEqual(['N']);

    intent.move('N', 100 + 3 * REST_PX, 100); // Moving along the row: still the same row.
    vi.advanceTimersByTime(DWELL_MS);
    expect(wanted).toEqual(['N']);
  });

  it('starts again on another row however close the pointer stays', () => {
    intent.move('N', 100, 100);
    vi.advanceTimersByTime(DWELL_MS - 100);
    intent.move('J', 100, 102); // Across the border between two rows.
    vi.advanceTimersByTime(100);
    expect(wanted).toEqual([]);
    vi.advanceTimersByTime(DWELL_MS);
    expect(wanted).toEqual(['J']);
  });

  it('wants nothing that scrolls under a pointer that stays put', () => {
    intent.move('N', 100, 100);
    vi.advanceTimersByTime(DWELL_MS - 100);
    intent.scroll();
    // The browser says the pointer is over each row the list brings under it.
    intent.move('J', 100, 100);
    vi.advanceTimersByTime(100);
    intent.scroll();
    intent.move('KT', 100, 101);
    vi.advanceTimersByTime(5 * DWELL_MS);
    expect(wanted).toEqual([]);

    // Moving the pointer to it, though, means it.
    intent.move('KT', 100, 100 + 2 * REST_PX);
    vi.advanceTimersByTime(DWELL_MS);
    expect(wanted).toEqual(['KT']);
  });

  it('keeps the row it wanted while the list scrolls', () => {
    intent.move('N', 100, 100);
    vi.advanceTimersByTime(DWELL_MS);
    intent.scroll();
    intent.move('J', 100, 100);
    vi.advanceTimersByTime(5 * DWELL_MS);
    expect(wanted).toEqual(['N']);
  });

  it('wants nothing once the pointer has left the list for a moment', () => {
    intent.move('N', 100, 100);
    vi.advanceTimersByTime(DWELL_MS);
    intent.leave();
    vi.advanceTimersByTime(LEAVE_MS - 1);
    expect(wanted).toEqual(['N']);
    vi.advanceTimersByTime(1);
    expect(wanted).toEqual(['N', null]);
  });

  it("doesn't let go when the pointer slips off the list and straight back", () => {
    intent.move('N', 100, 100);
    vi.advanceTimersByTime(DWELL_MS);
    intent.leave();
    vi.advanceTimersByTime(LEAVE_MS / 2);
    intent.move('N', 100, 104);
    vi.advanceTimersByTime(5 * LEAVE_MS);
    expect(wanted).toEqual(['N']);
  });

  it("says nothing on leaving when nothing was wanted, or when it's left twice", () => {
    intent.move('N', 100, 100);
    intent.leave();
    vi.advanceTimersByTime(5 * DWELL_MS);
    expect(wanted).toEqual([]);

    intent.move('J', 100, 140);
    vi.advanceTimersByTime(DWELL_MS);
    intent.leave();
    intent.leave();
    vi.advanceTimersByTime(5 * LEAVE_MS);
    expect(wanted).toEqual(['J', null]);
  });

  it('wants a row keyboard focus stays on, but not each one tabbed past', () => {
    intent.focus('N');
    vi.advanceTimersByTime(DWELL_MS / 4);
    intent.leave(); // Blur, then focus on the next row.
    intent.focus('J');
    vi.advanceTimersByTime(DWELL_MS / 4);
    intent.leave();
    intent.focus('KT');
    vi.advanceTimersByTime(DWELL_MS);
    expect(wanted).toEqual(['KT']);
  });

  it('wants a row keyboard focus scrolled into view', () => {
    intent.focus('J');
    intent.scroll(); // The browser brings the focused row into view.
    vi.advanceTimersByTime(DWELL_MS);
    expect(wanted).toEqual(['J']);
  });

  it('lets go of the wanted row, and stops waiting, when the list goes', () => {
    intent.move('N', 100, 100);
    vi.advanceTimersByTime(DWELL_MS);
    intent.move('J', 100, 140);
    intent.dispose();
    vi.advanceTimersByTime(5 * DWELL_MS);
    expect(wanted).toEqual(['N', null]);
  });
});
