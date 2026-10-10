// Pure plan operations. The UI calls these; nothing here touches the network or React.

import type { Leg, Plan, PlanIssue, Waypoint } from './types';

/** Consecutive legs whose endpoints are closer than this are treated as the same place. */
export const SAME_PLACE_M = 75;

const toMs = (iso: string) => Date.parse(iso);

export function newLegId(): string {
  return crypto.randomUUID();
}

/** Where the plan currently begins: the frontier for extending it backwards. */
export function planStart(plan: Plan): Waypoint {
  return plan.legs.length ? plan.legs[0].start : plan.anchor;
}

/** Where the plan currently ends: the frontier for extending it forwards. */
export function planEnd(plan: Plan): Waypoint {
  return plan.legs.length ? plan.legs[plan.legs.length - 1].end : plan.anchor;
}

export function appendLeg(plan: Plan, leg: Leg): Plan {
  return { ...plan, legs: withWaits([...plan.legs, leg]) };
}

export function prependLeg(plan: Plan, leg: Leg): Plan {
  return { ...plan, legs: withWaits([leg, ...plan.legs]) };
}

export function removeLeg(plan: Plan, legId: string): Plan {
  return { ...plan, legs: withWaits(plan.legs.filter((l) => l.id !== legId)) };
}

/**
 * Manually override a leg's duration, keeping one end fixed: 'start' when the leg was planned
 * forwards (you leave at a known time), 'end' when planned backwards (you must arrive by then).
 * Neighbouring legs don't move; a resulting overlap is reported by findIssues.
 */
export function setLegDuration(
  plan: Plan,
  legId: string,
  durationS: number,
  keep: 'start' | 'end',
): Plan {
  const legs = plan.legs.map((leg) => {
    if (leg.id !== legId) return leg;
    if (keep === 'start') {
      const end = new Date(toMs(leg.start.time) + durationS * 1000).toISOString();
      return { ...leg, end: { ...leg.end, time: end } };
    }
    const start = new Date(toMs(leg.end.time) - durationS * 1000).toISOString();
    return { ...leg, start: { ...leg.start, time: start } };
  });
  return { ...plan, legs: withWaits(legs) };
}

/** Drop derived legs and insert a wait wherever one leg ends before the next begins. */
export function withWaits(legs: Leg[]): Leg[] {
  const userLegs = legs.filter((l) => !l.auto);
  const out: Leg[] = [];
  userLegs.forEach((leg, i) => {
    const prev = userLegs[i - 1];
    if (prev && toMs(leg.start.time) > toMs(prev.end.time)) {
      out.push({
        id: `wait-after-${prev.id}`,
        mode: 'wait',
        auto: true,
        start: prev.end,
        end: { place: prev.end.place, time: leg.start.time },
      });
    }
    out.push(leg);
  });
  return out;
}

export function findIssues(plan: Plan): PlanIssue[] {
  const issues: PlanIssue[] = [];
  const userLegs = plan.legs.filter((l) => !l.auto);
  userLegs.forEach((leg, i) => {
    if (toMs(leg.end.time) < toMs(leg.start.time)) {
      issues.push({ kind: 'negative-duration', legId: leg.id, message: 'Ends before it starts' });
    }
    const prev = userLegs[i - 1];
    if (!prev) return;
    const overlapS = (toMs(prev.end.time) - toMs(leg.start.time)) / 1000;
    if (overlapS > 0) {
      issues.push({
        kind: 'overlap',
        legId: leg.id,
        message: `Starts ${Math.ceil(overlapS / 60)} min before the previous leg ends`,
      });
    }
    const gapM = distanceM(prev.end.place, leg.start.place);
    if (gapM > SAME_PLACE_M) {
      issues.push({
        kind: 'location-gap',
        legId: leg.id,
        message: `Starts ${Math.round(gapM)} m from where the previous leg ends`,
      });
    }
  });
  return issues;
}

export function distanceM(a: { lat: number; lon: number }, b: { lat: number; lon: number }) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_008.8 * Math.asin(Math.sqrt(h));
}
