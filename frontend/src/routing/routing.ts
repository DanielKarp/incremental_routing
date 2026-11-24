// Walk and bike routing behind one interface, so providers can be swapped by the build's
// settings. The page asks the router itself (decision 23): this ran in the site's Worker until
// M14, and was the server's routing/ package (until commit 1c15be0) before that. Each provider
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

const TIMEOUT_MS = 20_000;

/** A router's answer that isn't what it should be: a TypeError from reading it, say. */
class Unexpected extends Error {}

/** Base for providers that call a web API. Pass `fetch` to stand in for the network. */
abstract class HttpRoutingProvider implements RoutingProvider {
  abstract readonly name: string;

  // The page's fetch as it is when asked, so that a stand-in set later is the one used.
  constructor(private readonly get: typeof fetch = (input, init) => fetch(input, init)) {}

  abstract route(mode: PathMode, origin: LatLon, destination: LatLon): Promise<RouteResult>;

  protected async postJson(url: string, body: unknown): Promise<unknown> {
    // Called on its own: a browser's fetch won't be called as a method of something else.
    const get = this.get;
    let res: Response;
    try {
      res = await get(new URL(url).href, {
        method: 'POST',
        // Only Content-Type: a page can't set User-Agent, and the FOSSGIS server's CORS rules
        // let a page send no other header but X-Client-Id.
        headers: { 'Content-Type': 'application/json' },
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
  // Node's fetch says only "fetch failed"; why is in the cause. (A browser keeps why to itself:
  // "Failed to fetch".)
  const cause = error?.cause?.message;
  return typeof cause === 'string' && cause ? `${message}: ${cause}` : message;
}

/** `x` if it's a number (or a bool, which Python counts as one), else the answer is unusable. */
function number(x: unknown): number {
  if (typeof x === 'number') return x;
  if (typeof x === 'boolean') return Number(x);
  throw new Unexpected();
}

// --- Valhalla ----------------------------------------------------------------------------------

const COSTING: Record<PathMode, string> = { walk: 'pedestrian', bike: 'bicycle' };
// Bike routes come with heights at this spacing, for the hill profile. Valhalla's own times
// already slow the rider on climbs.
const ELEVATION_INTERVAL_M = 30;
// Below any real Bay Area height: a no-data value from the elevation tiles.
const NO_DATA_BELOW_M = -500;

/** Valhalla /route API: the public FOSSGIS server (no key, fair use), or another like it. */
export class ValhallaProvider extends HttpRoutingProvider {
  readonly name = 'valhalla';

  constructor(
    private readonly routeUrl: string,
    get?: typeof fetch,
  ) {
    super(get);
  }

  async route(mode: PathMode, origin: LatLon, destination: LatLon): Promise<RouteResult> {
    const data = (await this.postJson(this.routeUrl, {
      locations: [
        { lat: origin.lat, lon: origin.lon },
        { lat: destination.lat, lon: destination.lon },
      ],
      costing: COSTING[mode],
      units: 'kilometers',
      ...(mode === 'bike' && { elevation_interval: ELEVATION_INTERVAL_M }),
    })) as any;
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

/**
 * The build's settings, from VITE_ROUTING_PROVIDER and VITE_VALHALLA_ROUTE_URL (DEPLOY.md). A
 * page can keep no secret, so there are no keys.
 */
export interface RoutingSettings {
  /** "valhalla" (the default) or "straight-line". */
  provider?: string;
  /** Any Valhalla /route endpoint that takes requests from other sites; FOSSGIS's by default. */
  valhallaRouteUrl?: string;
}

export const DEFAULT_VALHALLA_ROUTE_URL = 'https://valhalla1.openstreetmap.de/route';

/** A setting, trimmed; blank is unset. */
function setting(value: string | undefined): string | null {
  return value?.trim() || null;
}

/** The settings can't make a provider. */
export class ConfigError extends Error {}

/** Valhalla (the public FOSSGIS server by default) unless the settings say otherwise. */
export function makeProvider(settings: RoutingSettings, get?: typeof fetch): RoutingProvider {
  const choice = (setting(settings.provider) ?? 'valhalla').toLowerCase();
  if (choice === 'valhalla') {
    return new ValhallaProvider(
      setting(settings.valhallaRouteUrl) ?? DEFAULT_VALHALLA_ROUTE_URL,
      get,
    );
  }
  if (choice === 'straight-line') return new StraightLineProvider();
  throw new ConfigError(`Unknown VITE_ROUTING_PROVIDER '${choice}'`);
}
