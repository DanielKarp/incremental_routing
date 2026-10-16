// Pure plan operations. The UI calls these; nothing here touches the network or React.

import { formatDuration, formatTime } from '../time';
import type { Direction, FixedEnd, Leg, PathInfo, Place, Plan, PlanIssue, Waypoint } from './types';

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

/**
 * The legs that go with a leg you chose when you remove it, in travel order. A leg at either
 * end of the plan, or a wait you added, goes alone: an automatic wait fills the time it leaves.
 * Any other leg takes every leg beyond it in the planning direction with it (after it when
 * planning forwards, before it when planning backwards), since removing it alone would leave a
 * gap in the plan.
 */
export function removedWith(plan: Plan, legId: string, direction: Direction): Leg[] {
  const i = plan.legs.findIndex((l) => l.id === legId);
  const leg = plan.legs[i];
  if (!leg || leg.auto || isEndLeg(plan, legId)) return [];
  if (leg.mode === 'wait' && distanceM(leg.start.place, leg.end.place) <= SAME_PLACE_M) return [];
  return direction === 'forward' ? plan.legs.slice(i + 1) : plan.legs.slice(0, i);
}

/** Remove a leg you chose, with the legs that go with it (see removedWith). */
export function removeFrom(plan: Plan, legId: string, direction: Direction): Plan {
  const gone = new Set([legId, ...removedWith(plan, legId, direction).map((l) => l.id)]);
  return { ...plan, legs: withWaits(plan.legs.filter((l) => !gone.has(l.id))) };
}

export type EditResult = { ok: true; plan: Plan } | { ok: false; reason: string };

function userNeighbours(plan: Plan, legId: string) {
  const userLegs = plan.legs.filter((l) => !l.auto);
  const i = userLegs.findIndex((l) => l.id === legId);
  return { leg: userLegs[i], prev: userLegs[i - 1], next: userLegs[i + 1] };
}

/** How far a walk, bike or wait leg's times may move (PLAN.md §9, decision 2). */
export interface LegBounds {
  /** False when the leg meets a transit leg directly on that side: that end can't move. */
  startFree: boolean;
  endFree: boolean;
  /** Limits set by the neighbouring legs you chose; null where the plan is open. */
  earliestStart: string | null;
  latestEnd: string | null;
}

export function legBounds(plan: Plan, legId: string): LegBounds {
  const i = plan.legs.findIndex((l) => l.id === legId);
  if (i < 0) throw new Error(`No leg ${legId}`);
  const { prev, next } = userNeighbours(plan, legId);
  return {
    // Automatic waits in between don't lock anything: they shrink or grow to make room.
    startFree: plan.legs[i - 1]?.mode !== 'transit',
    endFree: plan.legs[i + 1]?.mode !== 'transit',
    earliestStart: prev ? prev.end.time : null,
    latestEnd: next ? next.start.time : null,
  };
}

/**
 * Which end stays put when only the duration changes: an end locked to a transit leg, else
 * the end the leg was planned from (its departure when planned forwards).
 */
export function durationAnchor(plan: Plan, legId: string): FixedEnd {
  const bounds = legBounds(plan, legId);
  if (!bounds.startFree) return 'start';
  if (!bounds.endFree) return 'end';
  return userNeighbours(plan, legId).leg?.fixed ?? 'start';
}

/**
 * The longest a leg may become while its anchored end stays put, without running into the
 * leg on the other side. Null when that side of the plan is open.
 */
export function maxDurationS(plan: Plan, legId: string): number | null {
  const { leg } = userNeighbours(plan, legId);
  if (!leg) throw new Error(`No leg ${legId}`);
  const bounds = legBounds(plan, legId);
  if (durationAnchor(plan, legId) === 'start') {
    return bounds.latestEnd ? (toMs(bounds.latestEnd) - toMs(leg.start.time)) / 1000 : null;
  }
  return bounds.earliestStart ? (toMs(leg.end.time) - toMs(bounds.earliestStart)) / 1000 : null;
}

/** The range of departure times a leg can be moved to while keeping its duration. */
export function departureWindow(plan: Plan, legId: string): { earliest: string | null; latest: string | null } {
  const { leg } = userNeighbours(plan, legId);
  const bounds = legBounds(plan, legId);
  if (!leg || !bounds.startFree || !bounds.endFree) return { earliest: null, latest: null };
  return {
    earliest: bounds.earliestStart,
    latest: bounds.latestEnd ? addSeconds(bounds.latestEnd, -legDurationS(leg)) : null,
  };
}

