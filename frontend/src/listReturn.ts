// Going back from the stop chooser to the list of lines: the list comes back as you left it,
// at the line you picked.

import { focusQuietly } from './hoverIntent';

/** Where the list was when a line's trip was picked: the panel's scroll, and the line's row. */
export interface ListSpot {
  /** The line's key (see lineKey). */
  key: string;
  scrollTop: number;
  /** The top of the line's row in the panel's content, or null if the line wasn't listed. */
  rowTop: number | null;
}

/**
 * How far to scroll the panel to put the list back. Exactly as before while the line's row is
 * where it was. If the row has moved (a message above the list has gone, or the list was found
 * again), the scroll moves with it, so the row is back where it was on screen. If the line
 * isn't listed any more, the scroll is as before.
 */
export function returnScrollTop(spot: ListSpot, rowTop: number | null): number {
  if (spot.rowTop === null || rowTop === null) return spot.scrollTop;
  const moved = rowTop - spot.rowTop;
  // Less than a pixel is a rounding difference, not a move.
  if (Math.abs(moved) < 1) return spot.scrollTop;
  return Math.max(0, Math.round(spot.scrollTop + moved));
}

/** The line's row in the list (rows carry their line's key, see CallList), if it's listed. */
function rowOf(panel: HTMLElement, key: string): HTMLElement | null {
  for (const row of panel.querySelectorAll<HTMLElement>('[data-line]')) {
    if (row.dataset.line === key) return row;
  }
  return null;
}

/** The top of `row` in the panel's content, however far the panel is scrolled. */
function contentTop(panel: HTMLElement, row: HTMLElement): number {
  return row.getBoundingClientRect().top - panel.getBoundingClientRect().top + panel.scrollTop;
}

/** Where the list is now, to come back to at the line `key`. */
export function listSpot(panel: HTMLElement, key: string): ListSpot {
  const row = rowOf(panel, key);
  return { key, scrollTop: panel.scrollTop, rowTop: row && contentTop(panel, row) };
}

/**
 * Puts the list back as it was (see returnScrollTop) and focuses the line's row, without the
 * line being framed on the map. If the list has changed meanwhile, the row also comes into
 * view.
 */
export function putListBack(panel: HTMLElement, spot: ListSpot, changed: boolean) {
  const row = rowOf(panel, spot.key);
  panel.scrollTop = returnScrollTop(spot, row && contentTop(panel, row));
  if (!row) return;
  if (changed) row.scrollIntoView({ block: 'nearest' });
  const button = row.querySelector('button');
  if (button) focusQuietly(button);
}
