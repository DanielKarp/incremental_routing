// What a click on the map does. A double-click only zooms, so a click on empty map waits a
// moment to see whether a second one follows. Once there's a start, a click that picks nothing
// opens the same menu as a right-click.

import type { Direction } from './plan/types';

/** How long a click on empty map waits for the second click of a double-click. */
export const DOUBLE_CLICK_MS = 300;

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

/**
 * Holds back a click on empty map until it's clear it isn't the first half of a double-click.
 * The double-click cancels it, and so does any newer click. Where the system allows longer than
 * DOUBLE_CLICK_MS between the two clicks, the first still acts, but the second is dropped (see
 * isRepeatClick), so it never acts twice.
 */
export class SingleClick {
  private waiting: ReturnType<typeof setTimeout> | undefined;

  /** Do `act` after DOUBLE_CLICK_MS, unless cancelled first. A click still waiting is dropped. */
  wait(act: () => void) {
    this.cancel();
    this.waiting = setTimeout(() => {
      this.waiting = undefined;
      act();
    }, DOUBLE_CLICK_MS);
  }

  cancel() {
    clearTimeout(this.waiting);
    this.waiting = undefined;
  }
}