function editable(plan: Plan, legId: string): Leg | string {
  const { leg } = userNeighbours(plan, legId);
  if (!leg) return 'That leg is no longer in the plan.';
  if (leg.mode === 'transit') return 'Transit times come from the timetable.';
  return leg;
}

/** Apply new times to a leg if they stay within its neighbours. */
function retimed(plan: Plan, leg: Leg, start: string, end: string, extra: Partial<Leg> = {}): EditResult {
  const bounds = legBounds(plan, leg.id);
  if (toMs(end) < toMs(start)) return { ok: false, reason: 'It would end before it starts.' };
  if (bounds.earliestStart && toMs(start) < toMs(bounds.earliestStart)) {
    return {
      ok: false,
      reason: `Leave at ${formatTime(bounds.earliestStart)} or later: the previous leg ends then.`,
    };
  }
  if (bounds.latestEnd && toMs(end) > toMs(bounds.latestEnd)) {
    return { ok: false, reason: `Arrive by ${formatTime(bounds.latestEnd)}: the next leg starts then.` };
  }
  const legs = plan.legs.map((l) =>
    l.id === leg.id
      ? { ...l, ...extra, start: { ...l.start, time: start }, end: { ...l.end, time: end } }
      : l,
  );
  return { ok: true, plan: { ...plan, legs: withWaits(legs) } };
}

/**
 * Change a walk, bike or wait leg's duration. The anchored end (see durationAnchor) stays put;
 * shortening always works and opens a wait, lengthening into a neighbour is refused.
 */
export function setLegDuration(plan: Plan, legId: string, durationS: number): EditResult {
  const leg = editable(plan, legId);
  if (typeof leg === 'string') return { ok: false, reason: leg };
  if (!(durationS >= 0)) return { ok: false, reason: 'Enter a duration of 0 or more.' };
  const anchor = durationAnchor(plan, legId);
  const max = maxDurationS(plan, legId);
  if (max !== null && durationS > max) {
    const neighbour = anchor === 'start' ? 'next' : 'previous';
    return {
      ok: false,
      reason: `At most ${Math.floor(max / 60)} min. Any longer runs into the ${neighbour} leg.`,
    };
  }
  return anchor === 'start'
    ? retimed(plan, leg, leg.start.time, addSeconds(leg.start.time, durationS))
    : retimed(plan, leg, addSeconds(leg.end.time, -durationS), leg.end.time);
}

/**
 * Move a leg's departure. It keeps its duration (the arrival moves too) unless the arrival
 * is locked to a transit leg, in which case the duration changes instead.
 */
export function setLegStart(plan: Plan, legId: string, start: string): EditResult {
  const leg = editable(plan, legId);
  if (typeof leg === 'string') return { ok: false, reason: leg };
  const bounds = legBounds(plan, legId);
  if (!bounds.startFree) return { ok: false, reason: 'It leaves as soon as the ride before it arrives.' };
  if (!bounds.endFree) {
    if (toMs(start) > toMs(leg.end.time)) {
      return { ok: false, reason: `Leave by ${formatTime(leg.end.time)}: the ride after it leaves then.` };
    }
    return retimed(plan, leg, start, leg.end.time);
  }
  const end = addSeconds(start, legDurationS(leg));
  if (bounds.latestEnd && toMs(end) > toMs(bounds.latestEnd)) {
    const latest = addSeconds(bounds.latestEnd, -legDurationS(leg));
    return { ok: false, reason: `Leave by ${formatTime(latest)} to make the next leg.` };
  }
  return retimed(plan, leg, start, end);
}

/**
 * Move a leg's arrival. It keeps its duration (the departure moves too) unless the departure
 * is locked to a transit leg, in which case the duration changes instead.
 */
