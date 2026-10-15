// Bringing what just changed in the panel into view.

/**
 * Scrolls the panel only as far as it takes to show `el`: smoothly, unless you've asked your
 * system for less motion. The bar with Undo covers the foot of the panel, so the elements this
 * is used on keep clear of it (scroll-margin in styles.css).
 */
export function bringIntoView(el: Element | null) {
  const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  el?.scrollIntoView({ block: 'nearest', behavior: still ? 'auto' : 'smooth' });
}
