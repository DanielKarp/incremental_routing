// Keyboard shortcuts for the whole page. A key pressed in a field is the field's own: Ctrl+Z
// there undoes typing, and Escape is left to the field.

interface Target {
  tagName?: string;
  type?: string;
  isContentEditable?: boolean;
}

// Inputs that take no typing, so shortcuts still work while they have focus.
const UNTYPED_INPUTS = new Set(['button', 'checkbox', 'radio', 'submit', 'reset', 'file', 'image']);

/** Whether `target` (a key event's) is a field you type or choose in: text, number, date, time, a list. */
export function isTypingIn(target: EventTarget | null): boolean {
  const el = target as Target | null;
  if (!el || typeof el !== 'object') return false;
  if (el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
  return el.tagName === 'INPUT' && !UNTYPED_INPUTS.has(el.type ?? 'text');
}

type Keys = Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>;

/** Ctrl+Z, or Cmd+Z on a Mac. With Shift it would be redo, which the app doesn't have. */
export function isUndoKey(e: Keys): boolean {
  // On a keyboard without Latin letters, the key in Z's place.
  const z = /^[a-z]$/i.test(e.key) ? e.key.toLowerCase() === 'z' : e.code === 'KeyZ';
  return z && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey;
}
