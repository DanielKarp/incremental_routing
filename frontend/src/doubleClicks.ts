// The second click of a double-click, anywhere on the page. Many clicks change what's under the
// pointer: Remove takes rows away, a wait chip adds a leg and closes the Wait panel, a departure
// opens its stops, Summary & export opens the summary. The second click would then land on
// whatever took the place of what you clicked (Before the start, the Wait button, a stop), and
// do that too. So it only goes where the first click went.

/**
 * Tells which clicks to drop: the second (or third) click of a double-click that lands somewhere
 * other than its first did. One that lands on the same control is left to it: most do the same
 * again, and Remove and Merge do nothing more. A click from the keyboard (Enter or Space) has a
 * detail of 0, so it's never dropped.
 */
export class DoubleClicks {
  private first: EventTarget | null = null;

  /** Whether `e` is a later click of a double-click whose first click went elsewhere. */
  strays(e: Pick<MouseEvent, 'detail' | 'target'>): boolean {
    if (e.detail === 1) this.first = e.target;
    return e.detail > 1 && e.target !== this.first;
  }
}
