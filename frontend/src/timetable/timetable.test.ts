// The queries on the fixture's timetable (see fixtures/fixture.ts), as backend/tests/test_gtfs.py
// tests the server's, and the cases where order decides that the fixture adds.

import { beforeAll, describe, expect, it } from 'vitest';
import type { CallQuery, LatLon, TransitCall } from '../api';
import { openFixture } from './fixtures/fixture';
import type { Timetable } from './timetable';

const ALPHA = { lat: 37.4, lon: -122.1 };
const BRAVO = { lat: 37.41, lon: -122.1 };
const DELTA = { lat: 37.43, lon: -122.1 };
const ECHO = { lat: 37.43, lon: -122.09 };
const SOUTH_OF_ALPHA = { lat: 37.3937, lon: -122.1 }; // ~700 m: 12 min on foot, 4 by bike
const KILO = { lat: 37.5, lon: -122.2 };
const LIMA = { lat: 37.51, lon: -122.2 };
const MIKE = { lat: 37.52, lon: -122.2 };
const NOV_2 = { lat: 37.53, lon: -122.2 };

let timetable: Timetable;
beforeAll(async () => {
  timetable = await openFixture();
});

type Query = Partial<CallQuery> & { time: string };
const departures = (point: LatLon, q: Query) => timetable.departures({ point, ...q });
const arrivals = (point: LatLon, q: Query) => timetable.arrivals({ point, ...q });
const ids = (calls: TransitCall[]) => calls.map((c) => c.trip_id.replace('tr:', ''));

describe('nearby stops', () => {
  it('skip parent stations', () => {
    const stops = timetable.nearbyStops(DELTA, 200);
    expect(stops.map((s) => s.stop_id)).toEqual(['tr:DELTA_1', 'tr:DELTA_2']);
    expect(stops[0]).toMatchObject({ distance_m: 0, access_s: 0, parent_station: 'tr:DELTA' });
  });

  it("come nearest first, and equally near in the feed's order", () => {
    // Kilo B is listed before Kilo A in stops.txt.
    expect(timetable.nearbyStops(KILO, 50).map((s) => s.stop_id)).toEqual([
      'tr:KILO_B',
      'tr:KILO_A',
    ]);
  });
});

