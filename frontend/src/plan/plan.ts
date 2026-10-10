// Pure plan operations. The UI calls these; nothing here touches the network or React.

import type { Leg, Plan, PlanIssue, Waypoint } from './types';

/** Consecutive legs whose endpoints are closer than this are treated as the same place. */
export const SAME_PLACE_M = 75;

export const toMs = (iso: string) => Date.parse(iso);

export function addSeconds(iso: string, seconds: number): string {
  return new Date(toMs(iso) + seconds * 1000).toISOString();
}

export function legDurationS(leg: Leg): number {
  return (toMs(leg.end.time) - toMs(leg.start.time)) / 1000;
}

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
  return appendLegs(plan, [leg]);
}

/** Add legs (in travel order) after the end of the plan. */
export function appendLegs(plan: Plan, legs: Leg[]): Plan {
  return { ...plan, legs: withWaits([...plan.legs, ...legs]) };
}

export function prependLeg(plan: Plan, leg: Leg): Plan {
  return prependLegs(plan, [leg]);
}

/** Add legs (in travel order) before the start of the plan. */
export function prependLegs(plan: Plan, legs: Leg[]): Plan {
  return { ...plan, legs: withWaits([...legs, ...plan.legs]) };
}

/** First and last legs you chose yourself: the ones that can be removed without a gap. */
export function isEndLeg(plan: Plan, legId: string): boolean {
  const userLegs = plan.legs.filter((l) => !l.auto);
  return userLegs[0]?.id === legId || userLegs[userLegs.length - 1]?.id === legId;
}

export function removeLeg(plan: Plan, legId: string): Plan {
  return { ...plan, legs: withWaits(plan.legs.filter((l) => l.id !== legId)) };
}

export type EditResult = { ok: true; plan: Plan } | { ok: false; reason: string };

function userNeighbours(plan: Plan, legId: string) {
  const userLegs = plan.legs.filter((l) => !l.auto);
  const i = userLegs.findIndex((l) => l.id === legId);
  return { leg: userLegs[i], prev: userLegs[i - 1], next: userLegs[i + 1] };
}

/**
 * The longest a leg may become, keeping its fixed end in place, without running into the leg
 * on the side it grows towards (PLAN.md §9, decision 2). Null when that side of the plan is
 * open. Automatic waits in between don't count: they shrink to make room.
 */
export function maxDurationS(plan: Plan, legId: string): number | null {
  const { leg, prev, next } = userNeighbours(plan, legId);
  if (!leg) throw new Error(`No leg ${legId}`);
  if ((leg.fixed ?? 'start') === 'start') {
    return next ? (toMs(next.start.time) - toMs(leg.start.time)) / 1000 : null;
  }
  return prev ? (toMs(leg.end.time) - toMs(prev.end.time)) / 1000 : null;
}

/**
 * Manually override a walk, bike or wait leg's duration. Its fixed end stays put: the start
 * for legs planned forwards (you leave at a known time), the end for legs planned backwards
 * (you must arrive by then). Shortening always works and opens a wait; lengthening into a
 * neighbour is refused.
 */
export function setLegDuration(plan: Plan, legId: string, durationS: number): EditResult {
  const { leg } = userNeighbours(plan, legId);
  if (!leg) return { ok: false, reason: 'That leg is no longer in the plan.' };
  if (leg.mode === 'transit') return { ok: false, reason: 'Transit times come from the timetable.' };
  if (!(durationS >= 0)) return { ok: false, reason: 'Enter a duration of 0 or more.' };
  const fixed = leg.fixed ?? 'start';
  const max = maxDurationS(plan, legId);
  if (max !== null && durationS > max) {
    const neighbour = fixed === 'start' ? 'next' : 'previous';
    return {
      ok: false,
      reason: `At most ${Math.floor(max / 60)} min. Any longer runs into the ${neighbour} leg.`,
    };
  }
  const legs = plan.legs.map((l) => {
    if (l.id !== legId) return l;
    return fixed === 'start'
      ? { ...l, end: { ...l.end, time: addSeconds(l.start.time, durationS) } }
      : { ...l, start: { ...l.start, time: addSeconds(l.end.time, -durationS) } };
  });
  return { ok: true, plan: { ...plan, legs: withWaits(legs) } };
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
      issues.push({
        kind: 'negative-duration',
        severity: 'error',
        legId: leg.id,
        message: 'Ends before it starts',
      });
    }
    if (leg.transit?.bikesAllowed === false) {
      issues.push({
        kind: 'bikes-not-allowed',
        severity: 'warning',
        legId: leg.id,
        message: 'Bikes are not allowed on this trip',
      });
    }
    const prev = userLegs[i - 1];
    if (!prev) return;
    const overlapS = (toMs(prev.end.time) - toMs(leg.start.time)) / 1000;
    if (overlapS > 0) {
      issues.push({
        kind: 'overlap',
        severity: 'error',
        legId: leg.id,
        message: `Starts ${Math.ceil(overlapS / 60)} min before the previous leg ends`,
      });
    }
    const gapM = distanceM(prev.end.place, leg.start.place);
    if (gapM > SAME_PLACE_M) {
      issues.push({
        kind: 'location-gap',
        severity: 'error',
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
