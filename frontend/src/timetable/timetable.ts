// The transit queries the server answers (backend/src/incremental_routing/gtfs/query.py), over
// the compact timetable the browser downloads (compact_schema.sql). Each query takes what the
// matching call in api.ts takes and gives back what that endpoint sends, field for field, in the
// same order, and the same answer: the same trips, stops and times, ties included. Only shapes
// differ, a little: the timetable's are simplified to 5 m (see trip() and lines()).
//
// Nothing here touches the DOM, so it runs in a page, a worker or Node alike; load.ts gets the
// database to it.

import type { Database, SqlValue, Statement } from 'sql.js';
import type {
  CallQuery,
  FeedInfo,
  Health,
  LatLon,
  LinePath,
  NearbyStop,
  PathMode,
  RouteInfo,
  TransferRule,
  TransitCall,
  TripDetail,
  TripStop,
} from '../api';
import { bboxDeltas, estimateAccessS, haversineM, pyRound, simplifyLine } from './geo';
import {
  type CallParams,
  type TransferContext,
  TimetableError,
  callParams,
  linesParams,
  nearbyParams,
  tripParams,
} from './params';
import { type ShapePoint, decodeShape } from './shapes';
import { Zone, addDays, weekday } from './zone';

// The compact timetable's layout this code reads (PRAGMA user_version, and the manifest's
// schema_version).
export const SCHEMA_VERSION = 1;

/** data/manifest.json: what `uv run ir-build-data` built, and the file to download. */
export interface Manifest {
  schema_version: number;
  /** When the timetable was built (ISO 8601, UTC). */
  built_at: string;
  timetable: {
    /** timetable-<hash>.sqlite.gz, next to the manifest: a new name whenever the data changes. */
    file: string;
    gzip_bytes: number;
    gzip_sha256: string;
    sqlite_bytes: number;
    sqlite_sha256: string;
  };
  /** Where request times without a UTC offset are, as the server's DEFAULT_TIMEZONE. */
  default_timezone: string;
  /** The timezones the feeds' times are in. */
  timezones: string[];
  /** Just as /api/feeds lists them, each agency's dates included. */
  feeds: FeedInfo[];
}

// Line previews are simplified to this, in metres: invisible at street zoom, and much lighter.
const LINE_SIMPLIFY_M = 10;
// Prepared statements kept, and decoded shapes: enough for the queries a list makes.
const STATEMENTS_KEPT = 64;
const SHAPES_KEPT = 256;

interface Feed {
  id: number;
  feedId: string;
  zone: Zone;
}

/** A stop near the queried point, with its integer ID and feed. */
interface Near {
  id: number;
  feed: Feed;
  stop: NearbyStop;
}

/** A trip calling at a nearby stop, before it's written out as a TransitCall. */
interface Candidate {
  /** trips.id and routes.id: as the feed's IDs, but integers. */
  trip: number;
  route: number;
  serviceDate: string;
  near: Near;
  stopSequence: number;
  /** Instants, in milliseconds. */
  arrival: number;
  departure: number;
}

/** What a call says about its trip, read only for the calls that may be kept. */
interface TripInfo {
  tripId: string;
  headsign: string | null;
  bikesAllowed: number | null;
}

/** A trip's stop with a time, in stop_sequence order. */
interface PathStop {
  stopSequence: number;
  arrivalS: number;
  departureS: number;
  pickupType: number;
  dropOffType: number;
  shapeIndex: number | null;
  stopId: string;
  feedId: string;
  name: string;
  lat: number;
  lon: number;
  parentStation: string | null;
}

/** The trip row the trip and lines queries start from. */
interface TripRow {
  feed: Feed;
  service: number;
  headsign: string | null;
  bikesAllowed: number | null;
  start: number;
  pattern: number;
  path: number;
  shape: number | null;
  firstSeq: number | null;
  lastSeq: number | null;
  route: RouteInfo | null;
}

// Trips are read this many at a time (SQLite takes up to 32766 parameters).
const TRIPS_AT_ONCE = 10_000;