describe('departures', () => {
  it('leave from stops near the point, in local time', () => {
    const [call, ...more] = departures(ALPHA, { time: '2026-10-12T07:50' });
    expect(more).toEqual([]);
    expect(call).toMatchObject({
      trip_id: 'tr:T_MORNING',
      service_date: '2026-10-12',
      departure: '2026-10-12T08:00:00-07:00',
      route: { short_name: 'L1', agency: 'Test Rail', color: 'E31837' },
      stop: { name: 'Alpha' },
      headsign: 'Delta',
      bikes_allowed: 1,
      transfer: null,
    });
    // An offset is taken as given.
    expect(ids(departures(ALPHA, { time: '2026-10-12T14:50Z' }))).toEqual(['T_MORNING']);
  });

  it('leave time to walk to the stop', () => {
    // ~222 m north of Alpha: a ~3.7 minute walk, counted as 4, so leave by 07:56 for 08:00.
    const north = { lat: ALPHA.lat + 0.002, lon: ALPHA.lon };
    expect(ids(departures(north, { time: '2026-10-12T07:55' }))).toEqual(['T_MORNING']);
    expect(departures(north, { time: '2026-10-12T07:57' })).toEqual([]);
  });

  it('reach stops by bike that walking cannot', () => {
    const q = { time: '2026-10-12T07:50', radiusM: 1000 };
    expect(departures(SOUTH_OF_ALPHA, q)).toEqual([]);
    const [bike] = departures(SOUTH_OF_ALPHA, { ...q, access: 'bike' });
    expect(bike.trip_id).toBe('tr:T_MORNING');
    expect(bike.stop.access_s).toBe(240);
    const alpha = timetable.nearbyStops(SOUTH_OF_ALPHA, 1000).find((s) => s.name === 'Alpha');
    expect(alpha?.access_s).toBe(720); // walking is the default
  });

  it("after midnight, come from the previous day's service first", () => {
    const [late] = departures(BRAVO, { time: '2026-10-13T00:05' });
    expect(late).toMatchObject({
      trip_id: 'tr:T_LATE',
      service_date: '2026-10-12',
      departure: '2026-10-13T00:10:00-07:00',
    });
    // At the same minute as a trip of the new day, and on the same line: yesterday's first.
    const calls = departures(LIMA, { time: '2026-10-13T00:05' });
    expect(calls.map((c) => [c.trip_id, c.service_date, c.departure])).toEqual([
      ['tr:T_R3LATE', '2026-10-12', '2026-10-13T00:10:00-07:00'],
      ['tr:T_R3EARLY', '2026-10-13', '2026-10-13T00:10:00-07:00'],
    ]);
    expect(ids(departures(LIMA, { time: '2026-10-13T00:05', perRoute: 1 }))).toEqual(['T_R3LATE']);
  });

  it('follow calendar_dates.txt, the last of conflicting rows winning', () => {
    const thanksgiving = { time: '2026-11-26T07:50', windowMin: 120 };
    expect(ids(departures(ALPHA, thanksgiving))).toEqual(['T_SATURDAY']);
    // EXTRA runs on weekdays: removed and added again on Tuesday 1 December, added and
    // removed again on Wednesday 2 December, and added on Saturday 5 December.
    expect(ids(departures(LIMA, { time: '2026-12-01T11:50' }))).toEqual(['T_EXTRA']);
    expect(departures(LIMA, { time: '2026-12-02T11:50' })).toEqual([]);
    expect(ids(departures(LIMA, { time: '2026-12-05T11:50' }))).toEqual(['T_EXTRA']);
  });

  it("can't be boarded at a trip's last stop, or where pickup is prohibited", () => {
    // T_MORNING ends at Delta: only the buses starting there.
    expect(ids(departures(DELTA, { time: '2026-10-12T08:15' }))).toEqual(['T_BUS', 'T_BUS2']);
    expect(departures(KILO, { time: '2026-10-12T09:25' })).toEqual([]);
  });

  it("keep the server's order where times are equal", () => {
    // By stop_id (Kilo A, then Kilo B), then trip_id; T_R4A calls at both platforms and
    // stays at the first, as they're as near as each other.
    const q = { time: '2026-10-12T08:55', radiusM: 100 };
    const calls = departures(KILO, q);
    expect(calls.map((c) => [c.trip_id, c.stop.stop_id])).toEqual([
      ['tr:T_R3A', 'tr:KILO_A'],
      ['tr:T_R3D', 'tr:KILO_A'],
      ['tr:T_R4A', 'tr:KILO_A'],
      ['tr:T_R3B', 'tr:KILO_B'],
      ['tr:T_R4B', 'tr:KILO_B'],
    ]);
    expect(ids(departures(KILO, { ...q, limit: 2 }))).toEqual(['T_R3A', 'T_R3D']);
    // One per route, headsign and stop (T_R4A and T_R4B have no headsign).
    expect(ids(departures(KILO, { ...q, perRoute: 1 }))).toEqual([
      'T_R3A',
      'T_R4A',
      'T_R3B',
      'T_R4B',
    ]);
  });

  it('move a call to a nearer stop of its trip without moving it in the list', () => {
    // T_X is seen at Nov 1 (44 m away) first, then at Nov 2 (here); T_Y leaves Nov 1 at the
    // same time, and stays after it.
    const calls = departures(NOV_2, { time: '2026-10-12T09:55', radiusM: 100 });
    expect(calls.map((c) => [c.trip_id, c.stop.stop_id])).toEqual([
      ['tr:T_X', 'tr:NOV_2'],
      ['tr:T_Y', 'tr:NOV_1'],
    ]);
  });

  it('keep the first trips of each route, headsign and stop', () => {
    const q = { time: '2026-10-12T08:15', perRoute: 1 };
    expect(ids(departures(DELTA, q))).toEqual(['T_BUS']); // T_BUS2 runs the same route later
  });

  it('come in the order of their clock times on the night the clocks go back', () => {
    // As the server sorts them: by wall-clock time, so the 01:10 after the change comes
    // before the 01:30 before it, though it leaves 40 minutes later.
    const calls = departures(LIMA, { time: '2026-11-01T01:00:00-07:00', windowMin: 120 });
    expect(calls.map((c) => [c.trip_id, c.service_date, c.departure])).toEqual([
      ['tr:T_SUNEARLY', '2026-11-01', '2026-11-01T01:10:00-08:00'],
      ['tr:T_SATLATE', '2026-10-31', '2026-11-01T01:30:00-07:00'],
    ]);
    // A local time the clocks pass twice is the first of the two.
    const local = departures(LIMA, { time: '2026-11-01T01:00', windowMin: 120 });
    expect(local).toEqual(calls);
    const [sunday] = departures(ALPHA, { time: '2026-11-01T07:30' });
    expect(sunday.departure).toBe('2026-11-01T08:00:00-08:00');
  });

  it('read a time the clocks skip as the server does', () => {
    // 02:30 on 8 March doesn't happen: it's taken in PST, so 03:30 PDT, after both trips.
    expect(departures(LIMA, { time: '2026-03-08T02:30', windowMin: 180 })).toEqual([]);
    const calls = departures(LIMA, { time: '2026-03-08T00:00', windowMin: 180 });
    expect(calls.map((c) => c.departure)).toEqual([
      '2026-03-08T00:10:00-08:00',
      '2026-03-08T01:30:00-08:00',
    ]);
  });
});

