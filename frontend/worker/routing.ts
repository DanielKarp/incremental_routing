// Walk and bike routing behind one interface, so providers can be swapped by config: the
// server's routing/ package (backend/src/incremental_routing/routing), ported. Each provider
// asks the same of its router and gives back the same RouteResult as the server's.

import { DETOUR_FACTOR, SPEEDS_MPS, decodePolyline, haversineM, pyRound } from './geo';

export type PathMode = 'walk' | 'bike';

export interface LatLon {
  lat: number;
  lon: number;
}

/** As the server's models.RouteResult, the frontend's RouteResult: every field, in order. */
export interface RouteResult {
  mode: PathMode;
  provider: string;
  distance_m: number;
  duration_s: number;
  /** [lon, lat] pairs, GeoJSON order. */
  geometry: [number, number][];
  /**
   * Bike routes from Valhalla: heights in metres, from the start and then one every
   * elevation_interval_m along the route (the last at its end).
   */
  elevation_m: number[] | null;
  elevation_interval_m: number | null;
}

/** A provider could not produce a route. */
export class RoutingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoutingError';
  }
}

export interface RoutingProvider {
  readonly name: string;
  route(mode: PathMode, origin: LatLon, destination: LatLon): Promise<RouteResult>;
}

const USER_AGENT = 'incremental-routing/0.1 (personal trip planner)';
const TIMEOUT_MS = 20_000;

/** A router's answer that isn't what it should be: a TypeError from reading it, say. */
class Unexpected extends Error {}

interface PostOptions {
  /** Query parameters, added to (or replacing) any in the URL. */
  params?: Record<string, string>;
  headers?: Record<string, string>;
}

/** Base for providers that call a web API. Pass `fetch` to stand in for the network. */
abstract class HttpRoutingProvider implements RoutingProvider {
  abstract readonly name: string;

  constructor(private readonly get: typeof fetch = fetch) {}

  abstract route(mode: PathMode, origin: LatLon, destination: LatLon): Promise<RouteResult>;

