// Turn API results into plan legs. Pure functions; the UI does the fetching.

import type {
  NearbyStop,
  PathMode,
  RouteInfo,
  RouteResult,
  Stop,
  TripDetail,
  TripStop,
} from '../api';
import { SAME_PLACE_M, addSeconds, distanceM, newLegId, toMs } from './plan';
import type { Direction, Leg, PathInfo, Place, Waypoint } from './types';

const ACCESS_WORDS: Record<PathMode, string> = { walk: 'walk', bike: 'bike ride' };

// Mirror backend/src/incremental_routing/geo.py, for when the router is unavailable.
const DETOUR_FACTOR = 1.3;
const SPEEDS_MPS: Record<PathMode, number> = { walk: 1.3, bike: 4.5 };

/** A picked point this close to a stop is labelled after it. */
export const NEAR_STOP_M = 150;

export function routeLabel(route: RouteInfo): string {
  return route.short_name || route.long_name || route.route_id;
}

export function stopPlace(stop: Stop): Place {
  return { lat: stop.lat, lon: stop.lon, name: stop.name, stopId: stop.stop_id };
}

/** Default label for a point picked on the map: the nearest stop if close, else coordinates. */
export function pinName(point: { lat: number; lon: number }, nearest?: NearbyStop | null): string {
  if (nearest && nearest.distance_m <= NEAR_STOP_M) return `Near ${nearest.name}`;
  return `${point.lat.toFixed(5)}, ${point.lon.toFixed(5)}`;
}

/** Whether getting between a place and a stop needs a walk leg of its own. */
export function needsConnector(from: Place, stop: Place): boolean {
  return distanceM(from, stop) > SAME_PLACE_M;
}

/** Stand-in for a router result: straight-line distance with a detour factor. */
export function estimatedRoute(mode: PathMode, from: Place, to: Place): RouteResult {
  const distance = distanceM(from, to) * DETOUR_FACTOR;
  return {
    mode,
    provider: 'estimate',
    distance_m: distance,
    duration_s: distance / SPEEDS_MPS[mode],
    geometry: [
      [from.lon, from.lat],
      [to.lon, to.lat],
    ],
  };
}

/**
 * A route's duration rounded up to whole minutes. Timetables are in minutes too, so every time
 * in a plan stays on the minute and rounding up keeps connections on the safe side.
 */
export function pathDurationS(route: RouteResult): number {
  return Math.ceil(route.duration_s / 60) * 60;
}

/** Path info for a leg; also used when swapping a leg between walking and cycling. */
export function pathInfo(route: RouteResult, durationS: number = pathDurationS(route)): PathInfo {
  return {
    provider: route.provider,
    distanceM: route.distance_m,
    routedDurationS: durationS,
    geometry: route.geometry,
  };
}

/**
 * A walk or bike leg that leaves `from` at its time: planned forwards, or a walk to or from a
 * stop, which always leaves immediately (PLAN.md §9, decision 1).
 */
export function pathLeg(from: Waypoint, to: Place, route: RouteResult): Leg {
  const durationS = pathDurationS(route);
  return {
    id: newLegId(),
    mode: route.mode,
    fixed: 'start',
    start: from,
    end: { place: to, time: addSeconds(from.time, durationS) },
    path: pathInfo(route, durationS),
  };
}

/** A walk or bike leg planned backwards: it arrives at `to` exactly at its time. */
export function pathLegArriving(from: Place, to: Waypoint, route: RouteResult): Leg {
  const durationS = pathDurationS(route);
  return {
    id: newLegId(),
    mode: route.mode,
    fixed: 'end',
    start: { place: from, time: addSeconds(to.time, -durationS) },
    end: to,
    path: pathInfo(route, durationS),
  };
}

/** A wait you add yourself: after the end of the plan, or before its start. */
export function waitLeg(at: Waypoint, durationS: number, direction: Direction): Leg {
  if (direction === 'forward') {
    return {
      id: newLegId(),
      mode: 'wait',
      fixed: 'start',
      start: at,
      end: { place: at.place, time: addSeconds(at.time, durationS) },
    };
  }
  return {
    id: newLegId(),
    mode: 'wait',
    fixed: 'end',
    start: { place: at.place, time: addSeconds(at.time, -durationS) },
    end: at,
  };
}

