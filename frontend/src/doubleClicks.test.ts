import { describe, expect, it } from 'vitest';
import { DoubleClicks } from './doubleClicks';

// Stand-ins for the elements clicked.
const remove = { name: 'Remove this and the 3 after' } as unknown as EventTarget;
const backward = { name: 'Before the start' } as unknown as EventTarget;

describe('the second click of a double-click', () => {
  it('is dropped when it lands on what took the place of the first click', () => {
    const clicks = new DoubleClicks();
    expect(clicks.strays({ detail: 1, target: remove })).toBe(false);
    expect(clicks.strays({ detail: 2, target: backward })).toBe(true);
    // A triple click's third too.
    expect(clicks.strays({ detail: 3, target: backward })).toBe(true);
  });

  it('is left to the control when it lands where the first did', () => {
    const clicks = new DoubleClicks();
    expect(clicks.strays({ detail: 1, target: backward })).toBe(false);
    expect(clicks.strays({ detail: 2, target: backward })).toBe(false);
  });

  it('never drops a single click, or a click from the keyboard', () => {
    const clicks = new DoubleClicks();
    expect(clicks.strays({ detail: 1, target: remove })).toBe(false);
    expect(clicks.strays({ detail: 1, target: backward })).toBe(false);
    expect(clicks.strays({ detail: 0, target: remove })).toBe(false);
  });

  it('starts again with each double-click', () => {
    const clicks = new DoubleClicks();
    clicks.strays({ detail: 1, target: remove });
    expect(clicks.strays({ detail: 2, target: backward })).toBe(true);
    expect(clicks.strays({ detail: 1, target: backward })).toBe(false);
    expect(clicks.strays({ detail: 2, target: backward })).toBe(false);
  });
});