export function setLegEnd(plan: Plan, legId: string, end: string): EditResult {
  const leg = editable(plan, legId);
  if (typeof leg === 'string') return { ok: false, reason: leg };
  const bounds = legBounds(plan, legId);
  if (!bounds.endFree) return { ok: false, reason: 'It arrives just as the ride after it leaves.' };
  if (!bounds.startFree) {
    if (toMs(end) < toMs(leg.start.time)) {
      return {
        ok: false,
        reason: `Arrive at ${formatTime(leg.start.time)} or later: it leaves when the ride before it arrives.`,
      };
    }
    return retimed(plan, leg, leg.start.time, end);
  }
  const start = addSeconds(end, -legDurationS(leg));
  if (bounds.earliestStart && toMs(start) < toMs(bounds.earliestStart)) {
    const earliest = addSeconds(bounds.earliestStart, legDurationS(leg));
    return { ok: false, reason: `Arrive at ${formatTime(earliest)} or later: the previous leg ends first.` };
  }
  return retimed(plan, leg, start, end);
}

/**
 * Swap a walk or bike leg's route, e.g. to cycle instead of walk. Its anchored end stays put
 * if the new duration fits there; otherwise the other end, if free, is kept instead.
 */
export function setLegPath(plan: Plan, legId: string, mode: 'walk' | 'bike', path: PathInfo): EditResult {
  const leg = editable(plan, legId);
  if (typeof leg === 'string') return { ok: false, reason: leg };
  const bounds = legBounds(plan, legId);
  const durationS = path.routedDurationS;
  const preferred = durationAnchor(plan, legId);
  const other: FixedEnd = preferred === 'start' ? 'end' : 'start';
  const anchors = [preferred, ...((other === 'start' ? bounds.startFree : bounds.endFree) ? [other] : [])];
  for (const anchor of anchors) {
    const start = anchor === 'start' ? leg.start.time : addSeconds(leg.end.time, -durationS);
    const end = anchor === 'start' ? addSeconds(leg.start.time, durationS) : leg.end.time;
    const result = retimed(plan, leg, start, end, { mode, path });
    if (result.ok) return result;
  }
  return {
    ok: false,
    reason: `${mode === 'bike' ? 'Cycling' : 'Walking'} takes ${formatDuration(durationS)}, which doesn't fit between the legs around it.`,
  };
}

/**
 * After setLegPath: when the new route didn't fit with the end the leg keeps (see
 * durationAnchor), so that end moved instead, what it is now. "Walking takes 25 min, so it now
 * leaves at 8:22 AM." Null when the leg kept that end.
 */
export function switchMoved(before: Plan, after: Plan, legId: string): string | null {
  const old = before.legs.find((l) => l.id === legId);
  const now = after.legs.find((l) => l.id === legId);
  if (!old || !now) return null;
  const doing = now.mode === 'bike' ? 'Cycling' : 'Walking';
  const takes = `${doing} takes ${formatDuration(legDurationS(now))}`;
  if (durationAnchor(before, legId) === 'start') {
    return now.start.time === old.start.time
      ? null
      : `${takes}, so it now leaves at ${formatTime(now.start.time)}.`;
  }
  return now.end.time === old.end.time
    ? null
    : `${takes}, so it now arrives at ${formatTime(now.end.time)}.`;
}

/**
 * Whether a leg can be merged with the leg right after it: two walks, two bike rides or two
 * waits (yours or automatic) that meet at the same place.
 */
export function canMergeWithNext(plan: Plan, legId: string): boolean {
  const i = plan.legs.findIndex((l) => l.id === legId);
  const [a, b] = [plan.legs[i], plan.legs[i + 1]];
  return (
    i >= 0 &&
    b !== undefined &&
    a.mode === b.mode &&
    a.mode !== 'transit' &&
    distanceM(a.end.place, b.start.place) <= SAME_PLACE_M
  );
}

/**
 * Merge a walk, bike or wait leg with the same kind of leg right after it. The merged leg runs
 * from the first's start to the second's end along both routes, so no times change; the place
 * in between drops out of the plan. A wait merged with an automatic one becomes yours, at your
 * wait's place. With `nextId`, nothing is merged unless that is still the leg after `legId`.
 */