  protected async postJson(
    url: string,
    body: unknown,
    { params = {}, headers = {} }: PostOptions = {},
  ): Promise<unknown> {
    // Called on its own: the runtime's fetch won't be called as a method of something else.
    const get = this.get;
    let res: Response;
    try {
      const withParams = new URL(url);
      for (const [name, value] of Object.entries(params)) withParams.searchParams.set(name, value);
      res = await get(withParams.href, {
        method: 'POST',
        headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
        // As the server's client did: a redirect is an answer, not a route.
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      throw new RoutingError(`${this.name}: request failed: ${failure(e)}`);
    }
    let text: string;
    try {
      text = await res.text();
    } catch (e) {
      throw new RoutingError(`${this.name}: request failed: ${failure(e)}`);
    }
    if (res.status !== 200) {
      // The first 300 characters, as Python counts them.
      const start = Array.from(text).slice(0, 300).join('');
      throw new RoutingError(`${this.name}: HTTP ${res.status}: ${start}`);
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw this.unexpected();
    }
  }

  protected unexpected(): RoutingError {
    return new RoutingError(`${this.name}: unexpected response shape`);
  }

  /** The result `read` makes of a router's answer, or the error for an answer it can't use. */
  protected read(read: () => RouteResult): RouteResult {
    try {
      return read();
    } catch (e) {
      if (e instanceof TypeError || e instanceof RangeError || e instanceof Unexpected) {
        throw this.unexpected();
      }
      throw e;
    }
  }
}

/** Why a request failed, as the server's client said it ("timed out"). */
function failure(e: unknown): string {
  const error = e as { name?: unknown; message?: unknown; cause?: { message?: unknown } };
  // Whatever the runtime's DOMException is made of.
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return 'timed out';
  const message = String(error?.message ?? e);
  // Node's fetch says only "fetch failed"; why is in the cause.
  const cause = error?.cause?.message;
  return typeof cause === 'string' && cause ? `${message}: ${cause}` : message;
}

/** `x` if it's a number (or a bool, which Python counts as one), else the answer is unusable. */
function number(x: unknown): number {
  if (typeof x === 'number') return x;
  if (typeof x === 'boolean') return Number(x);
  throw new Unexpected();
}

function lonLat(c: unknown): [number, number] {
  const pair = c as unknown[];
  if (!Array.isArray(pair) || pair.length < 2) throw new Unexpected();
  return [number(pair[0]), number(pair[1])];
}

// --- Valhalla ----------------------------------------------------------------------------------

const COSTING: Record<PathMode, string> = { walk: 'pedestrian', bike: 'bicycle' };
// Bike routes come with heights at this spacing, for the hill profile. Valhalla's own times
// already slow the rider on climbs.
const ELEVATION_INTERVAL_M = 30;
// Below any real Bay Area height: a no-data value from the elevation tiles.
const NO_DATA_BELOW_M = -500;

/** Valhalla /route API: the public FOSSGIS server (no key, fair use) or Stadia Maps (key). */
export class ValhallaProvider extends HttpRoutingProvider {
  readonly name = 'valhalla';

  constructor(
    private readonly routeUrl: string,
    private readonly apiKey: string | null = null,
    get?: typeof fetch,
  ) {
    super(get);
  }

  async route(mode: PathMode, origin: LatLon, destination: LatLon): Promise<RouteResult> {
    const data = (await this.postJson(
      this.routeUrl,
      {
        locations: [
          { lat: origin.lat, lon: origin.lon },
          { lat: destination.lat, lon: destination.lon },
        ],
        costing: COSTING[mode],
        units: 'kilometers',
        ...(mode === 'bike' && { elevation_interval: ELEVATION_INTERVAL_M }),
      },
      { params: this.apiKey ? { api_key: this.apiKey } : {} },
    )) as any;
    return this.read(() => {
      const trip = data.trip;
      const legs = trip.legs;
      if (!Array.isArray(legs)) throw new Unexpected();
      const geometry: [number, number][] = [];
      for (const leg of legs) {
        if (typeof leg.shape !== 'string') throw new Unexpected();
        // Valhalla encodes shapes at 6 decimal places; consecutive legs share endpoints.
        const points = decodePolyline(leg.shape, 6).map(([lat, lon]): [number, number] => [
          lon,
          lat,
        ]);
        for (const point of geometry.length ? points.slice(1) : points) geometry.push(point);
      }
      const elevation = mode === 'bike' ? elevationOf(legs) : null;
      return {
        mode,
        provider: this.name,
        distance_m: number(trip.summary.length) * 1000,
        duration_s: number(trip.summary.time),
        geometry,
        elevation_m: elevation,
        elevation_interval_m: elevation ? ELEVATION_INTERVAL_M : null,
      };
    });
  }
}

/**
 * The heights along a one-leg route, or null if the server sent none or any is missing. A
 * server without elevation tiles leaves them out, and a gap would draw a false cliff.
 */
function elevationOf(legs: any[]): number[] | null {
  if (legs.length !== 1) return null;
  const heights = legs[0]?.elevation;
  if (!Array.isArray(heights) || heights.length < 2) return null;
  if (legs[0].elevation_interval !== ELEVATION_INTERVAL_M) return null;
  if (
    heights.some(
      (h) => (typeof h !== 'number' && typeof h !== 'boolean') || Number(h) < NO_DATA_BELOW_M,
    )
  ) {
    return null;
  }
  return heights.map((h) => pyRound(Number(h), 1));
}

// --- OpenRouteService ----------------------------------------------------------------------------

const ORS_DIRECTIONS_URL = 'https://api.openrouteservice.org/v2/directions/{profile}/geojson';

// Other useful profiles: cycling-road, cycling-electric, cycling-mountain, foot-hiking.
const PROFILES: Record<PathMode, string> = { walk: 'foot-walking', bike: 'cycling-regular' };

/** OpenRouteService directions (free API key; 2,000 directions requests/day on the free plan). */
export class OrsProvider extends HttpRoutingProvider {
  readonly name = 'ors';

  constructor(
    private readonly apiKey: string,
    get?: typeof fetch,
  ) {
    super(get);
  }

  async route(mode: PathMode, origin: LatLon, destination: LatLon): Promise<RouteResult> {
    const data = (await this.postJson(
      ORS_DIRECTIONS_URL.replace('{profile}', PROFILES[mode]),
      {
        coordinates: [
          [origin.lon, origin.lat],
          [destination.lon, destination.lat],
        ],
      },
      { headers: { Authorization: this.apiKey } },
    )) as any;
    return this.read(() => {
      const feature = data.features[0];
      // ORS omits summary fields when origin and destination coincide.
      const properties = feature.properties;
      if (!isObject(properties)) throw new Unexpected();
      const summary = 'summary' in properties ? properties.summary : {};
      if (!isObject(summary)) throw new Unexpected();
      const coordinates = feature.geometry.coordinates;
      if (!Array.isArray(coordinates)) throw new Unexpected();
      return {
        mode,
        provider: this.name,
        distance_m: 'distance' in summary ? number(summary.distance) : 0,
        duration_s: 'duration' in summary ? number(summary.duration) : 0,
        geometry: coordinates.map(lonLat),
        elevation_m: null,
        elevation_interval_m: null,
      };
    });
  }
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

// --- Straight line -------------------------------------------------------------------------------

/** Offline fallback: straight-line distance with a detour factor. Useful for tests and dev. */
export class StraightLineProvider implements RoutingProvider {
  readonly name = 'straight-line';

  async route(mode: PathMode, origin: LatLon, destination: LatLon): Promise<RouteResult> {
    const distance =
      haversineM(origin.lat, origin.lon, destination.lat, destination.lon) * DETOUR_FACTOR;
    return {
      mode,
      provider: this.name,
      distance_m: distance,
      duration_s: distance / SPEEDS_MPS[mode],
      geometry: [
        [origin.lon, origin.lat],
        [destination.lon, destination.lat],
      ],
      elevation_m: null,
      elevation_interval_m: null,
    };
  }
}

// --- Choosing one --------------------------------------------------------------------------------

/** The Worker's settings (wrangler.jsonc's vars, and its secrets), as the server's config.py. */
export interface RoutingEnv {
  /** "valhalla" (the default), "ors" or "straight-line". */
  ROUTING_PROVIDER?: string;
  /** Any Valhalla-compatible /route endpoint; the public FOSSGIS server by default. */
  VALHALLA_ROUTE_URL?: string;
  /** A secret: for a Valhalla server that wants one (Stadia Maps). */
  VALHALLA_API_KEY?: string;
  /** A secret: only for ROUTING_PROVIDER=ors. */
  ORS_API_KEY?: string;
}

export const DEFAULT_VALHALLA_ROUTE_URL = 'https://valhalla1.openstreetmap.de/route';

/** A setting, trimmed; blank is unset. */
function setting(value: string | undefined): string | null {
  return value?.trim() || null;
}

/** The keys in the settings, which nothing the Worker sends back may contain. */
export function secrets(env: RoutingEnv): string[] {
  return [env.VALHALLA_API_KEY, env.ORS_API_KEY].flatMap((key) => setting(key) ?? []);
}

/** The settings can't make a provider (the server would not have started). */
export class ConfigError extends Error {}

/** Valhalla (the public FOSSGIS server by default) unless ROUTING_PROVIDER says otherwise. */
export function makeProvider(env: RoutingEnv, get?: typeof fetch): RoutingProvider {
  const choice = (setting(env.ROUTING_PROVIDER) ?? 'valhalla').toLowerCase();
  if (choice === 'ors') {
    const key = setting(env.ORS_API_KEY);
    if (!key) throw new ConfigError('ROUTING_PROVIDER=ors requires ORS_API_KEY');
    return new OrsProvider(key, get);
  }
  if (choice === 'valhalla') {
    return new ValhallaProvider(
      setting(env.VALHALLA_ROUTE_URL) ?? DEFAULT_VALHALLA_ROUTE_URL,
      setting(env.VALHALLA_API_KEY),
      get,
    );
  }
  if (choice === 'straight-line') return new StraightLineProvider();
  throw new ConfigError(`Unknown ROUTING_PROVIDER '${choice}'`);
}
