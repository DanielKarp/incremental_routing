import type { LinePath, TransitCall } from './api';
import type { CallGroup } from './callGroups';
import { routeLabel } from './plan/build';

/** A line you could take, as drawn while you choose: where it goes, and where to catch it. */
export interface LinePreview {
  /** The line's key in the list (see groupCalls). */
  key: string;
  /** The route's colour, hex without '#'; null for the default. */
  color: string | null;
  label: string;
  /** The part you could ride, as [lon, lat] pairs; null until it has loaded. */
  line: [number, number][] | null;
  /** Where you'd get on (forwards) or off (backwards). */
  stop: { lat: number; lon: number; name: string };
}

/** The trip a line stands for: its next departure, or its last arrival when planning back. */
export function lineCall(group: CallGroup, direction: 'departures' | 'arrivals'): TransitCall {
  return direction === 'departures' ? group.calls[0] : group.calls[group.calls.length - 1];
}

/** Each line in the list, with its path from /api/lines once that has arrived. */
export function linePreviews(
  groups: CallGroup[],
  direction: 'departures' | 'arrivals',
  paths: LinePath[],
): LinePreview[] {
  const byTrip = new Map(paths.map((p) => [`${p.trip_id}#${p.stop_sequence}`, p.geometry]));
  return groups.map((group) => {
    const call = lineCall(group, direction);
    return {
      key: group.key,
      color: call.route.color,
      label: `${routeLabel(call.route)} ${call.headsign ?? ''}`.trim(),
      line: byTrip.get(`${call.trip_id}#${call.stop_sequence}`) ?? null,
      stop: { lat: call.stop.lat, lon: call.stop.lon, name: call.stop.name },
    };
  });
}