describe('arrivals', () => {
  it('reach stops near the point before its time', () => {
    const calls = arrivals(DELTA, { time: '2026-10-12T08:30' });
    expect(calls.map((c) => [c.trip_id, c.arrival, c.stop.stop_id])).toEqual([
      ['tr:T_MORNING', '2026-10-12T08:20:00-07:00', 'tr:DELTA_1'],
    ]);
    // Nobody alights at a trip's first stop.
    expect(arrivals(ALPHA, { time: '2026-10-12T08:30' })).toEqual([]);
  });

  it('come latest first, keeping the last trips of each route', () => {
    expect(ids(arrivals(ECHO, { time: '2026-10-12T09:00' }))).toEqual(['T_BUS2', 'T_BUS']);
    expect(ids(arrivals(ECHO, { time: '2026-10-12T09:00', perRoute: 1 }))).toEqual(['T_BUS2']);
  });

  it('keep the order of equal times, as a stable reverse sort does', () => {
    expect(ids(arrivals(MIKE, { time: '2026-10-12T09:15' }))).toEqual(['T_R3A', 'T_R3B', 'T_R3D']);
  });

  it('leave out stops where drop-off is prohibited', () => {
    expect(ids(arrivals(LIMA, { time: '2026-10-12T09:40' }))).not.toContain('T_R3C');
  });

  it("count a trip's first stop even when it has no time", () => {
    // T_GHOST's first stop (Kilo A) has no time; Lima, its third, is the first shown.
    expect(ids(arrivals(LIMA, { time: '2026-10-12T07:25' }))).toEqual(['T_GHOST']);
  });

  it('come by clock time on the night the clocks go back', () => {
    const calls = arrivals(MIKE, { time: '2026-11-01T02:00:00-08:00', windowMin: 120 });
    expect(calls.map((c) => [c.trip_id, c.arrival])).toEqual([
      ['tr:T_SATLATE', '2026-11-01T01:40:00-07:00'],
      ['tr:T_SUNEARLY', '2026-11-01T01:20:00-08:00'],
    ]);
  });
});

