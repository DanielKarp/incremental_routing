// The app's data, as the FastAPI server's endpoints gave it (shapes mirror
// backend/src/incremental_routing/models.py): the transit queries are answered here in the
// browser, from the timetable (./timetable), downloaded once and kept in a Web Worker; walk and
// bike routes come from the site's Cloudflare Worker (worker/api.ts), which holds any router key.

import type { LoadProgress } from './timetable/load';
import { TimetableError } from './timetable/params';
import {
  type Method,
  type Queries,
  type RemoteTimetable,
  openRemoteTimetable,
} from './timetable/remote';

export interface LatLon {
  lat: number;
  lon: number;
}

export interface Health {
  status: string;
  gtfs_loaded: boolean;
  /** Why the transit data can't be used (missing, or needs rebuilding). */
  gtfs_problem: string | null;
  routing_provider: string;
}

export interface AgencyCoverage {
  name: string | null;
  start_date: string | null;
  end_date: string | null;
}

export interface FeedInfo {
  feed_id: string;
  timezone: string;
  start_date: string | null;
  end_date: string | null;
  loaded_at: string;
  has_frequencies: boolean;
  /** Each agency's own dates: in a regional feed their schedules run out at different times. */
  agencies?: AgencyCoverage[];
}

export interface RouteInfo {
  route_id: string;
  short_name: string | null;
  long_name: string | null;
  route_type: number;
  color: string | null;
  text_color: string | null;
  agency?: string | null;
}

export interface Stop {
  stop_id: string;
  feed_id: string;
  name: string;
  lat: number;
  lon: number;
  parent_station: string | null;
}

export interface NearbyStop extends Stop {
  distance_m: number;
  /** Estimated time between the queried point and the stop, walking or cycling. */
  access_s: number;
}

/**
 * What the feed's transfers.txt says about changing between two trips at these stops.
 * type: 0 recommended, 1 timed (the vehicle waits), 2 needs min_transfer_s, 3 not possible.
 */
export interface TransferRule {
  type: number;
  min_transfer_s: number | null;
}

export interface TransitCall {
  trip_id: string;
  service_date: string;
  route: RouteInfo;
  headsign: string | null;
  stop: NearbyStop;
  stop_sequence: number;
  arrival: string;
  departure: string;
  bikes_allowed: number | null;
  /** The rule for changing to (or from) the adjacent transit leg, when one was asked for. */
  transfer?: TransferRule | null;
}

export interface TripStop {
  stop: Stop;
  stop_sequence: number;
  arrival: string;
  departure: string;
  can_board: boolean;
  can_alight: boolean;
  /** Where the stop falls on TripDetail.shape. */
  shape_index?: number | null;
}

export interface TripDetail {
  trip_id: string;
  service_date: string;
  route: RouteInfo;
  headsign: string | null;
  bikes_allowed: number | null;
  stops: TripStop[];
  /** The trip's path as [lon, lat] pairs, from the feed's shapes.txt. */
  shape?: [number, number][] | null;
}

export type PathMode = 'walk' | 'bike';

export interface RouteResult {
  mode: PathMode;
  provider: string;
  distance_m: number;
  duration_s: number;
  /** [lon, lat] pairs. */
  geometry: [number, number][];
  /** Bike routes: heights in metres from the start, one every elevation_interval_m. */
  elevation_m?: number[] | null;
  elevation_interval_m?: number | null;
}

export interface CallQuery {
  point: LatLon;
  /** ISO datetime; without an offset the backend reads it as Bay Area local time. */
  time: string;
  radiusM?: number;
  windowMin?: number;
  /** How you get between the point and the stop; decides which trips are reachable. */
  access?: PathMode;
  /** The transit leg you'd change from (forwards) or to (backwards), for transfer rules. */
  transfer?: { stopId: string; tripId?: string };
  /** At most this many trips of each route, headsign and stop. */
  perRoute?: number;
  /** At most this many trips in all (the backend allows up to 500). */
  limit?: number;
}

