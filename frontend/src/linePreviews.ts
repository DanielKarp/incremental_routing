import type { LinePath, PathMode, TransitCall } from './api';
import type { CallGroup } from './callGroups';
import { routeLabel } from './plan/build';
import type { TransferNote } from './plan/transfers';
import { formatDuration, formatTime } from './time';

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
  /** The trip a click takes (see lineCall): when it leaves the stop, or arrives backwards. */
  time: string;
  /** How long the walk or bike ride between the stop and your point takes. */
  accessS: number;
  access: PathMode;
  /** About changing to or from the adjacent ride on that trip, if anything. */
  note: TransferNote | null;
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
  access: PathMode,
  noteFor?: (call: TransitCall) => TransferNote | null,
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
      time: direction === 'departures' ? call.departure : call.arrival,
      accessS: call.stop.access_s,
      access,
      note: noteFor?.(call) ?? null,
    };
  });
}

/** "2 min walk", "4 min by bike": between the stop and your point. */
export function accessText(preview: LinePreview): string {
  return `${formatDuration(preview.accessS)} ${preview.access === 'bike' ? 'by bike' : 'walk'}`;
}

/** A line in words: "9:02 AM · 38R 48th Avenue · Beale St & Mission St, 2 min walk". */
export function previewText(preview: LinePreview): string {
  const time = formatTime(preview.time);
  return `${time} · ${preview.label} · ${preview.stop.name}, ${accessText(preview)}`;
}

/**
 * Some of the lines, in the list's order: by time, the soonest departure (or the latest
 * arrival) first. Keys of lines that aren't in the list are left out.
 */
export function inListOrder(keys: string[], previews: LinePreview[]): LinePreview[] {
  const wanted = new Set(keys);
  return previews.filter((p) => wanted.has(p.key));
}
