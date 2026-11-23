// What the server's endpoints accepted (its api.py, until commit 1c15be0), checked the way
// FastAPI checked it: the same defaults and limits, and for a request it can't accept, the same
// messages, put as errorDetail() in api.ts puts FastAPI's ("Invalid radius_m: input should be
// less than or equal to 3000."), every field at fault in the endpoint's order.
//
// The queries take what api.ts takes, and api.ts leaves out a per-route count or limit that is
// 0 (or missing), and a transfer stop that is empty; so do these.

import type { CallQuery, LatLon, PathMode } from '../api';
import { TimeSyntaxError, parseDate, parseDateTime, requestInstant, type Zone } from './zone';

/** What the server would have answered with an HTTP error, and its status: 404, 422 or 503. */
export class TimetableError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'TimetableError';
  }
}

/** The transit leg next to the one being chosen, for looking up transfer rules. */
export interface TransferContext {
  stopId: string;
  tripId: string | null;
}

/** A departures or arrivals query, checked and with the server's defaults filled in. */
export interface CallParams {
  lat: number;
  lon: number;
  /** The query's time, as an instant (milliseconds, with any microseconds as a fraction). */
  when: number;
  radiusM: number;
  windowS: number;
  limit: number;
  access: PathMode;
  transfer: TransferContext | null;
  perRoute: number | null;
}

type Problems = [field: string, message: string][];

function fail(problems: Problems): never {
  const text = problems.map(([field, message]) => {
    // As errorDetail() words it: "Field required" reads on as "field required".
    const msg = /^[A-Z][a-z]/.test(message) ? message[0].toLowerCase() + message.slice(1) : message;
    return `Invalid ${field}: ${msg}.`;
  });
  throw new TimetableError(422, text.join(' '));
}

interface Bounds {
  ge?: number;
  gt?: number;
  le?: number;
}

/** A number within bounds, or what pydantic says about it. Bounds are checked le, ge, gt. */
function checkNumber(value: unknown, bounds: Bounds, integer: boolean): string | number {
  if (value === undefined || value === null) return 'Field required';
  if (typeof value !== 'number' || (integer && !Number.isSafeInteger(value))) {
    return integer
      ? 'Input should be a valid integer, unable to parse string as an integer'
      : 'Input should be a valid number, unable to parse string as a number';
  }
  // Written so that NaN fails, as it does in pydantic.
  if (bounds.le !== undefined && !(value <= bounds.le)) {
    return `Input should be less than or equal to ${bounds.le}`;
  }
  if (bounds.ge !== undefined && !(value >= bounds.ge)) {
    return `Input should be greater than or equal to ${bounds.ge}`;
  }
  if (bounds.gt !== undefined && !(value > bounds.gt)) {
    return `Input should be greater than ${bounds.gt}`;
  }
  return value;
}

class Checker {
  readonly problems: Problems = [];

  number(field: string, value: unknown, bounds: Bounds, integer = false): number {
    const checked = checkNumber(value, bounds, integer);
    if (typeof checked === 'number') return checked;
    this.problems.push([field, checked]);
    return NaN;
  }

  access(value: unknown): PathMode {
    if (value === 'walk' || value === 'bike') return value;
    this.problems.push(['access', "Input should be 'walk' or 'bike'"]);
    return 'walk';
  }

  done(): void {
    if (this.problems.length) fail(this.problems);
  }
}

const LAT = { ge: -90, le: 90 };
const LON = { ge: -180, le: 180 };
const RADIUS = { gt: 0, le: 3000 };

/** GET /api/departures and /api/arrivals, as api.ts calls them. */
export function callParams(q: CallQuery, local: Zone): CallParams {
  const { point, time, radiusM = 500, windowMin = 60, access = 'walk', transfer } = q;
  const check = new Checker();
  const lat = check.number('lat', point?.lat, LAT);
  const lon = check.number('lon', point?.lon, LON);
  let when = NaN;
  if (time === undefined || time === null) check.problems.push(['time', 'Field required']);
  else {
    try {
      when = requestInstant(parseDateTime(String(time)), local);
    } catch (e) {
      if (!(e instanceof TimeSyntaxError)) throw e;
      check.problems.push(['time', `Input should be a valid datetime or date, ${e.message}`]);
    }
  }
  const radius = check.number('radius_m', radiusM, RADIUS);
  const window = check.number('window_min', windowMin, { gt: 0, le: 360 }, true);
  const limit = q.limit ? check.number('limit', q.limit, { gt: 0, le: 500 }, true) : 40;
  const mode = check.access(access);
  const perRoute = q.perRoute
    ? check.number('per_route', q.perRoute, { ge: 1, le: 20 }, true)
    : null;
  check.done();
  const stopId = transfer ? String(transfer.stopId) : '';
  return {
    lat,
    lon,
    when,
    radiusM: radius,
    windowS: window * 60,
    limit,
    access: mode,
    transfer: stopId ? { stopId, tripId: transfer?.tripId ? String(transfer.tripId) : null } : null,
    perRoute,
  };
}

/** GET /api/stops/nearby. */
export function nearbyParams(point: LatLon, radiusM: number, access: PathMode) {
  const check = new Checker();
  const lat = check.number('lat', point?.lat, LAT);
  const lon = check.number('lon', point?.lon, LON);
  const radius = check.number('radius_m', radiusM, RADIUS);
  const mode = check.access(access);
  check.done();
  return { lat, lon, radiusM: radius, access: mode };
}

/** GET /api/trip: the service date, as an ISO date. */
export function tripParams(tripId: unknown, serviceDate: unknown): string {
  const problems: Problems = [];
  if (tripId === undefined || tripId === null) problems.push(['trip_id', 'Field required']);
  let date = '';
  if (serviceDate === undefined || serviceDate === null) {
    problems.push(['service_date', 'Field required']);
  } else {
    try {
      date = parseDate(String(serviceDate));
    } catch (e) {
      if (!(e instanceof TimeSyntaxError)) throw e;
      problems.push([
        'service_date',
        e.message.startsWith('datetimes')
          ? 'Datetimes provided to dates should have zero time - e.g. be exact dates'
          : `Input should be a valid date or datetime, ${e.message}`,
      ]);
    }
  }
  if (problems.length) fail(problems);
  return date;
}

// POST /api/lines takes at most this many trips.
const MAX_LINE_TRIPS = 500;

/** POST /api/lines: whether the paths run forward from the stops. */
export function linesParams(
  direction: unknown,
  trips: readonly { trip_id: unknown; stop_sequence: unknown }[],
): boolean {
  const problems: Problems = [];
  if (direction !== 'forward' && direction !== 'backward') {
    problems.push(['direction', "Input should be 'forward' or 'backward'"]);
  }
  if (!Array.isArray(trips)) problems.push(['trips', 'Input should be a valid list']);
  else if (trips.length > MAX_LINE_TRIPS) {
    problems.push([
      'trips',
      `List should have at most ${MAX_LINE_TRIPS} items after validation, not ${trips.length}`,
    ]);
  } else {
    trips.forEach((t, k) => {
      if (typeof t?.trip_id !== 'string') {
        problems.push([`trips.${k}.trip_id`, 'Input should be a valid string']);
      }
      if (!Number.isSafeInteger(t?.stop_sequence)) {
        problems.push([`trips.${k}.stop_sequence`, 'Input should be a valid integer']);
      }
    });
  }
  if (problems.length) fail(problems);
  return direction === 'forward';
}
