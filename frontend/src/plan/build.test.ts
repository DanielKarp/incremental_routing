import { describe, expect, it } from 'vitest';
import type { NearbyStop, RouteResult, TransitCall, TripDetail, TripStop } from '../api';
import {
  alightingLegs,
  boardingLegs,
  connectorEnds,
  estimatedRoute,
  missedTrip,
  namedPlaceNear,
  needsConnector,
  nudgedPlace,
  pathInfo,
  pathLeg,
  pathLegArriving,
  pinName,
  previewLine,
  stopChoices,
  transitLeg,
  waitLeg,
} from './build';
import { appendLegs, prependLegs } from './plan';
import type { Leg, Place, Plan, Waypoint } from './types';

function stop(seq: number, name: string, lat: number, time: string): TripStop {
  return {
    stop: { stop_id: `tr:${name}`, feed_id: 'tr', name, lat, lon: -122.1, parent_station: null },
    stop_sequence: seq,
    arrival: `2026-10-12T${time}:00-07:00`,
    departure: `2026-10-12T${time}:00-07:00`,
    can_board: true,
    can_alight: true,
  };
}

const trip: TripDetail = {
  trip_id: 'tr:T1',
  service_date: '2026-10-12',
  route: {
    route_id: 'tr:L1',
    short_name: 'L1',
    long_name: null,
    route_type: 2,
    color: 'E31837',
    text_color: 'FFFFFF',
  },
  headsign: 'Delta',
  bikes_allowed: 2,
  stops: [
    stop(1, 'Alpha', 37.4, '08:00'),
    stop(2, 'Bravo', 37.41, '08:05'),
    stop(3, 'Charlie', 37.42, '08:13'),
  ],
};

// 07:50 PDT, at Alpha and ~330 m south of it.
const atAlpha: Waypoint = { place: { lat: 37.4, lon: -122.1 }, time: '2026-10-12T14:50:00.000Z' };
const nearAlpha: Waypoint = { place: { lat: 37.397, lon: -122.1 }, time: atAlpha.time };
// 08:30 PDT, ~330 m north of Charlie.
const nearCharlie: Waypoint = {
  place: { lat: 37.423, lon: -122.1, name: 'Office' },
  time: '2026-10-12T15:30:00.000Z',
};

const walkOf = (seconds: number): RouteResult => ({
  mode: 'walk',
  provider: 'test',
  distance_m: 400,
  duration_s: seconds,
  geometry: [],
});

describe('transitLeg', () => {
  it('rides from the boarding stop to the alighting stop', () => {
    const leg = transitLeg(trip, 1, 3);
    expect(leg.start).toMatchObject({ place: { name: 'Alpha' }, time: trip.stops[0].departure });
    expect(leg.end).toMatchObject({ place: { name: 'Charlie' }, time: trip.stops[2].arrival });
    expect(leg.transit?.stops.map((s) => s.name)).toEqual(['Alpha', 'Bravo', 'Charlie']);
    expect(leg.transit?.bikesAllowed).toBe(false);
  });

  it('rejects riding backwards', () => {
    expect(() => transitLeg(trip, 3, 1)).toThrow();
  });
});

describe('boardingLegs: planning forwards (decision 1: leave immediately)', () => {
  it('boards directly when already at the stop', () => {
    const result = boardingLegs(atAlpha, trip, 1, 2, null);
    expect(result.ok && result.legs.map((l) => l.mode)).toEqual(['transit']);
  });

  it('walks to the stop straight away and waits there', () => {
    expect(needsConnector(nearAlpha.place, { lat: 37.4, lon: -122.1 })).toBe(true);
    const result = boardingLegs(nearAlpha, trip, 1, 3, walkOf(300));
    if (!result.ok) throw new Error(result.reason);
    const [walk, ride] = result.legs;
    expect(walk).toMatchObject({ start: nearAlpha, fixed: 'start' });
    expect(walk.end.time).toBe('2026-10-12T14:55:00.000Z');

    const plan = appendLegs({ anchor: nearAlpha, legs: [] }, result.legs);
    expect(plan.legs.map((l) => l.mode)).toEqual(['walk', 'wait', 'transit']);
    expect(plan.legs[1].end.time).toBe(ride.start.time);
  });

  it('refuses a departure the walk cannot make', () => {
    const result = boardingLegs(nearAlpha, trip, 1, 3, walkOf(15 * 60));
    expect(result).toEqual({
      ok: false,
      reason: 'The 15-min walk to Alpha arrives after this departure.',
    });
  });
});

