import type { TransitCall } from './api';

/** Trips listed for each line: its next departures, or its last arrivals when planning back. */
export const TRIPS_PER_LINE = 3;

/** One line where you'd catch it: a route and headsign at one stop, with its trips. */
export interface CallGroup {
  key: string;
  /** In time order. */
  calls: TransitCall[];
}

/**
 * Calls grouped into lines by route, headsign and stop. Lines keep the order of their first
 * call, so with the API's sorting the soonest departure (or the latest arrival) comes first.
 */
export function groupCalls(
  calls: TransitCall[],
  direction: 'departures' | 'arrivals',
): CallGroup[] {
  const lines = new Map<string, TransitCall[]>();
  for (const call of calls) {
    const key = JSON.stringify([call.route.route_id, call.headsign, call.stop.stop_id]);
    const line = lines.get(key);
    if (line) line.push(call);
    else lines.set(key, [call]);
  }
  const time = (c: TransitCall) => Date.parse(direction === 'departures' ? c.departure : c.arrival);
  return [...lines].map(([key, trips]) => ({
    key,
    calls: trips.sort((a, b) => time(a) - time(b)),
  }));
}
