// Every request in expected.json, which the server answered on the fixture's data: the port
// must answer the same, field for field, but for the shapes (simplified to 5 m here), which
// must be within that of the server's.

import { beforeAll, describe, expect, it } from 'vitest';
import { type CallQuery, type LinePath, type TripDetail, errorDetail } from '../api';
import expected from './fixtures/expected.json';
import { openFixture } from './fixtures/fixture';
import { lineGapM, pointGapM } from './fixtures/gaps';
import type { Timetable } from './timetable';

interface Exchange {
  method: string;
  path: string;
  params: Record<string, unknown>;
  status: number;
  body: unknown;
}

type LonLat = [number, number];

// How far the timetable's shapes may stray from the server's, in metres: the 5 m they're
// simplified to, and the 1e-5 degree (~1 m) they're stored to. Where a stop falls on the shape
// is the same point, but for that rounding.
const SHAPE_GAP_M = 6;
const STOP_POINT_GAP_M = 1.5;
// Lines are simplified again, to 10 m, as the server simplifies them; but from the timetable's
// points, so the points kept can differ, and either line can pass up to 10 m from a point the
// other keeps (and the timetable's points are 5 m from the server's).
const LINE_GAP_M = 15;

/** The query api.ts would make for the endpoint's parameters. */
function callQuery(p: Record<string, unknown>): CallQuery {
  return {
    point: { lat: p.lat as number, lon: p.lon as number },
    time: p.time as string,
    radiusM: p.radius_m as number | undefined,
    windowMin: p.window_min as number | undefined,
    limit: p.limit as number | undefined,
    access: p.access as CallQuery['access'],
    transfer: p.transfer_stop
      ? { stopId: p.transfer_stop as string, tripId: p.transfer_trip as string | undefined }
      : undefined,
    perRoute: p.per_route as number | undefined,
  };
}

function ask(t: Timetable, { path, params: p }: Exchange): unknown {
  switch (path) {
    case '/api/feeds':
      return t.feeds();
    case '/api/stops/nearby':
      return t.nearbyStops(
        { lat: p.lat as number, lon: p.lon as number },
        p.radius_m as number | undefined,
        p.access as 'walk' | undefined,
      );
    case '/api/departures':
      return t.departures(callQuery(p));
    case '/api/arrivals':
      return t.arrivals(callQuery(p));
    case '/api/trip':
      return t.trip(p.trip_id as string, p.service_date as string);
    case '/api/lines':
      return t.lines(p.direction as 'forward', p.trips as LinePath[]);
  }
  throw new Error(`No such endpoint: ${path}`);
}

function expectSameTrip(actual: TripDetail, server: TripDetail) {
  const withoutShape = (t: TripDetail) => ({
    ...t,
    shape: null,
    stops: t.stops.map((s) => ({ ...s, shape_index: null })),
  });
  expect(withoutShape(actual)).toEqual(withoutShape(server));
  if (!server.shape) {
    expect(actual.shape).toBeNull();
    expect(actual.stops.map((s) => s.shape_index)).toEqual(server.stops.map((s) => s.shape_index));
    return;
  }
  expect(lineGapM(actual.shape!, server.shape)).toBeLessThanOrEqual(SHAPE_GAP_M);
  actual.stops.forEach((stop, k) => {
    const index = server.stops[k].shape_index;
    if (index === null || index === undefined) {
      expect(stop.shape_index).toBeNull();
    } else {
      // The same point of the shape, as the timetable stores it.
      const gap = pointGapM(actual.shape![stop.shape_index!], server.shape![index]);
      expect(gap).toBeLessThanOrEqual(STOP_POINT_GAP_M);
    }
  });
}

function expectSameLines(actual: LinePath[], server: LinePath[]) {
  const ids = (paths: LinePath[]) => paths.map((p) => [p.trip_id, p.stop_sequence]);
  expect(ids(actual)).toEqual(ids(server));
  actual.forEach((path, k) => {
    const theirs = server[k].geometry as LonLat[];
    // The ends are the stops, as the server has them; between them, the simplified shape.
    expect(path.geometry[0]).toEqual(theirs[0]);
    expect(path.geometry[path.geometry.length - 1]).toEqual(theirs[theirs.length - 1]);
    expect(lineGapM(path.geometry, theirs)).toBeLessThanOrEqual(LINE_GAP_M);
  });
}

describe('the port answers as the server does', () => {
  let timetable: Timetable;
  beforeAll(async () => {
    timetable = await openFixture();
  });

  const exchanges = expected as Exchange[];
  it.each(
    exchanges.map((e, k): [string, Exchange] => [
      `${k} ${e.path} ${JSON.stringify(e.params)}`.slice(0, 160),
      e,
    ]),
  )('%s', (_, exchange) => {
    if (exchange.status !== 200) {
      const detail = (exchange.body as { detail: unknown }).detail;
      expect(() => ask(timetable, exchange)).toThrow(
        expect.objectContaining({ status: exchange.status, message: errorDetail(detail) }),
      );
      return;
    }
    const answer = ask(timetable, exchange);
    if (exchange.path === '/api/trip') {
      expectSameTrip(answer as TripDetail, exchange.body as TripDetail);
    } else if (exchange.path === '/api/lines') {
      expectSameLines(answer as LinePath[], exchange.body as LinePath[]);
    } else {
      // As JSON, so that numbers compare as the server wrote them.
      expect(JSON.parse(JSON.stringify(answer))).toEqual(exchange.body);
    }
  });
});