describe('alightingLegs: planning backwards', () => {
  it('walks from the stop as soon as you get off and waits at the destination', () => {
    const result = alightingLegs(nearCharlie, trip, 1, 3, walkOf(300));
    if (!result.ok) throw new Error(result.reason);
    const [ride, walk] = result.legs;
    expect(ride.end.place.name).toBe('Charlie');
    expect(walk).toMatchObject({ fixed: 'start', end: { place: { name: 'Office' } } });
    expect(walk.start.time).toBe(ride.end.time);

    const plan = prependLegs({ anchor: nearCharlie, legs: [] }, result.legs);
    expect(plan.legs.map((l) => l.mode)).toEqual(['transit', 'walk']);
    // Arriving 08:18 for an 08:30 start: the wait shows up once later legs are added.
    expect(Date.parse(walk.end.time)).toBeLessThan(Date.parse(nearCharlie.time));
  });

  it('refuses a trip whose walk would arrive too late', () => {
    const result = alightingLegs(nearCharlie, trip, 1, 3, walkOf(20 * 60));
    expect(result).toEqual({
      ok: false,
      reason: "The 20-min walk from Charlie doesn't get you there in time.",
    });
  });

  it('refuses a trip that arrives after the plan starts', () => {
    const early = { ...nearCharlie, time: '2026-10-12T15:00:00.000Z' };
    expect(alightingLegs(early, trip, 1, 3, walkOf(60)).ok).toBe(false);
  });
});

describe('walk, bike and wait legs', () => {
  const office = { lat: 37.43, lon: -122.1, name: 'Office' };

  it('forwards: leave now, arrive after the routed duration', () => {
    const leg = pathLeg(atAlpha, office, { ...walkOf(600), mode: 'bike' });
    expect(leg).toMatchObject({ mode: 'bike', fixed: 'start', start: atAlpha });
    expect(leg.end.time).toBe('2026-10-12T15:00:00.000Z');
  });

  it('rounds routed durations up to whole minutes', () => {
    const leg = pathLeg(atAlpha, office, walkOf(173));
    expect(leg.end.time).toBe('2026-10-12T14:53:00.000Z');
    expect(leg.path?.routedDurationS).toBe(180);
  });

  it('backwards: arrive exactly at the frontier, leave the routed duration earlier', () => {
    const leg = pathLegArriving(office, atAlpha, walkOf(600));
    expect(leg).toMatchObject({ mode: 'walk', fixed: 'end', end: atAlpha });
    expect(leg.start.time).toBe('2026-10-12T14:40:00.000Z');
  });

  it('manual waits extend the plan at either end', () => {
    expect(waitLeg(atAlpha, 300, 'forward')).toMatchObject({
      fixed: 'start',
      start: atAlpha,
      end: { place: atAlpha.place, time: '2026-10-12T14:55:00.000Z' },
    });
    expect(waitLeg(atAlpha, 300, 'backward')).toMatchObject({
      fixed: 'end',
      start: { place: atAlpha.place, time: '2026-10-12T14:45:00.000Z' },
      end: atAlpha,
    });
  });
});

describe('estimatedRoute and pinName', () => {
  it('estimates with straight-line distance and a detour factor', () => {
    const route = estimatedRoute('walk', nearAlpha.place, atAlpha.place);
    expect(route.provider).toBe('estimate');
    expect(route.distance_m).toBeCloseTo(333.6 * 1.3, 0);
    expect(route.duration_s).toBeCloseTo(route.distance_m / 1.3, 5);
  });

  it('names picked points after a nearby stop, or by coordinates', () => {
    const near = { name: 'Palo Alto Caltrain', distance_m: 90 } as NearbyStop;
    expect(pinName({ lat: 37.44, lon: -122.16 }, near)).toBe('Near Palo Alto Caltrain');
    expect(pinName({ lat: 37.44, lon: -122.16 }, { ...near, distance_m: 400 })).toBe(
      '37.44000, -122.16000',
    );
    expect(pinName({ lat: 37.44, lon: -122.16 }, null)).toBe('37.44000, -122.16000');
  });
});