export function mergeWithNext(plan: Plan, legId: string, nextId?: string): EditResult {
  const after = plan.legs[plan.legs.findIndex((l) => l.id === legId) + 1];
  if (nextId !== undefined && after?.id !== nextId) {
    return { ok: false, reason: 'Those legs have changed, so nothing was merged.' };
  }
  if (!canMergeWithNext(plan, legId)) {
    return {
      ok: false,
      reason: 'Only two walks, two bike rides or two waits that meet can be merged.',
    };
  }
  const i = plan.legs.findIndex((l) => l.id === legId);
  const [a, b] = [plan.legs[i], plan.legs[i + 1]];
  // The merged leg is one you chose: it keeps that leg's id and the end it was planned from.
  const owner = a.auto ? b : a;
  const merged: Leg = { id: owner.id, mode: a.mode, start: a.start, end: b.end };
  if (a.mode === 'wait') {
    // A wait stays in one place: yours, when an automatic wait at a stop nearby comes first.
    merged.start = { place: owner.start.place, time: a.start.time };
    merged.end = { place: owner.end.place, time: b.end.time };
  }
  const fixed = a.auto || b.auto ? owner.fixed : (a.fixed ?? b.fixed);
  if (fixed) merged.fixed = fixed;
  if (a.path && b.path) merged.path = joinPaths(a.path, b.path);
  const legs = [...plan.legs.slice(0, i), merged, ...plan.legs.slice(i + 2)];
  return { ok: true, plan: { ...plan, legs: withWaits(legs) } };
}

/** Two routes, one after the other, as one: distances, times and heights add up. */
function joinPaths(a: PathInfo, b: PathInfo): PathInfo {
  const joint = a.geometry[a.geometry.length - 1];
  const next = b.geometry[0];
  const sameJoint = joint && next && joint[0] === next[0] && joint[1] === next[1];
  const path: PathInfo = {
    provider: a.provider === 'estimate' || b.provider === 'estimate' ? 'estimate' : a.provider,
    distanceM: a.distanceM + b.distanceM,
    routedDurationS: a.routedDurationS + b.routedDurationS,
    geometry: [...a.geometry, ...(sameJoint ? b.geometry.slice(1) : b.geometry)],
  };
  // A profile needs heights all the way along, at one spacing. The second route's first height
  // is the first route's last, at the place they meet.
  if (a.elevation && b.elevation && a.elevation.intervalM === b.elevation.intervalM) {
    path.elevation = {
      intervalM: a.elevation.intervalM,
      heightsM: [...a.elevation.heightsM, ...b.elevation.heightsM.slice(1)],
    };
  }
  return path;
}

export const samePlace = (a: Place, b: Place) =>
  a.lat === b.lat && a.lon === b.lon && (a.stopId ?? null) === (b.stopId ?? null);

/**
 * A place with a name you gave it. An empty name leaves it unnamed, to be shown by its
 * coordinates (placeName).
 */
export function withName(place: Place, name: string): Place {
  const renamed: Place = { ...place, name };
  if (name.trim()) renamed.named = true;
  else delete renamed.named;
  return renamed;
}

/**
 * A name as it's saved when you rename a place: each run of spaces or line breaks as one space,
 * none at either end. A name that tidies to the one it had is no change.
 */
export function tidyName(name: string): string {
  return name.replace(/\s+/g, ' ').trim();
}

/**
 * Whether the plan begins where and when you started planning it. Not once legs have been
 * added before that point, or the first legs after it removed or moved.
 */
export function startsAtAnchor(plan: Plan): boolean {
  const start = planStart(plan);
  return (
    toMs(start.time) === toMs(plan.anchor.time) &&
    start.place.lat === plan.anchor.place.lat &&
    start.place.lon === plan.anchor.place.lon
  );
}

/** Every distinct place in the plan, in travel order. */
export function planPlaces(plan: Plan): Place[] {
  const places: Place[] = [];
  const waypoints = plan.legs.length
    ? plan.legs.flatMap((l) => [l.start, l.end])
    : [plan.anchor];
  for (const { place } of waypoints) {
    if (!places.some((p) => samePlace(p, place))) places.push(place);
  }
  return places;
}

/** Rename a place everywhere it appears in the plan, with a name you gave it (see withName). */
export function renamePlace(plan: Plan, place: Place, name: string): Plan {
  const rename = (w: Waypoint): Waypoint =>
    samePlace(w.place, place) ? { ...w, place: withName(w.place, name) } : w;
  return {
    anchor: rename(plan.anchor),
    legs: withWaits(plan.legs.map((l) => ({ ...l, start: rename(l.start), end: rename(l.end) }))),
  };
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
