// Typed client for the FastAPI backend. Shapes mirror backend/src/incremental_routing/models.py.

export interface LatLon {
  lat: number;
  lon: number;
}

export interface Health {
  status: string;
  gtfs_loaded: boolean;
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
  walk_s: number;
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
}

export interface TripStop {
  stop: Stop;
  stop_sequence: number;
  arrival: string;
  departure: string;
  can_board: boolean;
  can_alight: boolean;
}

export interface TripDetail {
  trip_id: string;
  service_date: string;
  route: RouteInfo;
  headsign: string | null;
  bikes_allowed: number | null;
  stops: TripStop[];
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

function callParams({ point, time, radiusM = 500, windowMin = 60 }: CallQuery): string {
  return new URLSearchParams({
    lat: String(point.lat),
    lon: String(point.lon),
    time,
    radius_m: String(radiusM),
    window_min: String(windowMin),
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