describe('transit lines from shapes.txt', () => {
  const shaped: TripDetail = {
    ...trip,
    route: { ...trip.route, agency: 'Test Rail' },
    shape: [
      [-122.1, 37.4],
      [-122.1001, 37.405],
      [-122.1, 37.41],
      [-122.1002, 37.415],
      [-122.1, 37.42],
    ],
    stops: trip.stops.map((s, i) => ({ ...s, shape_index: i * 2 })),
  };

  it('stores the ridden part of the shape, from stop to stop', () => {
    const leg = transitLeg(shaped, 1, 2);
    expect(leg.transit?.geometry).toEqual([
      [-122.1, 37.4],
      [-122.1, 37.4],
      [-122.1001, 37.405],
      [-122.1, 37.41],
      [-122.1, 37.41],
    ]);
    expect(leg.transit?.agency).toBe('Test Rail');
  });

  it('leaves geometry out when the feed has no shape', () => {
    expect(transitLeg(trip, 1, 2).transit?.geometry).toBeUndefined();
  });

  it('draws stop to stop when the shape misses a stop it rides to', () => {
    // The backend leaves out the index of a stop the shape doesn't pass near.
    const offShape = {
      ...shaped,
      stops: shaped.stops.map((s, i) => (i === 2 ? { ...s, shape_index: null } : s)),
    };
    expect(transitLeg(offShape, 1, 3).transit?.geometry).toBeUndefined();
    expect(transitLeg(offShape, 1, 2).transit?.geometry).toHaveLength(5);
  });

  it('previews the rest of the line forwards, or the part before the stop backwards', () => {
    expect(previewLine(shaped, 2, 'forward')).toHaveLength(5); // Bravo .. Charlie: 3 points + 2 stops
    expect(previewLine(shaped, 2, 'backward')).toHaveLength(5);
    expect(previewLine(trip, 2, 'forward')).toEqual([
      [-122.1, 37.41],
      [-122.1, 37.42],
    ]);
  });
});

describe('choosing where to get off or on', () => {
  it('offers the later stops forwards and the earlier ones backwards, where allowed', () => {
    const seqs = (stops: { stop_sequence: number }[]) => stops.map((s) => s.stop_sequence);
    expect(seqs(stopChoices(trip, 1, 'forward'))).toEqual([2, 3]);
    expect(seqs(stopChoices(trip, 3, 'backward'))).toEqual([1, 2]);
    const noDropOff = {
      ...trip,
      stops: trip.stops.map((s, i) => (i === 1 ? { ...s, can_alight: false } : s)),
    };
    expect(seqs(stopChoices(noDropOff, 1, 'forward'))).toEqual([3]);
  });
});

describe('heights along bike routes', () => {
  it('keeps them on the leg when the router sends them', () => {
    const hilly: RouteResult = {
      ...walkOf(300),
      mode: 'bike',
      elevation_m: [4, 30],
      elevation_interval_m: 30,
    };
    expect(pathInfo(hilly).elevation).toEqual({ intervalM: 30, heightsM: [4, 30] });
    expect(pathInfo(walkOf(300)).elevation).toBeUndefined();
    expect(pathInfo({ ...hilly, elevation_m: [] }).elevation).toBeUndefined();
    expect(pathInfo({ ...hilly, elevation_m: [4] }).elevation).toBeUndefined();
  });
});

describe('getting to the stop by bike', () => {
  it('names the mode when the connection is too slow', () => {
    const slow = { ...walkOf(15 * 60), mode: 'bike' as const };
    expect(boardingLegs(nearAlpha, trip, 1, 3, slow)).toEqual({
      ok: false,
      reason: 'The 15-min bike ride to Alpha arrives after this departure.',
    });
  });

  it('adds a bike leg to the stop', () => {
    const result = boardingLegs(nearAlpha, trip, 1, 3, { ...walkOf(120), mode: 'bike' });
    expect(result.ok && result.legs.map((l) => l.mode)).toEqual(['bike', 'transit']);
  });
});

