import { useEffect, useRef } from 'react';

// A row counts as wanted once the pointer has rested on it (or keyboard focus has stayed on
// it) this long.
export const DWELL_MS = 400;
// The pointer is still resting while it stays within this many pixels of where it stopped.
export const REST_PX = 8;
// Leaving the list counts once the pointer has been off it this long, so slipping off a row
// for a moment doesn't undo anything.
export const LEAVE_MS = 300;

/**
 * Tells pointing at a row on purpose from passing over it: the row the pointer rests on, or
 * keyboard focus stays on, becomes wanted after DWELL_MS. Sweeping across rows on the way
 * somewhere else, or rows scrolling under a pointer that hasn't moved, wants nothing.
 * `onWant` hears of each change: a row's key, or null once the pointer leaves the list.
 */
export class HoverIntent<K> {
  private onWant: (key: K | null) => void;
  private dwell: ReturnType<typeof setTimeout> | undefined;
  private leaving: ReturnType<typeof setTimeout> | undefined;
  /** The row being rested on, waiting for the dwell (and still once it's over). */
  private resting: K | null = null;
  /** The row last wanted. */
  private wanted: K | null = null;
  /** Where the pointer came to rest, or was when the list last scrolled. */
  private restAt: { x: number; y: number } | null = null;

  constructor(onWant: (key: K | null) => void) {
    this.onWant = onWant;
  }

  /** The pointer moved over a row. */
  move(key: K, x: number, y: number) {
    clearTimeout(this.leaving);
    const still =
      this.restAt !== null && Math.hypot(x - this.restAt.x, y - this.restAt.y) <= REST_PX;
    // Still resting on the same row; or a row the list scrolled under a pointer that hasn't
    // really moved since, which isn't one the user went to.
    if (still && (key === this.resting || this.resting === null)) return;
    this.restAt = { x, y };
    this.restOn(key);
  }

  /** Keyboard focus moved onto a row. */
  focus(key: K) {
    clearTimeout(this.leaving);
    this.restAt = null;
    this.restOn(key);
  }

  /**
   * The list scrolled: whatever is under the pointer now got there by itself. A row keyboard
   * focus is on stays wanted, since focusing a row scrolls it into view.
   */
  scroll() {
    if (this.restAt === null) return;
    clearTimeout(this.dwell);
    this.resting = null;
  }

  /** The pointer (or keyboard focus) left the list. */
  leave() {
    clearTimeout(this.dwell);
    clearTimeout(this.leaving);
    this.resting = null;
    this.restAt = null;
    this.leaving = setTimeout(() => this.want(null), LEAVE_MS);
  }

  /** The list is gone: nothing in it is wanted any more. */
  dispose() {
    clearTimeout(this.dwell);
    clearTimeout(this.leaving);
    this.resting = null;
    this.restAt = null;
    this.want(null);
  }

  private restOn(key: K) {
    clearTimeout(this.dwell);
    this.resting = key;
    this.dwell = setTimeout(() => this.want(key), DWELL_MS);
  }

  private want(key: K | null) {
    if (key === this.wanted) return;
    this.wanted = key;
    this.onWant(key);
  }
}

/**
 * A HoverIntent for a list on the page, calling the latest `onWant`. Any scroll on the page
 * counts as the list scrolling, since it moves the rows under the pointer just the same.
 */
export function useHoverIntent<K>(onWant: ((key: K | null) => void) | undefined) {
  const latest = useRef(onWant);
  useEffect(() => {
    latest.current = onWant;
  });
  const intent = useRef<HoverIntent<K> | null>(null);
  intent.current ??= new HoverIntent<K>((key) => latest.current?.(key));
  useEffect(() => {
    const current = intent.current!;
    const scrolled = () => current.scroll();
    // Scroll events don't bubble, but they can be caught on the way down.
    document.addEventListener('scroll', scrolled, true);
    return () => {
      document.removeEventListener('scroll', scrolled, true);
      current.dispose();
    };
  }, []);
  return intent.current;
}
