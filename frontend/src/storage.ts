// Autosave: the current plan survives a reload in this browser. It's a convenience only;
// export the plan (JSON) to keep it or move it elsewhere.

import { isPlace, validatePlan } from './plan/files';
import type { Direction, Place, Plan, Waypoint } from './plan/types';
import { nowLocalInput } from './time';
import { type UndoStep, isUndoLabel } from './undo';

const KEY = 'incremental-routing:session:v1';
const HISTORY_KEY = 'incremental-routing:history:v1';

/**
 * The undo history kept in this browser: the newest steps that fit in about this many
 * characters. It has its own key, so a long history never stops the plan itself being saved.
 */
export const HISTORY_MAX_CHARS = 1_000_000;

export interface Session {
  anchor: Place | null;
  /** The start time field, e.g. "2026-10-12T07:30". */
  timeInput: string;
  /** The plan, once it has legs. */
  plan: Plan | null;
  /** Which end of the plan you were extending. A plan without legs starts forwards. */
  direction: Direction;
}

export function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const data: unknown = JSON.parse(raw);
    if (typeof data !== 'object' || data === null) return null;
    const { anchor, timeInput, plan, direction } = data as Record<string, unknown>;
    const restored = plan ? validatePlan(plan) : null;
    const legs = restored?.ok && restored.plan.legs.length ? restored.plan : null;
    return {
      anchor: isPlace(anchor) ? anchor : null,
      // As you left it, even cleared or with a year still being typed, so the start point, the
      // plan and its undo history come back with it. What can't be the field's starts at now.
      timeInput:
        typeof timeInput === 'string' && /^(\d{4,6}-\d\d-\d\dT\d\d:\d\d)?$/.test(timeInput)
          ? timeInput
          : nowLocalInput(),
      plan: legs,
      direction: legs && direction === 'backward' ? 'backward' : 'forward',
    };
  } catch {
    return null; // Storage blocked or unreadable: start fresh.
  }
}

export function saveSession(session: Session): void {
  const json = JSON.stringify(session);
  try {
    localStorage.setItem(KEY, json);
  } catch {
    try {
      // The plan matters more than the undo history: make room by dropping it.
      localStorage.removeItem(HISTORY_KEY);
      localStorage.setItem(KEY, json);
    } catch {
      // Private mode, or storage full or blocked: autosave is best effort.
    }
  }
}

/**
 * The undo history saved with `plan` (the session's plan with legs, or null), or none if it
 * was saved with another plan: undoing it would skip changes made since.
 */
export function loadHistory(plan: Plan | null): UndoStep[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const data: unknown = JSON.parse(raw);
    if (typeof data !== 'object' || data === null) return [];
    const { leadsTo, steps } = data as Record<string, unknown>;
    if (leadsTo !== planKey(plan) || !Array.isArray(steps)) return [];
    let restored: UndoStep[] = [];
    for (const step of steps) {
      const { label, plan: before, direction } = (step ?? {}) as Record<string, unknown>;
      const checked = validatePlan(before);
      // Only the steps after a damaged one can still be undone in order.
      if (!isUndoLabel(label) || !checked.ok) restored = [];
      else {
        const kept: UndoStep = { label, plan: checked.plan };
        // The end of the plan that undoing it plans from again, if it says (see UndoStep).
        if (direction === 'forward' || direction === 'backward') kept.direction = direction;
        restored.push(kept);
      }
    }
    return restored;
  } catch {
    return []; // Storage blocked or unreadable.
  }
}

/**
 * Save the undo history that leads to `plan`, keeping its newest steps up to
 * HISTORY_MAX_CHARS (fewer if storage is nearly full).
 */
export function saveHistory(steps: UndoStep[], plan: Plan | null): void {
  for (const budget of [HISTORY_MAX_CHARS, HISTORY_MAX_CHARS / 10]) {
    try {
      localStorage.setItem(HISTORY_KEY, historyJson(steps, plan, budget));
      return;
    } catch {
      // Storage full or blocked: try a shorter history.
    }
  }
  try {
    // Better none than one saved with an older plan.
    localStorage.removeItem(HISTORY_KEY);
  } catch {
    // Storage blocked: autosave is best effort.
  }
}

// Steps never change once made, so each is turned into JSON once.
const stepJsonCache = new WeakMap<UndoStep, string>();

function historyJson(steps: UndoStep[], plan: Plan | null, budget: number): string {
  const kept: string[] = [];
  let size = 0;
  for (let i = steps.length - 1; i >= 0; i--) {
    let json = stepJsonCache.get(steps[i]);
    if (json === undefined) {
      json = JSON.stringify(steps[i]);
      stepJsonCache.set(steps[i], json);
    }
    if (size + json.length > budget) break;
    kept.push(json);
    size += json.length;
  }
  return `{"leadsTo":${JSON.stringify(planKey(plan))},"steps":[${kept.reverse().join(',')}]}`;
}

/** Enough of a plan to tell it apart: the start point, and when and where each leg you chose goes. */
function planKey(plan: Plan | null): string {
  if (!plan) return '';
  // A missing name or stop becomes null.
  const at = ({ place: p, time }: Waypoint) => [time, p.lat, p.lon, p.name, p.stopId];
  const legs = plan.legs.filter((l) => !l.auto).map((l) => [l.id, l.mode, at(l.start), at(l.end)]);
  return JSON.stringify([at(plan.anchor), legs]);
}
