// What a click on the map does. A double-click only zooms, so a click on empty map waits a
// moment to see whether a second one follows. Once there's a start, a click that picks nothing
// opens the same menu as a right-click. Also when a dragged pin counts as dropped.

import type { Direction } from './plan/types';

/** How long a click on empty map waits for the second click of a double-click. */
export const DOUBLE_CLICK_MS = 300;
/** The same for a tap: MapLibre zooms for two taps up to this far apart. */
export const DOUBLE_TAP_MS = 500;
/** How long after the last arrow-key press a pin moved with the keys is dropped. */
export const NUDGE_PAUSE_MS = 600;

/** Something the map's menu offers to do at the point clicked. */
export interface MapMenuItem {
  id: string;
  label: string;
}

/** What a click on empty map does: set or move the start, pick a walk or bike end, or a menu. */
export type EmptyClick = 'start' | 'path' | 'menu';

export function emptyClick(state: {
  hasStart: boolean;
  /** Move was clicked under Plan from. */
  movingStart: boolean;
  /** Walk or Bike is chosen under Next leg. */
  pathMode: boolean;
}): EmptyClick {
  if (!state.hasStart || state.movingStart) return 'start';
  return state.pathMode ? 'path' : 'menu';
}

/**
 * The map's menu at a point, opened by a right-click or a click that picks nothing. Before the
 * first leg it can move the start there; once there's a plan, it walks or bikes there (or from
 * there, planning backwards).
 */
export function mapMenuItems(state: {
  /** There's a start and no legs yet. */
  startMovable: boolean;
  /** There's a plan to add legs to: a start, and a time that can be read. */
  canAddLegs: boolean;
  direction: Direction;
}): MapMenuItem[] {
  const forward = state.direction === 'forward';
  return [
    ...(state.startMovable ? [{ id: 'move', label: 'Move the start here' }] : []),
    ...(state.canAddLegs
      ? [
          { id: 'walk', label: forward ? 'Walk here' : 'Walk from here' },
          { id: 'bike', label: forward ? 'Bike here' : 'Bike from here' },
        ]
      : []),
  ];
}

/** The second (or third) click of a double-click, as the browser counts them. It only zooms. */
export function isRepeatClick(e: Pick<MouseEvent, 'detail'>): boolean {
  return e.detail > 1;
}

/** How long a click on empty map waits to see whether it's half of a double-click or tap. */
export function clickWaitMs(tapped: boolean): number {
  return tapped ? DOUBLE_TAP_MS : DOUBLE_CLICK_MS;
}

/**
 * Holds back a click on empty map until it's clear it isn't the first half of a double-click.
 * The double-click cancels it, and so does any newer click. Where the system allows longer than
 * DOUBLE_CLICK_MS between the two clicks, the first still acts, but the second is dropped (see
 * isRepeatClick), so it never acts twice.
 */
export class SingleClick {
  private waiting: ReturnType<typeof setTimeout> | undefined;

  /** Do `act` after `ms`, unless cancelled first. A click still waiting is dropped. */
  wait(act: () => void, ms = DOUBLE_CLICK_MS) {
    this.cancel();
    this.waiting = setTimeout(() => {
      this.waiting = undefined;
      act();
    }, ms);
  }

  cancel() {
    clearTimeout(this.waiting);
    this.waiting = undefined;
  }
}

/**
 * Drops a pin where it was let go. With the arrow keys, each press moves the pin a pixel (ten
 * with Shift) and ends a drag of its own, so a pin moved with the keys is dropped once you pause,
 * or leave it: presses in a row are one move, and one step for Undo. A drag with the mouse or a
 * finger is dropped at once.
 */
export class PinDrop {
  private waiting: ReturnType<typeof setTimeout> | undefined;
  private drop: (() => void) | undefined;

  /** A drag ended, with the arrow keys or not: `drop` now, or once the keys pause. */
  dragEnd(byKeys: boolean, drop: () => void) {
    this.cancel();
    if (!byKeys) {
      drop();
      return;
    }
    this.drop = drop;
    this.waiting = setTimeout(() => this.now(), NUDGE_PAUSE_MS);
  }

  /** Drop a pin moved with the keys without waiting, if one is waiting. */
  now() {
    const drop = this.drop;
    this.cancel();
    drop?.();
  }

  cancel() {
    clearTimeout(this.waiting);
    this.waiting = undefined;
    this.drop = undefined;
  }
}