describe('checking the routed walk when a trip is picked', () => {
  // A line's next three departures from Alpha, at 08:00, 08:15 and 08:30 (PDT).
  const call = (hhmm: string, stopId = 'tr:Alpha'): TransitCall => ({
    trip_id: `tr:T${hhmm}`,
    service_date: '2026-10-12',
    route: trip.route,
    headsign: 'Delta',
    stop: {
      stop_id: stopId,
      feed_id: 'tr',
      name: 'Alpha',
      lat: 37.4,
      lon: -122.1,
      parent_station: null,
      distance_m: 330,
      access_s: 300,
    },
    stop_sequence: 1,
    arrival: `2026-10-12T${hhmm}:00-07:00`,
    departure: `2026-10-12T${hhmm}:00-07:00`,
    bikes_allowed: 1,
  });
  const line = [call('08:00'), call('08:15'), call('08:30')];

  it('says nothing when the walk makes the trip', () => {
    // Leaving at 07:50, a 10-min walk reaches the stop at 08:00 exactly.
    expect(missedTrip(nearAlpha, line[0], line, walkOf(10 * 60), 'forward')).toBeNull();
  });

  it("offers the line's next trip the walk makes", () => {
    // 14 min (rounded up from 13.5) gets there at 08:04.
    expect(missedTrip(nearAlpha, line[0], line, walkOf(13.5 * 60), 'forward')).toEqual({
      reason: "The walk to Alpha takes 14 min, so you'd miss the 8:00 AM.",
      instead: line[1],
    });
    const bike = { ...walkOf(30 * 60), mode: 'bike' as const };
    expect(missedTrip(nearAlpha, line[0], line, bike, 'forward')).toMatchObject({
      reason: "The bike ride to Alpha takes 30 min, so you'd miss the 8:00 AM.",
      instead: line[2],
    });
  });

  it('says when none of the listed trips can be made', () => {
    expect(missedTrip(nearAlpha, line[0], line, walkOf(45 * 60), 'forward')).toEqual({
      reason:
        "The walk to Alpha takes 45 min, so you'd miss the 8:00 AM. None of this line's listed " +
        'departures leaves late enough.',
      instead: null,
    });
  });

  it('only offers trips from the same stop, which the route goes to', () => {
    const elsewhere = [line[0], call('08:15', 'tr:Other')];
    expect(missedTrip(nearAlpha, line[0], elsewhere, walkOf(14 * 60), 'forward')?.instead).toBe(
      null,
    );
  });

  it("backwards: offers the line's latest arrival that still gets you there", () => {
    // The walk from the stop must reach the plan's start, 08:30, in time.
    const plan: Waypoint = { place: nearCharlie.place, time: '2026-10-12T15:30:00.000Z' };
    expect(missedTrip(plan, line[2], line, walkOf(5 * 60), 'backward')).toEqual({
      reason: 'The walk from Alpha takes 5 min, so the 8:30 AM gets you there too late.',
      instead: line[1],
    });
    expect(missedTrip(plan, line[1], line, walkOf(15 * 60), 'backward')).toBeNull();
    expect(missedTrip(plan, line[2], line, walkOf(40 * 60), 'backward')).toEqual({
      reason:
        'The walk from Alpha takes 40 min, so the 8:30 AM gets you there too late. None of ' +
        "this line's listed arrivals is early enough.",
      instead: null,
    });
  });

  it('routes from the frontier forwards and from the stop backwards, when there is a walk', () => {
    const stopAt = { lat: 37.4, lon: -122.1, name: 'Alpha' };
    expect(connectorEnds(nearAlpha.place, stopAt, 'forward')).toEqual({
      from: nearAlpha.place,
      to: stopAt,
    });
    expect(connectorEnds(nearAlpha.place, stopAt, 'backward')).toEqual({
      from: stopAt,
      to: nearAlpha.place,
    });
    expect(connectorEnds(atAlpha.place, stopAt, 'forward')).toBeNull();
  });
});