/** A string as Python's repr() shows it, as the server's "Unknown trip 'x'" does. */
function pyRepr(text: string): string {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  const escaped = text.replace(/[\\\n\r\t\x00-\x1f\x7f]/g, (c) => {
    const named: Record<string, string> = { '\\': '\\\\', '\n': '\\n', '\r': '\\r', '\t': '\\t' };
    return named[c] ?? `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`;
  });
  return quote + (quote === "'" ? escaped.replace(/'/g, "\\'") : escaped) + quote;
}

const qmarks = (n: number) => Array(n).fill('?').join(', ');

export class Timetable {
  private readonly feedsById = new Map<number, Feed>();
  private readonly routes = new Map<number, RouteInfo>();
  private readonly zones = new Map<string, Zone>();
  private readonly local: Zone;
  private readonly statements = new Map<string, Statement>();
  private readonly services = new Map<string, Set<number>>();
  private readonly shapes = new Map<number, ShapePoint[]>();

  constructor(
    private readonly db: Database,
    readonly manifest: Manifest,
  ) {
    this.local = this.zone(manifest.default_timezone);
    for (const [id, feedId, timezone] of this.all('SELECT id, feed_id, timezone FROM feeds', [])) {
      this.feedsById.set(id as number, {
        id: id as number,
        feedId: feedId as string,
        zone: this.zone(timezone as string),
      });
    }
    for (const [id, routeId, agency, shortName, longName, type, color, textColor] of this.all(
      `SELECT id, route_id, agency_name, short_name, long_name, route_type, color, text_color
       FROM routes`,
      [],
    )) {
      this.routes.set(id as number, {
        route_id: routeId as string,
        short_name: shortName as string | null,
        long_name: longName as string | null,
        route_type: type as number,
        color: color as string | null,
        text_color: textColor as string | null,
        agency: agency as string | null,
      });
    }
  }

  /** What /api/health says about the transit data, once it has loaded. */
  health(): Pick<Health, 'status' | 'gtfs_loaded' | 'gtfs_problem'> {
    return { status: 'ok', gtfs_loaded: true, gtfs_problem: null };
  }

  /** /api/feeds: each feed's dates and timezone, and each agency's dates. */
  feeds(): FeedInfo[] {
    return structuredClone(this.manifest.feeds);
  }

  /** /api/stops/nearby: the stops within radiusM of the point, nearest first. */
  nearbyStops(point: LatLon, radiusM = 500, access: PathMode = 'walk'): NearbyStop[] {
    const p = nearbyParams(point, radiusM, access);
    return this.nearby(p.lat, p.lon, p.radiusM, p.access).map((s) => s.stop);
  }

  /**
   * /api/departures: trips you could reach (on foot or by bike) and board near the point
   * within the window after its time. With `transfer`, the leg you'd be changing from, each
   * call carries the matching transfers.txt rule; with `perRoute`, only the first that many
   * trips of each route, headsign and stop.
   */
  departures(q: CallQuery): TransitCall[] {
    return this.calls(callParams(q, this.local), true);
  }

  /**
   * /api/arrivals: trips you could alight from near the point and get to it from within the
   * window before its time (backward planning). With `transfer`, the leg you'd be changing to;
   * with `perRoute`, only the last that many arrivals of each route, headsign and stop.
   */
  arrivals(q: CallQuery): TransitCall[] {
    return this.calls(callParams(q, this.local), false);
  }

  /**
   * /api/trip: a trip's stops and times on a service date, and its shape. The shape is the
   * timetable's, simplified to 5 m, so it has fewer points than the server's, and each stop's
   * shape_index counts those points (it is the same point, to 1e-5 degree).
   */
  trip(tripId: string, serviceDate: string): TripDetail {
    const date = tripParams(tripId, serviceDate);
    const trip = this.tripRow(tripId);
    if (!trip?.route) throw new TimetableError(404, `Unknown trip ${pyRepr(tripId)}`);
    if (!this.activeServices(trip.feed, date).has(trip.service)) {
      throw new TimetableError(404, `Trip ${pyRepr(tripId)} does not run on ${date}`);
    }
    const zone = trip.feed.zone;
    const origin = zone.serviceDayOrigin(date);
    const shape = this.shape(trip.shape);
    const stops = this.pathStops(trip).map(
      (s): TripStop => ({
        stop: {
          stop_id: s.stopId,
          feed_id: s.feedId,
          name: s.name,
          lat: s.lat,
          lon: s.lon,
          parent_station: s.parentStation,
        },
        stop_sequence: s.stopSequence,
        arrival: zone.isoString(origin + s.arrivalS * 1000),
        departure: zone.isoString(origin + s.departureS * 1000),
        can_board: s.pickupType !== 1 && s.stopSequence !== trip.lastSeq,
        can_alight: s.dropOffType !== 1 && s.stopSequence !== trip.firstSeq,
        shape_index: shape ? s.shapeIndex : null,
      }),
    );
    return {
      trip_id: tripId,
      service_date: date,
      route: trip.route,
      headsign: trip.headsign,
      bikes_allowed: trip.bikesAllowed,
      stops,
      shape: shape && shape.map((p): [number, number] => [p.lon, p.lat]),
    };
  }

  /**
   * /api/lines: where each trip could take you from its stop (forward), or bring you to it
   * (backward), simplified for drawing. Unknown trips, and stops not on their trip, are left
   * out. Paths are simplified at 10 m as the server's are, but from the timetable's points (5 m
   * from the feed's), so the points kept can differ: a path can run 10 m or so from the
   * server's, though it follows the trip as closely.
   */
  lines(
    direction: 'forward' | 'backward',
    trips: readonly { trip_id: string; stop_sequence: number }[],
  ): LinePath[] {
    const forward = linesParams(direction, trips);
    const paths: LinePath[] = [];
    for (const { trip_id, stop_sequence } of trips) {
      const geometry = this.ridablePath(trip_id, stop_sequence, forward);
      if (geometry?.length) paths.push({ trip_id, stop_sequence, geometry });
    }
    return paths;
  }

  close(): void {
    for (const statement of this.statements.values()) statement.free();
    this.statements.clear();
    this.db.close();
  }

  private calls(p: CallParams, forward: boolean): TransitCall[] {
    // Each feed's nearby stops, by stop_id, feeds in the order their nearest stops come.
    const stopsByFeed = new Map<Feed, Map<string, Near>>();
    for (const near of this.nearby(p.lat, p.lon, p.radiusM, p.access)) {
      let stops = stopsByFeed.get(near.feed);
      if (!stops) stopsByFeed.set(near.feed, (stops = new Map()));
      stops.set(near.stop.stop_id, near);
    }

    // One call per trip and service date: the nearest stop it serves, if several are in range.
    // A nearer stop takes over a call where it stands, as in a Python dict.
    const best = new Map<string, Candidate>();
    for (const [feed, stops] of stopsByFeed) {
      const zone = feed.zone;
      const localDay = zone.localDate(p.when);
      const byId = new Map([...stops.values()].map((s) => [s.id, s]));
      // Yesterday's service day covers trips running past midnight.
      for (const serviceDate of [addDays(localDay, -1), localDay]) {
        const services = this.activeServices(feed, serviceDate);
        if (!services.size) continue;
        const origin = zone.serviceDayOrigin(serviceDate);
        const nowS = Math.floor((p.when - origin) / 1000);
        const [lo, hi] = forward ? [nowS, nowS + p.windowS] : [nowS - p.windowS, nowS];
        const sql = callsSql(forward, byId.size, services.size);
        for (const [trip, stop, stopSequence, arrival, departure, route] of this.all(sql, [
          lo,
          hi,
          ...byId.keys(),
          ...services,
        ]) as number[][]) {
          const near = byId.get(stop)!;
          // Leave time to get between the queried point and the stop.
          if (forward && departure < nowS + near.stop.access_s) continue;
          if (!forward && arrival > nowS - near.stop.access_s) continue;
          const key = `${trip}\n${serviceDate}`;
          const seen = best.get(key);
          if (seen && seen.near.stop.distance_m <= near.stop.distance_m) continue;
          best.set(key, {
            trip,
            route,
            serviceDate,
            near,
            stopSequence,
            arrival: origin + arrival * 1000,
            departure: origin + departure * 1000,
          });
        }
      }
    }

    // Sorted by time, stably; arrivals latest first, equal times keeping their order (as
    // Python's reverse=True does). Python compares times in the same zone by their wall-clock
    // time, so on the night the clocks go back 1:15 PST comes before 1:45 PDT; so do these.
    const time = (c: Candidate) => (forward ? c.departure : c.arrival);
    const earlier = (a: Candidate, b: Candidate) => {
      const zone = a.near.feed.zone;
      if (zone !== b.near.feed.zone) return time(a) - time(b);
      return zone.wallMs(time(a)) - zone.wallMs(time(b));
    };
    let calls = [...best.values()].sort(forward ? earlier : (a, b) => earlier(b, a));
    const trips = this.tripInfo(p.perRoute === null ? calls.slice(0, p.limit) : calls);
    if (p.perRoute !== null) calls = firstPerRoute(calls, trips, p.perRoute);
    const found = calls.slice(0, p.limit).map((c): TransitCall => {
      const zone = c.near.feed.zone;
      const trip = trips.get(c.trip)!;
      return {
        trip_id: trip.tripId,
        service_date: c.serviceDate,
        route: { ...this.routes.get(c.route)! },
        headsign: trip.headsign,
        stop: { ...c.near.stop },
        stop_sequence: c.stopSequence,
        arrival: zone.isoString(c.arrival),
        departure: zone.isoString(c.departure),
        bikes_allowed: trip.bikesAllowed,
        transfer: null,
      };
    });
    if (p.transfer) this.attachTransferRules(found, p.transfer, forward);
    return found;
  }

  /** The trip IDs, headsigns and bike rules of some calls' trips, by trips.id. */
  private tripInfo(calls: Candidate[]): Map<number, TripInfo> {
    const ids = [...new Set(calls.map((c) => c.trip))];
    const trips = new Map<number, TripInfo>();
    for (let at = 0; at < ids.length; at += TRIPS_AT_ONCE) {
      const some = ids.slice(at, at + TRIPS_AT_ONCE);
      for (const [id, tripId, headsign, bikesAllowed] of this.all(
        `SELECT id, trip_id, headsign, bikes_allowed FROM trips
         WHERE id IN (${qmarks(some.length)})`,
        some,
      )) {
        trips.set(id as number, {
          tripId: tripId as string,
          headsign: headsign as string | null,
          bikesAllowed: bikesAllowed as number | null,
        });
      }
    }
    return trips;
  }

  /**
   * The stops within radiusM, nearest first. Equally near stops come in the server's order:
   * by latitude, then the full database's row order (which stops.id follows).
   */
  private nearby(lat: number, lon: number, radiusM: number, access: PathMode): Near[] {
    const [dlat, dlon] = bboxDeltas(lat, radiusM);
    const stops: Near[] = [];
    for (const [id, feedId, stopId, name, stopLat, stopLon, parent] of this.all(
      `SELECT id, feed, stop_id, name, lat, lon, parent_station FROM stops
       WHERE location_type = 0 AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?
       ORDER BY lat, id`,
      [lat - dlat, lat + dlat, lon - dlon, lon + dlon],
    )) {
      const distance = haversineM(lat, lon, stopLat as number, stopLon as number);
      if (distance > radiusM) continue;
      const feed = this.feedsById.get(feedId as number)!;
      stops.push({
        id: id as number,
        feed,
        stop: {
          stop_id: stopId as string,
          feed_id: feed.feedId,
          name: name as string,
          lat: stopLat as number,
          lon: stopLon as number,
          parent_station: parent as string | null,
          distance_m: distance,
          access_s: estimateAccessS(distance, access),
        },
      });
    }
    return stops.sort((a, b) => a.stop.distance_m - b.stop.distance_m);
  }

  /** The services running on a date: calendar.txt's, then calendar_dates.txt's changes. */
  private activeServices(feed: Feed, date: string): Set<number> {
    const key = `${feed.id}\n${date}`;
    let services = this.services.get(key);
    if (services) return services;
    services = new Set(
      this.all(
        `SELECT service FROM calendar WHERE feed = ? AND ${weekday(date)} = 1
         AND start_date <= ? AND end_date >= ?`,
        [feed.id, date, date],
      ).map((row) => row[0] as number),
    );
    // In the feed's order: where rows conflict, the last one wins.
    for (const [service, exceptionType] of this.all(
      `SELECT service, exception_type FROM calendar_dates WHERE feed = ? AND date = ?
       ORDER BY rowid`,
      [feed.id, date],
    )) {
      if (exceptionType === 1) services.add(service as number);
      else if (exceptionType === 2) services.delete(service as number);
    }
    this.services.set(key, services);
    return services;
  }

  /** Set each call's transfer rule for changing from ctx (forward) or to ctx (backward). */
  private attachTransferRules(calls: TransitCall[], ctx: TransferContext, forward: boolean): void {
    const ctxRoute = ctx.tripId
      ? ((this.first(
          'SELECT r.route_id FROM trips t LEFT JOIN routes r ON r.id = t.route WHERE t.trip_id = ?',
          [ctx.tripId],
        )?.[0] ?? null) as string | null)
      : null;
    const stopIds = [...new Set([ctx.stopId, ...calls.map((c) => c.stop.stop_id)])];
    const parents = new Map(
      this.all(
        `SELECT stop_id, parent_station FROM stops WHERE stop_id IN (${qmarks(stopIds.length)})`,
        stopIds,
      ).map(([stopId, parent]) => [stopId as string, parent as string | null]),
    );
    const other: Leg = [ctx.stopId, ctxRoute, ctx.tripId];
    for (const call of calls) {
      const here: Leg = [call.stop.stop_id, call.route.route_id, call.trip_id];
      call.transfer = forward
        ? this.transferRule(parents, other, here)
        : this.transferRule(parents, here, other);
    }
  }

  /**
   * The most specific transfers.txt rule for changing from src to dst (stop, route, trip).
   * Rules may name a platform or its parent station, and may be limited to particular routes
   * or trips; trip beats route beats stop-only, and a platform beats its station. Between
   * rules as specific, the first wins, in the server's order: by from_stop, to_stop, then the
   * feed's order.
   */
  private transferRule(
    parents: Map<string, string | null>,
    [fromStop, fromRoute, fromTrip]: Leg,
    [toStop, toRoute, toTrip]: Leg,
  ): TransferRule | null {
    const fromIds = [fromStop, ...(parents.get(fromStop) ? [parents.get(fromStop)!] : [])];
    const toIds = [toStop, ...(parents.get(toStop) ? [parents.get(toStop)!] : [])];
    let best: TransferRule | null = null;
    let bestScore = -1;
    for (const rule of this.all(
      `SELECT from_stop, to_stop, transfer_type, min_transfer_s, from_route, to_route,
              from_trip, to_trip
       FROM transfers WHERE from_stop IN (${qmarks(fromIds.length)})
       AND to_stop IN (${qmarks(toIds.length)}) ORDER BY from_stop, to_stop, rowid`,
      [...fromIds, ...toIds],
    )) {
      const [ruleFrom, ruleTo, type, minTransferS] = rule;
      const [ruleFromRoute, ruleToRoute, ruleFromTrip, ruleToTrip] = rule.slice(4);
      if (
        (ruleFromTrip && ruleFromTrip !== fromTrip) ||
        (ruleToTrip && ruleToTrip !== toTrip) ||
        (ruleFromRoute && ruleFromRoute !== fromRoute) ||
        (ruleToRoute && ruleToRoute !== toRoute)
      ) {
        continue;
      }
      const score =
        8 * Number(!!ruleFromTrip) +
        8 * Number(!!ruleToTrip) +
        4 * Number(!!ruleFromRoute) +
        4 * Number(!!ruleToRoute) +
        Number(ruleFrom === fromStop) +
        Number(ruleTo === toStop);
      if (score > bestScore) {
        best = { type: type as number, min_transfer_s: minTransferS as number | null };
        bestScore = score;
      }
    }
    return best;
  }

  private tripRow(tripId: string): TripRow | null {
    const row = this.first(
      `SELECT t.feed, t.service, t.headsign, t.bikes_allowed, t.start, t.pattern, pa.id,
              pa.shape, pa.first_seq, pa.last_seq, t.route
       FROM trips t JOIN patterns p ON p.id = t.pattern JOIN paths pa ON pa.id = p.path
       WHERE t.trip_id = ?`,
      [tripId],
    );
    if (!row) return null;
    const [feed, service, headsign, bikesAllowed, start, pattern, path, shape] = row;
    return {
      feed: this.feedsById.get(feed as number)!,
      service: service as number,
      headsign: headsign as string | null,
      bikesAllowed: bikesAllowed as number | null,
      start: start as number,
      pattern: pattern as number,
      path: path as number,
      shape: shape as number | null,
      firstSeq: row[8] as number | null,
      lastSeq: row[9] as number | null,
      route: row[10] === null ? null : { ...this.routes.get(row[10] as number)! },
    };
  }

  /** The trip's stops that have a time, as the server lists them. */
  private pathStops(trip: TripRow): PathStop[] {
    return this.all(
      `SELECT ps.stop_sequence, pt.arrival, pt.departure, ps.pickup_type, ps.drop_off_type,
              ps.shape_index, s.stop_id, s.feed, s.name, s.lat, s.lon, s.parent_station
       FROM path_stops ps
       JOIN pattern_times pt ON pt.pattern = ? AND pt.stop_sequence = ps.stop_sequence
       JOIN stops s ON s.id = ps.stop
       WHERE ps.path = ? AND pt.arrival IS NOT NULL
       ORDER BY ps.stop_sequence`,
      [trip.pattern, trip.path],
    ).map((row) => ({
      stopSequence: row[0] as number,
      arrivalS: trip.start + (row[1] as number),
      departureS: trip.start + (row[2] as number),
      pickupType: row[3] as number,
      dropOffType: row[4] as number,
      shapeIndex: row[5] as number | null,
      stopId: row[6] as string,
      feedId: this.feedsById.get(row[7] as number)!.feedId,
      name: row[8] as string,
      lat: row[9] as number,
      lon: row[10] as number,
      parentStation: row[11] as string | null,
    }));
  }

  /** A shape's points, or null for none or one too short to draw (under 2 points). */
  private shape(id: number | null): ShapePoint[] | null {
    if (id === null) return null;
    let points = this.shapes.get(id);
    if (!points) {
      const blob = this.first('SELECT points FROM shapes WHERE id = ?', [id])?.[0];
      points = blob instanceof Uint8Array ? decodeShape(blob) : [];
      remember(this.shapes, id, points, SHAPES_KEPT);
    }
    return points.length < 2 ? null : points;
  }

  /** The trip's path from the stop to its end (forward), or from its start to the stop. */
  private ridablePath(
    tripId: string,
    stopSequence: number,
    forward: boolean,
  ): [number, number][] | null {
    const trip = this.tripRow(tripId);
    if (!trip) return null;
    const stops = this.pathStops(trip);
    const at = stops.findIndex((s) => s.stopSequence === stopSequence);
    if (at < 0) return null;
    const [first, last] = forward ? [at, stops.length - 1] : [0, at];
    const shape = this.shape(trip.shape);
    const point = (k: number): [number, number] => [
      pyRound(stops[k].lon, 6),
      pyRound(stops[k].lat, 6),
    ];
    const start = stops[first].shapeIndex;
    const end = stops[last].shapeIndex;
    let line: [number, number][];
    if (shape && start !== null && end !== null) {
      const along = shape.slice(start, end + 1).map((p): [number, number] => [p.lon, p.lat]);
      line = [point(first), ...along, point(last)];
    } else {
      line = []; // Stop to stop.
      for (let k = first; k <= last; k++) line.push(point(k));
    }
    return simplifyLine(line, LINE_SIMPLIFY_M);
  }

  private zone(name: string): Zone {
    let zone = this.zones.get(name);
    if (!zone) this.zones.set(name, (zone = new Zone(name)));
    return zone;
  }

  private statement(sql: string): Statement {
    let statement = this.statements.get(sql);
    if (statement) {
      // Most recently used last, so the least recently used goes first.
      this.statements.delete(sql);
    } else {
      statement = this.db.prepare(sql);
    }
    remember(this.statements, sql, statement, STATEMENTS_KEPT, (old) => old.free());
    return statement;
  }

  private all(sql: string, params: SqlValue[]): SqlValue[][] {
    const statement = this.statement(sql);
    const rows: SqlValue[][] = [];
    try {
      statement.bind(params);
      while (statement.step()) rows.push(statement.get());
    } finally {
      statement.reset();
    }
    return rows;
  }

  private first(sql: string, params: SqlValue[]): SqlValue[] | undefined {
    return this.all(sql, params)[0];
  }
}

/** A leg's stop, route and trip, for matching transfer rules. */
type Leg = [stopId: string, routeId: string | null, tripId: string | null];

/** Keep `value` in a map used as a cache, dropping the oldest entries beyond `size`. */
function remember<K, V>(map: Map<K, V>, key: K, value: V, size: number, drop?: (v: V) => void) {
  map.set(key, value);
  for (const [oldKey, old] of map) {
    if (map.size <= size) break;
    map.delete(oldKey);
    drop?.(old);
  }
}

/**
 * The trips calling at some of the stops within a window of times, on some services, in the
 * server's order: by stop_id, time, trip_id and stop_sequence, as its index gives them (and
 * trips.id follows trip_id). Parameters: the window's ends, the stops' IDs, then the services.
 * Only integers come back, which sql.js hands over much faster than text.
 */
function callsSql(forward: boolean, stops: number, services: number): string {
  const time = forward ? 'pt.departure' : 'pt.arrival';
  // Can't board at the last stop or where pickup is prohibited, nor alight at the first.
  const usable = forward
    ? 'ps.pickup_type != 1 AND ps.stop_sequence < pa.last_seq'
    : 'ps.drop_off_type != 1 AND ps.stop_sequence > pa.first_seq';
  return `
    SELECT t.id, ps.stop, ps.stop_sequence, t.start + pt.arrival AS arrival_s,
           t.start + pt.departure AS departure_s, t.route
    FROM path_stops ps
    JOIN paths pa ON pa.id = ps.path
    JOIN patterns p ON p.path = ps.path
    JOIN pattern_times pt ON pt.pattern = p.id AND pt.stop_sequence = ps.stop_sequence
    JOIN trips t ON t.pattern = p.id AND t.start BETWEEN ? - ${time} AND ? - ${time}
    JOIN stops s ON s.id = ps.stop
    WHERE ps.stop IN (${qmarks(stops)}) AND t.service IN (${qmarks(services)})
      AND t.route IS NOT NULL AND ${usable}
    ORDER BY s.stop_id, ${forward ? 'departure_s' : 'arrival_s'}, t.id, ps.stop_sequence`;
}

/** The first n calls, in the given order, of each route, headsign and stop. */
function firstPerRoute(calls: Candidate[], trips: Map<number, TripInfo>, n: number): Candidate[] {
  const seen = new Map<string, number>();
  return calls.filter((call) => {
    const key = JSON.stringify([call.route, trips.get(call.trip)!.headsign, call.near.id]);
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    return count <= n;
  });
}
