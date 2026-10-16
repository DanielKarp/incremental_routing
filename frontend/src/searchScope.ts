// What the departure (or arrival) list searched: said above the list, and widened from it
// when it found nothing.

import { TRIPS_PER_LINE } from './callGroups';
import type { Direction } from './plan/types';
import { formatTime } from './time';

export const RADIUS_MIN_M = 50;
export const RADIUS_MAX_M = 3000; // The backend's limit.
const RADIUS_DEFAULT_M = 500;
// How far ahead (or back) the list looks, in minutes, and how far with "Look 3 hours ahead".
// The backend allows up to 360.
export const WINDOW_MIN = 60;
export const LONG_WINDOW_MIN = 180;
// The most trips a search lists: the backend's maximum too. With a few trips per line, an hour
// of them holds every line downtown, even within 3 km (about 360 trips at Civic Center).
export const CALL_LIMIT = 500;
// Over a wider radius, a longer window can reach the trip limit downtown and leave lines out,
// so a list that found something offers it only up to this radius.
const LONG_WINDOW_MAX_RADIUS_M = 1500;

/** A search for the list: which way, from when, how far around and how long. */
export interface SearchScope {
  direction: Direction;
  /** The frontier's time: departures after it, or arrivals before it. */
  time: string;
  radiusM: number;
  windowMin: number;
}

/** The radius searched for what's typed in the field: within the limits, 500 m if blank. */
export function searchRadius(typed: number): number {
  return Math.min(RADIUS_MAX_M, Math.max(RADIUS_MIN_M, typed || RADIUS_DEFAULT_M));
}

/** "500 m", "1 km", "1.5 km". */
export function formatDistance(metres: number): string {
  return metres < 1000 ? `${Math.round(metres)} m` : `${Number((metres / 1000).toFixed(2))} km`;
}

/** "hour", "3 hours", "90 min". */
function span(minutes: number): string {
  if (minutes === 60) return 'hour';
  return minutes % 60 === 0 ? `${minutes / 60} hours` : `${minutes} min`;
}

/** "the next hour", or backwards "the hour before 9:30 AM". */
function when({ direction, time, windowMin }: SearchScope): string {
  return direction === 'forward'
    ? `the next ${span(windowMin)}`
    : `the ${span(windowMin)} before ${formatTime(time)}`;
}

/** "Departures in the next hour within 500 m, up to 3 per line." */
export function scopeText(scope: SearchScope): string {
  const what = scope.direction === 'forward' ? 'Departures' : 'Arrivals';
  const where = formatDistance(scope.radiusM);
  return `${what} in ${when(scope)} within ${where}, up to ${TRIPS_PER_LINE} per line.`;
}

/** "Nothing leaves within 500 m in the next hour." */
export function nothingText(scope: SearchScope): string {
  const verb = scope.direction === 'forward' ? 'leaves' : 'arrives';
  return `Nothing ${verb} within ${formatDistance(scope.radiusM)} in ${when(scope)}.`;
}

/** What "Search within …" searches: twice the radius, up to the limit. Null at the limit. */
export function widerRadius(radiusM: number): number | null {
  return radiusM < RADIUS_MAX_M ? Math.min(RADIUS_MAX_M, radiusM * 2) : null;
}

/**
 * Whether to offer "Look 3 hours ahead" (or back): not when the list looks that far already,
 * and under a list that found something, only up to LONG_WINDOW_MAX_RADIUS_M.
 */
export function offersLongWindow(scope: SearchScope, found: boolean): boolean {
  if (scope.windowMin >= LONG_WINDOW_MIN) return false;
  return !found || scope.radiusM <= LONG_WINDOW_MAX_RADIUS_M;
}

/** Said when the search stopped at its limit: the latest departures (earliest arrivals) are cut. */
export function cutText({ direction, windowMin }: SearchScope, limit: number): string {
  const cut =
    direction === 'forward'
      ? `the first ${limit} trips are listed, so lines that leave later`
      : `the last ${limit} trips are listed, so lines that arrive earlier`;
  // Over a longer window, the link next to it goes back to the hour.
  const hour = direction === 'forward' ? 'the next hour' : 'the hour before';
  const instead = windowMin > WINDOW_MIN ? ` or just ${hour}` : '';
  return `Only ${cut} may be missing. Try a smaller radius${instead}.`;
}
