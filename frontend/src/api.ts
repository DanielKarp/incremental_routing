// Typed client for the FastAPI backend. Shapes mirror backend/src/incremental_routing/models.py.

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

export interface FeedInfo {
  feed_id: string;
  timezone: string;
  start_date: string | null;
  end_date: string | null;
  loaded_at: string;
  has_frequencies: boolean;
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
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail);
    } catch {
      // Not JSON; keep the status text.
    }
    throw new ApiError(res.status, detail);
  }
  return res.json() as Promise<T>;
}

function callParams(q: CallQuery): string {
  const { point, time, radiusM = 500, windowMin = 60, access = 'walk', transfer } = q;
  return new URLSearchParams({
    lat: String(point.lat),
    lon: String(point.lon),
    time,
    radius_m: String(radiusM),
    window_min: String(windowMin),
    access,
    ...(transfer && { transfer_stop: transfer.stopId }),
    ...(transfer?.tripId && { transfer_trip: transfer.tripId }),
  }).toString();
}

export const api = {
  health: () => request<Health>('/api/health'),
  feeds: () => request<FeedInfo[]>('/api/feeds'),
  nearbyStops: (point: LatLon, radiusM: number) =>
    request<NearbyStop[]>(
      `/api/stops/nearby?${new URLSearchParams({
        lat: String(point.lat),
        lon: String(point.lon),
        radius_m: String(radiusM),
      })}`,
    ),
  departures: (q: CallQuery) => request<TransitCall[]>(`/api/departures?${callParams(q)}`),
  arrivals: (q: CallQuery) => request<TransitCall[]>(`/api/arrivals?${callParams(q)}`),
  trip: (tripId: string, serviceDate: string) =>
    request<TripDetail>(
      `/api/trip?${new URLSearchParams({ trip_id: tripId, service_date: serviceDate })}`,
    ),
  route: (mode: PathMode, origin: LatLon, destination: LatLon) =>
    request<RouteResult>('/api/route', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode, origin, destination }),
    }),
};