describe('transfer rules', () => {
  const rules = (calls: TransitCall[]) =>
    Object.fromEntries(calls.map((c) => [c.trip_id.replace('tr:', ''), c.transfer]));

  it('are the most specific that apply', () => {
    const transfer = { stopId: 'tr:DELTA_1', tripId: 'tr:T_MORNING' };
    const calls = departures(DELTA, { time: '2026-10-12T08:20', transfer });
    expect(rules(calls)).toEqual({
      // Route L1 -> B2 between the platforms: 2 minutes.
      T_BUS: { type: 2, min_transfer_s: 120 },
      // This exact pair of trips: not possible.
      T_BUS2: { type: 3, min_transfer_s: null },
    });
  });

  it('apply station-wide through parent stations', () => {
    // Without the trip (so no route), only the station-wide rule applies.
    const transfer = { stopId: 'tr:DELTA_1' };
    const calls = departures(DELTA, { time: '2026-10-12T08:20', transfer });
    expect(calls.map((c) => c.transfer)).toEqual([
      { type: 2, min_transfer_s: 300 },
      { type: 2, min_transfer_s: 300 },
    ]);
  });

  it('apply when planning backwards', () => {
    const transfer = { stopId: 'tr:DELTA_2', tripId: 'tr:T_BUS' };
    const calls = arrivals(DELTA, { time: '2026-10-12T08:23', transfer });
    expect(calls.map((c) => [c.trip_id, c.transfer])).toEqual([
      ['tr:T_MORNING', { type: 2, min_transfer_s: 120 }],
    ]);
  });

  it("go to the first as specific, in the server's order", () => {
    const q = { time: '2026-10-12T08:55', radiusM: 100 };
    // From Kilo B: "Kilo B -> the station" (60 s) and "the station -> Kilo A" (90 s) are as
    // specific; the server reads them by from_stop, so Kilo B's comes first.
    const fromB = departures(KILO, { ...q, transfer: { stopId: 'tr:KILO_B' } });
    expect(fromB.find((c) => c.stop.stop_id === 'tr:KILO_A')?.transfer).toEqual({
      type: 2,
      min_transfer_s: 60,
    });
    // Two rules for Kilo A -> Kilo B alike: the feed's first.
    const fromA = departures(KILO, { ...q, transfer: { stopId: 'tr:KILO_A' } });
    expect(fromA.find((c) => c.stop.stop_id === 'tr:KILO_B')?.transfer).toEqual({
      type: 0,
      min_transfer_s: null,
    });
  });

  it('are null where none applies', () => {
    const [call] = departures(ALPHA, { time: '2026-10-12T07:50', transfer: { stopId: 'tr:X' } });
    expect(call.transfer).toBeNull();
  });
});

describe('trips', () => {
  it('list their stops, times and where you can get on and off', () => {
    const trip = timetable.trip('tr:T_MORNING', '2026-10-12');
    expect(trip.stops.map((s) => s.stop.name)).toEqual([
      'Alpha',
      'Bravo',
      'Charlie',
      'Delta Platform 1',
    ]);
    // Charlie's time is interpolated.
    expect(trip.stops[2].arrival).toBe('2026-10-12T08:13:00-07:00');
    expect(trip.stops.map((s) => s.can_board)).toEqual([true, true, true, false]);
    expect(trip.stops.map((s) => s.can_alight)).toEqual([false, true, true, true]);
    const flagged = timetable.trip('tr:T_R3C', '2026-10-12').stops;
    expect(flagged.map((s) => [s.can_board, s.can_alight])).toEqual([
      [false, false],
      [true, false],
      [false, true],
    ]);
  });

  it('run past midnight on their service date', () => {
    const trip = timetable.trip('tr:T_LATE', '2026-10-12');
    expect(trip.stops.at(-1)?.arrival).toBe('2026-10-13T00:20:00-07:00');
  });

  it("say why there's no such trip", () => {
    expect(() => timetable.trip('tr:T_MORNING', '2026-10-10')).toThrow(
      expect.objectContaining({
        status: 404,
        message: "Trip 'tr:T_MORNING' does not run on 2026-10-10",
      }),
    );
    expect(() => timetable.trip('tr:NOPE', '2026-10-12')).toThrow("Unknown trip 'tr:NOPE'");
    // As Python's repr() quotes it; and a trip whose route isn't in the feed isn't known.
    expect(() => timetable.trip("it's", '2026-10-12')).toThrow('Unknown trip "it\'s"');
    expect(() => timetable.trip('tr:T_NOROUTE', '2026-10-12')).toThrow('Unknown trip');
    expect(() => timetable.trip('tr:T_MORNING', '2026-1-2')).toThrow(
      expect.objectContaining({ status: 422 }),
    );
  });

  it('have their shape, with each stop at its point on it', () => {
    const trip = timetable.trip('tr:T_MORNING', '2026-10-12');
    // A straight line: the ends and the stops' points are all that's kept of 13 points.
    expect(trip.shape).toEqual([
      [-122.1, 37.4],
      [-122.1, 37.41],
      [-122.1, 37.42],
      [-122.1, 37.43],
    ]);
    expect(trip.stops.map((s) => s.shape_index)).toEqual([0, 1, 2, 3]);
    const bus = timetable.trip('tr:T_BUS', '2026-10-12');
    expect(bus.shape).toBeNull();
    expect(bus.stops.map((s) => s.shape_index)).toEqual([null, null]);
  });
});