describe('naming a new end point after a place you named', () => {
  // About 11 m per 0.0001 degree of latitude.
  const HOME: Place = { lat: 37.44, lon: -122.16, name: 'Home', named: true };
  const CAFE: Place = { lat: 37.45, lon: -122.16, name: 'Cafe', named: true };
  const STOP: Place = { lat: 37.46, lon: -122.16, name: 'Palo Alto', stopId: 'ct:pa' };
  const NEAR_STOP: Place = { lat: 37.47, lon: -122.16, name: 'Near Alma St' };
  const PARK: Place = { lat: 37.48, lon: -122.16, name: 'Park', named: true };
  const at = (place: Place, hhmm: string): Waypoint => ({
    place,
    time: `2026-10-12T${hhmm}:00.000Z`,
  });
  const walk = (id: string, from: Waypoint, to: Waypoint): Leg => ({
    id,
    mode: 'walk',
    fixed: 'start',
    start: from,
    end: to,
  });
  // Home -> Cafe -> the stop -> near a stop -> Park, planned forwards from home.
  const plan: Plan = appendLegs({ anchor: at(HOME, '15:00'), legs: [] }, [
    walk('a', at(HOME, '15:00'), at(CAFE, '15:10')),
    walk('b', at(CAFE, '15:10'), at(STOP, '15:20')),
    walk('c', at(STOP, '15:20'), at(NEAR_STOP, '15:30')),
    walk('d', at(NEAR_STOP, '15:30'), at(PARK, '15:40')),
  ]);
  const north = (place: Place, m: number) => ({ lat: place.lat + m / 111_000, lon: place.lon });

  it('going back home ends exactly at home, called Home', () => {
    expect(namedPlaceNear(plan, north(HOME, 40), 'forward')).toEqual({
      lat: HOME.lat,
      lon: HOME.lon,
      name: 'Home',
      named: true,
    });
  });

  it('near a place in the middle of the plan, takes its name but stays where you picked', () => {
    const point = north(CAFE, 50);
    expect(namedPlaceNear(plan, point, 'forward')).toEqual({ ...point, name: 'Cafe', named: true });
  });

  it('not further than 75 m away', () => {
    expect(namedPlaceNear(plan, north(CAFE, 80), 'forward')).toBeNull();
  });

  it("not from stops, or places named after a stop or by coordinates: they aren't yours", () => {
    expect(namedPlaceNear(plan, north(STOP, 10), 'forward')).toBeNull();
    expect(namedPlaceNear(plan, north(NEAR_STOP, 10), 'forward')).toBeNull();
    const renamedStop = { ...STOP, name: 'My station', named: true };
    const withStop = appendLegs({ anchor: at(renamedStop, '15:00'), legs: [] }, [
      walk('x', at(renamedStop, '15:00'), at(PARK, '15:10')),
    ]);
    expect(namedPlaceNear(withStop, north(STOP, 10), 'forward')).toBeNull();
  });

  it('not from the end you are extending', () => {
    expect(namedPlaceNear(plan, north(PARK, 20), 'forward')).toBeNull();
  });

  it('takes the nearest of two', () => {
    const between = appendLegs({ anchor: at(HOME, '15:00'), legs: [] }, [
      walk('a', at(HOME, '15:00'), at({ ...CAFE, lat: HOME.lat + 0.0009 }, '15:10')),
      walk('b', at({ ...CAFE, lat: HOME.lat + 0.0009 }, '15:10'), at(PARK, '15:20')),
    ]);
    expect(namedPlaceNear(between, north(HOME, 60), 'forward')?.name).toBe('Cafe');
    expect(namedPlaceNear(between, north(HOME, 30), 'forward')?.name).toBe('Home');
  });

  it('backwards: near the end of the plan, ends exactly there', () => {
    expect(namedPlaceNear(plan, north(PARK, 20), 'backward')).toEqual({
      lat: PARK.lat,
      lon: PARK.lon,
      name: 'Park',
      named: true,
    });
    // Home is where it starts, which you're extending backwards.
    expect(namedPlaceNear(plan, north(HOME, 20), 'backward')).toBeNull();
  });

  it('nothing to go by in a plan without legs', () => {
    const noLegs = { anchor: at(HOME, '15:00'), legs: [] };
    expect(namedPlaceNear(noLegs, north(HOME, 20), 'forward')).toBeNull();
  });
});

describe('moving the start a little', () => {
  const HOME: Place = { lat: 37.44, lon: -122.16, name: 'Home', named: true };
  const north = (m: number) => ({ lat: HOME.lat + m / 111_000, lon: HOME.lon });

  it('keeps a name you gave it, within 75 m', () => {
    expect(nudgedPlace(HOME, north(20))).toEqual({ ...north(20), name: 'Home', named: true });
    expect(nudgedPlace(HOME, north(80))).toBeNull();
  });

  it("names it again when the name isn't yours, or there was no start", () => {
    const byCoordinates = { lat: HOME.lat, lon: HOME.lon, name: '37.44000, -122.16000' };
    expect(nudgedPlace(byCoordinates, north(5))).toBeNull();
    expect(nudgedPlace({ ...HOME, name: 'Near Alma St', named: undefined }, north(5))).toBeNull();
    expect(nudgedPlace(null, north(5))).toBeNull();
  });

  it('is no longer at a stop it was at', () => {
    const station = { ...HOME, name: 'My station', stopId: 'ct:pa' };
    expect(nudgedPlace(station, north(10))).toEqual({
      ...north(10),
      name: 'My station',
      named: true,
    });
  });
});
