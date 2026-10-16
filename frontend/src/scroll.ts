// Bringing what just changed in the panel into view.

function smoothly(): ScrollBehavior {
  const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  return still ? 'auto' : 'smooth';
}

/**
 * Scrolls the panel only as far as it takes to show `el`: smoothly, unless you've asked your
 * system for less motion. The bar with Undo covers the foot of the panel, so the elements this
 * is used on keep clear of it (scroll-margin in styles.css).
 */
export function bringIntoView(el: Element | null) {
  el?.scrollIntoView({ block: 'nearest', behavior: smoothly() });
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
 * For something taller than the panel whose beginning matters, such as the stop chooser: unless
 * it starts in the upper half of the panel, the panel scrolls so that it starts at the top.
 */
export function bringTopIntoView(el: Element | null) {
  if (!el) return;
  const view = scroller(el).getBoundingClientRect();
  if (startsHigh(el.getBoundingClientRect().top, view.top, view.bottom)) return;
  el.scrollIntoView({ block: 'start', behavior: smoothly() });
}