/** The part of a trip you could ride from (or to) a stop, from /api/lines. */
export interface LinePath {
  trip_id: string;
  stop_sequence: number;
  /** [lon, lat] pairs. */
  geometry: [number, number][];
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * An error's `detail` as text. FastAPI sends a message, or for a request it can't accept (422)
 * a list of the fields at fault: "Invalid time: input should be a valid datetime or date."
 */
export function errorDetail(detail: unknown): string {
  if (typeof detail === 'string') return detail;
  const fields = Array.isArray(detail)
    ? detail.flatMap((d: { loc?: unknown; msg?: unknown }) => {
        if (typeof d?.msg !== 'string') return [];
        // Where the field was sent (query, body, path) goes without saying.
        const loc = Array.isArray(d.loc) ? d.loc.slice(1) : [];
        // "Field required" reads on as "field required", but "JSON" stays as it is.
        const msg = /^[A-Z][a-z]/.test(d.msg) ? d.msg[0].toLowerCase() + d.msg.slice(1) : d.msg;
        return [`Invalid ${loc.length ? loc.join('.') : 'request'}: ${msg}.`];
      })
    : [];
  return fields.length ? fields.join(' ') : JSON.stringify(detail);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      if (body?.detail !== undefined) detail = errorDetail(body.detail);
    } catch {
      // Not JSON; keep the status text.
    }
    throw new ApiError(res.status, detail);
  }
  return res.json() as Promise<T>;
}

/** How getting the timetable is going, for the panel to say. */
export type TimetableState =
  | { status: 'loading'; progress: LoadProgress | null }
  | { status: 'ready' }
  | { status: 'failed'; reason: string };

let loading: Promise<RemoteTimetable> | null = null;
let state: TimetableState = { status: 'loading', progress: null };
const listeners = new Set<() => void>();

function setState(next: TimetableState) {
  state = next;
  for (const listener of listeners) listener();
}

/**
 * The timetable: downloaded and opened once, the first time anything asks, and then shared.
 * If that fails (or its worker does, later), everything waiting is told why, and the next to
 * ask tries again.
 */
function timetable(): Promise<RemoteTimetable> {
  if (!loading) {
    setState({ status: 'loading', progress: null });
    const remote = openRemoteTimetable(
      new Worker(new URL('./timetable/worker.ts', import.meta.url), { type: 'module' }),
      {
        onProgress: (progress) => setState({ status: 'loading', progress }),
        onFailure: (e) => {
          if (loading === attempt) loading = null;
          setState({ status: 'failed', reason: e.message });
        },
      },
    );
    const attempt = remote.ready.then(
      () => {
        setState({ status: 'ready' });
        return remote;
      },
      (e) => {
        throw apiError(e);
      },
    );
    loading = attempt;
  }
  return loading;
}

/** What the server said with an HTTP error, said as it was. */
function apiError(e: unknown): unknown {
  return e instanceof TimetableError ? new ApiError(e.status, e.message) : e;
}

/** A query of the timetable, once it's there: it fails as the server's endpoint failed. */
async function query<M extends Method>(
  method: M,
  ...args: Parameters<Queries[M]>
): Promise<ReturnType<Queries[M]>> {
  const remote = await timetable();
  try {
    return await remote.call(method, ...args);
  } catch (e) {
    throw apiError(e);
  }
}

/** Whether the timetable is loading (and how far it's got), ready, or failed (and why). */
export const timetableState = {
  get: (): TimetableState => state,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  /** Get it, if nothing has yet; after a failure, try again. */
  load(): void {
    timetable().catch(() => {}); // Said by the state.
  },
};

/** What /api/info says: which walk and bike router the Worker uses. */
interface Info {
  routing_provider: string;
}

export const api = {
  health: async (): Promise<Health> => {
    const [transit, info] = await Promise.all([
      query('health').catch((e: Error) => ({
        status: 'ok',
        gtfs_loaded: false,
        gtfs_problem: e.message,
      })),
      request<Info>('/api/info'),
    ]);
    return { ...transit, routing_provider: info.routing_provider };
  },
  feeds: () => query('feeds'),
  nearbyStops: (point: LatLon, radiusM: number) => query('nearbyStops', point, radiusM),
  departures: (q: CallQuery) => query('departures', q),
  arrivals: (q: CallQuery) => query('arrivals', q),
  trip: (tripId: string, serviceDate: string) => query('trip', tripId, serviceDate),
  lines: (
    direction: 'forward' | 'backward',
    trips: { trip_id: string; stop_sequence: number }[],
  ) => query('lines', direction, trips),
  route: (mode: PathMode, origin: LatLon, destination: LatLon) =>
    request<RouteResult>('/api/route', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode, origin, destination }),
    }),
};
