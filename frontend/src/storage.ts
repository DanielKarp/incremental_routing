// Autosave: the current plan survives a reload in this browser. It's a convenience only;
// export the plan (JSON) to keep it or move it elsewhere.

import { isPlace, validatePlan } from './plan/files';
import type { Place, Plan } from './plan/types';

const KEY = 'incremental-routing:session:v1';

export interface Session {
  anchor: Place | null;
  /** The start time field, e.g. "2026-10-12T07:30". */
  timeInput: string;
  /** The plan, once it has legs. */
  plan: Plan | null;
}

export function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const data: unknown = JSON.parse(raw);
    if (typeof data !== 'object' || data === null) return null;
    const { anchor, timeInput, plan } = data as Record<string, unknown>;
    if (typeof timeInput !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(timeInput)) {
      return null;
    }
    const restored = plan ? validatePlan(plan) : null;
    return {
      anchor: isPlace(anchor) ? anchor : null,
      timeInput,
      plan: restored?.ok && restored.plan.legs.length ? restored.plan : null,
    };
  } catch {
    return null; // Storage blocked or unreadable: start fresh.
  }
}

export function saveSession(session: Session): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(session));
  } catch {
    // Private mode, or storage full or blocked: autosave is best effort.
  }
}