/** Ride `trip` from the stop at boardSeq to the stop at alightSeq. */
export function transitLeg(trip: TripDetail, boardSeq: number, alightSeq: number): Leg {
  const board = trip.stops.find((s) => s.stop_sequence === boardSeq);
  const alight = trip.stops.find((s) => s.stop_sequence === alightSeq);
  if (!board || !alight || alightSeq <= boardSeq) {
    throw new Error(`Can't ride ${trip.trip_id} from stop #${boardSeq} to #${alightSeq}`);
  }
  const ridden = trip.stops.filter(
    (s) => s.stop_sequence >= boardSeq && s.stop_sequence <= alightSeq,
  );
  const geometry = shapeBetween(trip, board, alight);
  return {
    id: newLegId(),
    mode: 'transit',
    start: { place: stopPlace(board.stop), time: board.departure },
    end: { place: stopPlace(alight.stop), time: alight.arrival },
    transit: {
      tripId: trip.trip_id,
      serviceDate: trip.service_date,
      routeName: routeLabel(trip.route),
      headsign: trip.headsign,
      color: trip.route.color,
      textColor: trip.route.text_color,
      bikesAllowed: trip.bikes_allowed === 1 ? true : trip.bikes_allowed === 2 ? false : null,
      agency: trip.route.agency ?? null,
      ...(geometry && { geometry }),
      stops: ridden.map((s) => ({
        stopId: s.stop.stop_id,
        name: s.stop.name,
        lat: s.stop.lat,
        lon: s.stop.lon,
        time: s.departure,
      })),
    },
  };
}

/**
 * The trip's shape from one stop to another, starting and ending exactly at the stops. Null
 * when the feed has no shape for the trip.
 */
export function shapeBetween(
  trip: TripDetail,
  from: TripStop,
  to: TripStop,
): [number, number][] | null {
  if (!trip.shape || from.shape_index == null || to.shape_index == null) return null;
  return [
    [from.stop.lon, from.stop.lat],
    ...trip.shape.slice(from.shape_index, to.shape_index + 1),
    [to.stop.lon, to.stop.lat],
  ];
}

/** The line to preview while choosing where to get off (forwards) or on (backwards). */
export function previewLine(trip: TripDetail, stopSequence: number, direction: Direction) {
  const at = trip.stops.find((s) => s.stop_sequence === stopSequence);
  const first = trip.stops[0];
  const last = trip.stops[trip.stops.length - 1];
  const shaped = at && (direction === 'forward' ? shapeBetween(trip, at, last) : shapeBetween(trip, first, at));
  if (shaped) return shaped;
  return trip.stops
    .filter((s) => (direction === 'forward' ? s.stop_sequence >= stopSequence : s.stop_sequence <= stopSequence))
    .map((s): [number, number] => [s.stop.lon, s.stop.lat]);
}

export type LegsResult = { ok: true; legs: Leg[] } | { ok: false; reason: string };

/**
 * Planning forwards: the legs that take you from the frontier (the plan's end) onto `trip` and
 * off at alightSeq. A walk or bike ride to the boarding stop comes first when it isn't at the
 * frontier. Waits are added by withWaits. Pass that route whenever needsConnector says so.
 */
export function boardingLegs(
  frontier: Waypoint,
  trip: TripDetail,
  boardSeq: number,
  alightSeq: number,
  access: RouteResult | null,
): LegsResult {
  const ride = transitLeg(trip, boardSeq, alightSeq);
  if (toMs(ride.start.time) < toMs(frontier.time)) {
    return { ok: false, reason: 'That departure is before the end of your plan.' };
  }
  if (!needsConnector(frontier.place, ride.start.place)) return { ok: true, legs: [ride] };
  if (!access) throw new Error('boardingLegs needs a route to reach the stop');

  const connector = pathLeg(frontier, ride.start.place, access);
  if (toMs(connector.end.time) > toMs(ride.start.time)) {
    const minutes = Math.ceil(access.duration_s / 60);
    return {
      ok: false,
      reason: `The ${minutes}-min ${ACCESS_WORDS[access.mode]} to ${ride.start.place.name} arrives after this departure.`,
    };
  }
  return { ok: true, legs: [connector, ride] };
}

/**
 * Planning backwards: the legs that bring you from boardSeq on `trip` to the frontier (the
 * plan's start). A walk or bike ride from the alighting stop comes last when it isn't at the
 * frontier; it leaves as soon as you get off and spare time becomes a wait at the frontier.
 */
export function alightingLegs(
  frontier: Waypoint,
  trip: TripDetail,
  boardSeq: number,
  alightSeq: number,
  access: RouteResult | null,
): LegsResult {
  const ride = transitLeg(trip, boardSeq, alightSeq);
  if (toMs(ride.end.time) > toMs(frontier.time)) {
    return { ok: false, reason: 'That trip arrives after the start of your plan.' };
  }
  if (!needsConnector(ride.end.place, frontier.place)) return { ok: true, legs: [ride] };
  if (!access) throw new Error('alightingLegs needs a route from the stop');

  const connector = pathLeg(ride.end, frontier.place, access);
  if (toMs(connector.end.time) > toMs(frontier.time)) {
    const minutes = Math.ceil(access.duration_s / 60);
    return {
      ok: false,
      reason: `The ${minutes}-min ${ACCESS_WORDS[access.mode]} from ${ride.end.place.name} doesn't get you there in time.`,
    };
  }
  return { ok: true, legs: [ride, connector] };
}
