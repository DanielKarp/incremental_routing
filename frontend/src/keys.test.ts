import { describe, expect, it } from 'vitest';
import { isTypingIn, isUndoKey } from './keys';

describe('isTypingIn', () => {
  const el = (tagName: string, more: object = {}) =>
    ({ tagName, ...more }) as unknown as EventTarget;

  it('counts text, number, date and time fields, lists and editable text', () => {
    for (const type of ['text', 'number', 'time', 'datetime-local', 'search', undefined]) {
      expect(isTypingIn(el('INPUT', { type }))).toBe(true);
    }
    expect(isTypingIn(el('SELECT'))).toBe(true);
    expect(isTypingIn(el('TEXTAREA'))).toBe(true);
    expect(isTypingIn(el('DIV', { isContentEditable: true }))).toBe(true);
  });

  it('leaves out buttons, checkboxes and the page itself', () => {
    expect(isTypingIn(el('BUTTON', { type: 'button' }))).toBe(false);
    expect(isTypingIn(el('INPUT', { type: 'checkbox' }))).toBe(false);
    expect(isTypingIn(el('BODY'))).toBe(false);
    expect(isTypingIn(null)).toBe(false);
  });
});

describe('isUndoKey', () => {
  const press = (over: Partial<Parameters<typeof isUndoKey>[0]>) => ({
    key: 'z',
    code: 'KeyZ',
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...over,
  });

  it('is Ctrl+Z or Cmd+Z', () => {
    expect(isUndoKey(press({ ctrlKey: true }))).toBe(true);
    expect(isUndoKey(press({ metaKey: true }))).toBe(true);
    // Caps Lock on.
    expect(isUndoKey(press({ key: 'Z', ctrlKey: true }))).toBe(true);
  });

  it('is not Z alone, redo, or another key', () => {
    expect(isUndoKey(press({}))).toBe(false);
    expect(isUndoKey(press({ key: 'Z', ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(isUndoKey(press({ ctrlKey: true, altKey: true }))).toBe(false);
    expect(isUndoKey(press({ key: 'y', code: 'KeyY', ctrlKey: true }))).toBe(false);
  });

  it('follows the letter on the key, and its place without Latin letters', () => {
    // German keyboards swap Y and Z.
    expect(isUndoKey(press({ key: 'z', code: 'KeyY', ctrlKey: true }))).toBe(true);
    expect(isUndoKey(press({ key: 'y', code: 'KeyZ', ctrlKey: true }))).toBe(false);
    // Russian: Я is where Z is.
    expect(isUndoKey(press({ key: 'я', code: 'KeyZ', ctrlKey: true }))).toBe(true);
  });
});
