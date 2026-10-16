// Bringing what just changed in the panel into view, and keeping keyboard focus in view, clear of
// the parts of the panel that stay put while it scrolls (position: sticky in styles.css): the
// stop chooser's header at the top, and the bar with Undo at the foot.

const HEADER = '.trip-stops-header';
const FOOT = '.undo-bar';
// How far what comes into view keeps from the edges of what you can see, in pixels.
const GAP = 12;

function smoothly(): ScrollBehavior {
  const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  return still ? 'auto' : 'smooth';
}

/**
 * How far to scroll (down, or up if negative) to show something from `top` to `bottom` on screen
 * whole, in room from `roomTop` to `roomBottom`: no further than it takes, keeping GAP from the
 * edge it comes to. Something taller than the room comes to its top, so its beginning shows. 0
 * when it's in view already.
 */
export function scrollToShow(
  top: number,
  bottom: number,
  roomTop: number,
  roomBottom: number,
): number {
  if (top >= roomTop && bottom <= roomBottom) return 0;
  if (top < roomTop || bottom - top > roomBottom - roomTop - 2 * GAP) return top - roomTop - GAP;
  return bottom - roomBottom + GAP;
}

/**
 * Scrolls the panel only as far as it takes to show `el` (see scrollToShow): smoothly, unless
 * you've asked your system for less motion or `behavior` says otherwise. Nothing moves if it's
 * in view already, so a smooth scroll on its way isn't stopped.
 */
export function bringIntoView(el: Element | null, behavior: ScrollBehavior = smoothly()) {
  if (!el) return;
  const box = scroller(el);
  const room = roomFor(box, el);
  const { top, bottom } = el.getBoundingClientRect();
  const by = scrollToShow(top, bottom, room.top, room.bottom);
  if (by) box.scrollBy({ top: by, behavior });
}

/**
 * Tab scrolls the panel only as far as its edges, which can leave the control it moves to under
 * the header or the bar. Call this as Tab is pressed in `panel`: once the focus has moved, the
 * control comes clear of them.
 */
export function keepFocusInView(panel: Element) {
  requestAnimationFrame(() => {
    const el = document.activeElement;
    if (el && el !== panel && panel.contains(el)) bringIntoView(el, 'auto');
  });
}

/** Whether something whose top is at `top` starts in the upper half of a view, top to bottom. */
export function startsHigh(top: number, viewTop: number, viewBottom: number): boolean {
  return top >= viewTop && top <= (viewTop + viewBottom) / 2;
}

/** The nearest box around `el` that scrolls: the panel. */
function scroller(el: Element): Element {
  for (let box = el.parentElement; box; box = box.parentElement) {
    if (/auto|scroll/.test(getComputedStyle(box).overflowY)) return box;
  }
  return document.scrollingElement ?? document.documentElement;
}

/**
 * Where `el` can be seen in the panel `box`, top to bottom on screen: above the bar with Undo,
 * and below the stop chooser's header if `el` comes after it, as the stops do (the header stays
 * at the top while they scroll under it). Unless `el` is in them.
 */
function roomFor(box: Element, el: Element): { top: number; bottom: number } {
  const top = box.getBoundingClientRect().top + box.clientTop;
  const room = { top, bottom: top + box.clientHeight };
  const header = box.querySelector(HEADER);
  const after = header && header.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING;
  if (header && after && !header.contains(el)) room.top += header.getBoundingClientRect().height;
  const foot = box.querySelector(FOOT);
  if (foot && !foot.contains(el)) room.bottom -= foot.getBoundingClientRect().height;
  return room;
}

/**
 * For something taller than the panel whose beginning matters, such as the stop chooser: unless
 * it starts in the upper half of the panel, the panel scrolls so that it starts at the top.
 */
export function bringTopIntoView(el: Element | null) {
  if (!el) return;
  const box = scroller(el);
  const room = roomFor(box, el);
  const { top } = el.getBoundingClientRect();
  if (startsHigh(top, room.top, room.bottom)) return;
  box.scrollBy({ top: top - room.top - GAP, behavior: smoothly() });
}
