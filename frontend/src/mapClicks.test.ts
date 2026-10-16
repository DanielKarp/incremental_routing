import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DOUBLE_CLICK_MS,
  DOUBLE_TAP_MS,
  NUDGE_PAUSE_MS,
  PinDrop,
  SingleClick,
  clickWaitMs,
  emptyClick,
  isRepeatClick,
  mapMenuItems,
} from './mapClicks';

describe('a click on empty map', () => {
  it('sets the start when there is none, and moves it after Move', () => {
    expect(emptyClick({ hasStart: false, movingStart: false, pathMode: false })).toBe('start');
    expect(emptyClick({ hasStart: false, movingStart: false, pathMode: true })).toBe('start');
    expect(emptyClick({ hasStart: true, movingStart: true, pathMode: true })).toBe('start');
  });

  it('picks where to walk or bike in Walk and Bike mode', () => {
    expect(emptyClick({ hasStart: true, movingStart: false, pathMode: true })).toBe('path');
  });

  it('opens the menu in Transit and Wait mode, rather than moving the start', () => {
    expect(emptyClick({ hasStart: true, movingStart: false, pathMode: false })).toBe('menu');
  });
});

describe('the map menu', () => {
  const labels = (state: Parameters<typeof mapMenuItems>[0]) =>
    mapMenuItems(state).map((item) => item.label);

  it('offers to move the start first, before the first leg', () => {
    expect(labels({ startMovable: true, canAddLegs: true, direction: 'forward' })).toEqual([
      'Move the start here',
      'Walk here',
      'Bike here',
    ]);
  });

  it('follows the direction once the plan has legs', () => {
    expect(labels({ startMovable: false, canAddLegs: true, direction: 'forward' })).toEqual([
      'Walk here',
      'Bike here',
    ]);
    expect(labels({ startMovable: false, canAddLegs: true, direction: 'backward' })).toEqual([
      'Walk from here',
      'Bike from here',
    ]);
  });

  it('only moves the start while the time can’t be read, and is empty without a start', () => {
    expect(labels({ startMovable: true, canAddLegs: false, direction: 'forward' })).toEqual([
      'Move the start here',
    ]);
    expect(labels({ startMovable: false, canAddLegs: false, direction: 'forward' })).toEqual([]);
  });

  it('names each choice by what it does', () => {
    const ids = mapMenuItems({ startMovable: true, canAddLegs: true, direction: 'backward' });
    expect(ids.map((item) => item.id)).toEqual(['move', 'walk', 'bike']);
  });
});

describe('telling a click from a double-click', () => {
  let acted: string[];
  let click: SingleClick;

  beforeEach(() => {
    vi.useFakeTimers();
    acted = [];
    click = new SingleClick();
  });
  afterEach(() => {
    click.cancel();
    vi.useRealTimers();
  });

  it('acts on a single click once it is clear no second click follows', () => {
    click.wait(() => acted.push('a'));
    vi.advanceTimersByTime(DOUBLE_CLICK_MS - 1);
    expect(acted).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(acted).toEqual(['a']);
  });

  it('does nothing for a double-click', () => {
    click.wait(() => acted.push('a'));
    vi.advanceTimersByTime(DOUBLE_CLICK_MS / 2);
    click.cancel(); // The dblclick event.
    vi.advanceTimersByTime(DOUBLE_CLICK_MS);
    expect(acted).toEqual([]);
  });

  it('acts on the newest of two quick clicks only', () => {
    click.wait(() => acted.push('a'));
    vi.advanceTimersByTime(DOUBLE_CLICK_MS / 2);
    click.wait(() => acted.push('b'));
    vi.advanceTimersByTime(DOUBLE_CLICK_MS);
    expect(acted).toEqual(['b']);
  });

  it('waits longer after a tap: MapLibre takes taps up to 500 ms apart as a double tap', () => {
    expect(clickWaitMs(false)).toBe(DOUBLE_CLICK_MS);
    expect(clickWaitMs(true)).toBe(DOUBLE_TAP_MS);
    click.wait(() => acted.push('tap'), clickWaitMs(true));
    vi.advanceTimersByTime(400);
    click.cancel(); // The second tap's touchstart.
    vi.advanceTimersByTime(DOUBLE_TAP_MS);
    expect(acted).toEqual([]);
    click.wait(() => acted.push('tap'), clickWaitMs(true));
    vi.advanceTimersByTime(DOUBLE_TAP_MS);
    expect(acted).toEqual(['tap']);
  });

  it('drops the second click of a slow double-click', () => {
    expect(isRepeatClick({ detail: 1 })).toBe(false);
    expect(isRepeatClick({ detail: 2 })).toBe(true);
    expect(isRepeatClick({ detail: 3 })).toBe(true);
    // Synthetic clicks (and some taps) aren't counted at all.
    expect(isRepeatClick({ detail: 0 })).toBe(false);
  });
});

describe('dropping a dragged pin', () => {
  let drops: string[];
  let pin: PinDrop;

  beforeEach(() => {
    vi.useFakeTimers();
    drops = [];
    pin = new PinDrop();
  });
  afterEach(() => {
    pin.cancel();
    vi.useRealTimers();
  });

  it('drops it at once after a drag with the mouse or a finger', () => {
    pin.dragEnd(false, () => drops.push('mouse'));
    expect(drops).toEqual(['mouse']);
  });

  it('makes arrow-key presses in a row one move, once they pause', () => {
    for (const at of ['1 px', '2 px', '3 px']) {
      pin.dragEnd(true, () => drops.push(at));
      vi.advanceTimersByTime(NUDGE_PAUSE_MS - 100);
    }
    expect(drops).toEqual([]);
    vi.advanceTimersByTime(100);
    expect(drops).toEqual(['3 px']);
    vi.advanceTimersByTime(NUDGE_PAUSE_MS);
    expect(drops).toEqual(['3 px']);
  });

  it('drops it at once when you leave it, and not at all when it moved some other way', () => {
    pin.dragEnd(true, () => drops.push('left'));
    pin.now();
    expect(drops).toEqual(['left']);
    pin.now(); // Nothing waits any more.
    pin.dragEnd(true, () => drops.push('undone'));
    pin.cancel();
    vi.advanceTimersByTime(NUDGE_PAUSE_MS);
    expect(drops).toEqual(['left']);
  });
});
