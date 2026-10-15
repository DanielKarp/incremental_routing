// Undo history. Each change keeps the plan as it was before, with a label naming the change,
// so the Undo button can say what it will undo ("Undo rename") and bring that plan back.
//
// To make a new kind of change undoable, add its label below, then in App either commit the
// new plan with commit(next, label), or call remember(label) just before changing the start
// point or time of a plan without legs. The history is saved in this browser (storage.ts), which
// keeps only the steps whose labels are listed here.

import type { Plan } from './plan/types';

/** What a change did, as it reads after "Undo". */
export const UNDO_LABELS = [
  'add',
  'remove',
  'rename',
  'merge',
  'time change',
  'switch to bike',
  'switch to walk',
  'clear plan',
  'open plan',
  'move start',
] as const;

export type UndoLabel = (typeof UNDO_LABELS)[number];

export interface UndoStep {
  label: UndoLabel;
  /** The plan before the change. Without legs, it still holds the start point and time. */
  plan: Plan;
}

export function isUndoLabel(value: unknown): value is UndoLabel {
  return (UNDO_LABELS as readonly unknown[]).includes(value);
}

/**
 * Whether undoing the step also sets the time back. Moving the start before the first leg
 * doesn't: changing the time isn't a step of its own, so undoing a move keeps any time you've
 * set since.
 */
export function undoesTime(label: UndoLabel): boolean {
  return label !== 'move start';
}

/** The Undo button's text: "Undo rename", or plain "Undo" when there's nothing to undo. */
export function undoText(steps: UndoStep[]): string {
  const last = steps[steps.length - 1];
  return last ? `Undo ${last.label}` : 'Undo';
}