describe('lines', () => {
  it('follow each trip onward from its stop, or to it, along its shape or stop to stop', () => {
    const [morning, bus] = timetable.lines('forward', [
      { trip_id: 'tr:T_MORNING', stop_sequence: 2 },
      { trip_id: 'tr:T_BUS', stop_sequence: 1 },
    ]);
    expect(morning.geometry).toEqual([
      [-122.1, 37.41],
      [-122.1, 37.43],
    ]);
    expect(bus.geometry).toEqual([
      [-122.1003, 37.4302],
      [-122.09, 37.43],
    ]);
    const [back] = timetable.lines('backward', [{ trip_id: 'tr:T_MORNING', stop_sequence: 2 }]);
    expect(back.geometry).toEqual([
      [-122.1, 37.4],
      [-122.1, 37.41],
    ]);
  });

  it('leave out unknown trips and stops, but draw trips of unknown routes', () => {
    const paths = timetable.lines('forward', [
      { trip_id: 'tr:NOPE', stop_sequence: 1 },
      { trip_id: 'tr:T_MORNING', stop_sequence: 99 },
      { trip_id: 'tr:T_NOROUTE', stop_sequence: 1 },
    ]);
    expect(paths.map((p) => p.trip_id)).toEqual(['tr:T_NOROUTE']);
  });

  it('take at most 500 trips, as the server does', () => {
    const trips = Array(501).fill({ trip_id: 'tr:T_MORNING', stop_sequence: 1 });
    expect(() => timetable.lines('forward', trips)).toThrow(
      'Invalid trips: list should have at most 500 items after validation, not 501.',
    );
  });
});

describe('requests', () => {
  it("are checked as the server checks them, every field it can't accept named", () => {
    expect(() =>
      departures(KILO, { time: '2026-13-01T08:00', radiusM: 0, windowMin: 1.5, limit: 501 }),
    ).toThrow(
      expect.objectContaining({
        status: 422,
        message:
          'Invalid time: input should be a valid datetime or date, month value is outside' +
          ' expected range of 1-12. Invalid radius_m: input should be greater than 0.' +
          ' Invalid window_min: input should be a valid integer, unable to parse string as an' +
          ' integer. Invalid limit: input should be less than or equal to 500.',
      }),
    );
    expect(() => timetable.nearbyStops({ lat: 91, lon: 0 }, 500, 'car' as 'walk')).toThrow(
      'Invalid lat: input should be less than or equal to 90.' +
        " Invalid access: input should be 'walk' or 'bike'.",
    );
  });

  it('leave out a per-route count or limit of 0, as api.ts does', () => {
    const q = { time: '2026-10-12T08:55', radiusM: 100 };
    expect(departures(KILO, { ...q, perRoute: 0, limit: 0 })).toEqual(departures(KILO, q));
  });
});
