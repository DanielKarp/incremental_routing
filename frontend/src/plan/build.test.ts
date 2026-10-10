import { describe, expect, it } from 'vitest';
import type { RouteResult, TripDetail, TripStop } from '../api';
import { boardingLegs, estimatedRoute, needsConnector, transitLeg } from './build';
import { appendLeg } from './plan';
import type { Waypoint } from './types';

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

const atAlpha: Waypoint = { place: { lat: 37.4, lon: -122.1 }, time: '2026-10-12T14:50:00.000Z' };
// ~330 m south of Alpha.
const nearAlpha: Waypoint = { place: { lat: 37.397, lon: -122.1 }, time: atAlpha.time };

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

describe('boardingLegs (decision 1: leave immediately)', () => {
  it('boards directly when already at the stop', () => {
    const result = boardingLegs(atAlpha, trip, 1, 2, null);
    expect(result.ok && result.legs.map((l) => l.mode)).toEqual(['transit']);
  });

  it('walks to the stop straight away and waits there', () => {
    expect(needsConnector(nearAlpha.place, { lat: 37.4, lon: -122.1 })).toBe(true);
    const result = boardingLegs(nearAlpha, trip, 1, 3, walkOf(300));
    if (!result.ok) throw new Error(result.reason);
    const [walk, ride] = result.legs;
    expect(walk.start).toEqual(nearAlpha);
    expect(walk.end.time).toBe('2026-10-12T14:55:00.000Z');

    const plan = result.legs.reduce(appendLeg, { anchor: nearAlpha, legs: [] });
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

describe('estimatedRoute', () => {
  it('uses straight-line distance with a detour factor', () => {
    const route = estimatedRoute('walk', nearAlpha.place, atAlpha.place);
    expect(route.provider).toBe('estimate');
    expect(route.distance_m).toBeCloseTo(333.6 * 1.3, 0);
    expect(route.duration_s).toBeCloseTo(route.distance_m / 1.3, 5);
  });
});
