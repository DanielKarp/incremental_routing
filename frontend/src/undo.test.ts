import { describe, expect, it } from 'vitest';
import type { Plan } from './plan/types';
import { isUndoLabel, undoText } from './undo';

const plan: Plan = {
  anchor: { place: { lat: 37.44, lon: -122.16, name: 'Home' }, time: '2026-10-12T14:30:00Z' },
  legs: [],
};

describe('undo labels', () => {
  it('names the change the button will undo', () => {
    expect(undoText([])).toBe('Undo');
    expect(undoText([{ label: 'add', plan }])).toBe('Undo add');
    expect(
      undoText([
        { label: 'add', plan },
        { label: 'switch to bike', plan },
      ]),
    ).toBe('Undo switch to bike');
  });

  it('knows its own labels only', () => {
    expect(isUndoLabel('rename')).toBe(true);
    expect(isUndoLabel('teleport')).toBe(false);
    expect(isUndoLabel(undefined)).toBe(false);
  });
});
