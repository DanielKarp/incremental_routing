// Turn API results into plan legs. Pure functions; the UI does the fetching.

import type { PathMode, RouteInfo, RouteResult, Stop, TripDetail } from '../api';
import { SAME_PLACE_M, addSeconds, distanceM, newLegId, toMs } from './plan';
import type { Leg, Place, Waypoint } from './types';

// Mirror backend/src/incremental_routing/geo.py, for when the router is unavailable.
const DETOUR_FACTOR = 1.3;
const SPEEDS_MPS: Record<PathMode, number> = { walk: 1.3, bike: 4.5 };

export function routeLabel(route: RouteInfo): string {
  return route.short_name || route.long_name || route.route_id;
}

export function stopPlace(stop: Stop): Place {
  return { lat: stop.lat, lon: stop.lon, name: stop.name, stopId: stop.stop_id };
}

/** Whether reaching `stop` from `from` needs a walk leg of its own. */
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

/** A walk or bike leg that leaves `from` immediately (PLAN.md §9, decision 1). */
export function pathLeg(from: Waypoint, to: Place, route: RouteResult): Leg {
  const durationS = Math.round(route.duration_s);
  return {
    id: newLegId(),
    mode: route.mode,
    start: from,
    end: { place: to, time: addSeconds(from.time, durationS) },
    path: {
      provider: route.provider,
      distanceM: route.distance_m,
      routedDurationS: durationS,
      geometry: route.geometry,
    },
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

export type BoardingResult = { ok: true; legs: Leg[] } | { ok: false; reason: string };

/**
 * The legs that take you from the frontier onto `trip` and off at alightSeq: a walk to the
 * boarding stop when it isn't at the frontier, then the ride. Waits are added by withWaits.
 * Pass the walk route whenever needsConnector says one is needed.
 */
export function boardingLegs(
  frontier: Waypoint,
  trip: TripDetail,
  boardSeq: number,
  alightSeq: number,
  walk: RouteResult | null,
): BoardingResult {
  const ride = transitLeg(trip, boardSeq, alightSeq);
  if (toMs(ride.start.time) < toMs(frontier.time)) {
    return { ok: false, reason: 'That departure is before the end of your plan.' };
  }
  if (!needsConnector(frontier.place, ride.start.place)) return { ok: true, legs: [ride] };
  if (!walk) throw new Error('boardingLegs needs a walk route to reach the stop');

  const connector = pathLeg(frontier, ride.start.place, walk);
  if (toMs(connector.end.time) > toMs(ride.start.time)) {
    const minutes = Math.ceil(walk.duration_s / 60);
    return {
      ok: false,
      reason: `The ${minutes}-min walk to ${ride.start.place.name} arrives after this departure.`,
    };
  }
  return { ok: true, legs: [connector, ride] };
}
