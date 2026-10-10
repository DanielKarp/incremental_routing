import { describe, expect, it } from 'vitest';
import type { TransitCall } from './api';
import { groupCalls } from './callGroups';

function call(trip: string, route: string, headsign: string, stop: string, time: string) {
  const iso = `2026-10-12T${time}:00-07:00`;
  return {
    trip_id: trip,
    route: { route_id: route },
    headsign,
    stop: { stop_id: stop },
    departure: iso,
    arrival: iso,
  } as TransitCall;
}

const trips = (groups: ReturnType<typeof groupCalls>) =>
  groups.map((g) => g.calls.map((c) => c.trip_id));

describe('grouping calls into lines', () => {
  it('keeps departures in the order each line next leaves', () => {
    // As the API sends them: soonest first.
    const calls = [
      call('5a', 'muni:5', 'Transit Center', 'market', '08:02'),
      call('ja', 'muni:J', 'Balboa Park', 'metro', '08:03'),
      call('5b', 'muni:5', 'Transit Center', 'market', '08:10'),
      call('ya', 'bart:Y', 'SFO', 'powell', '08:12'),
      call('jb', 'muni:J', 'Balboa Park', 'metro', '08:15'),
    ];
    expect(trips(groupCalls(calls, 'departures'))).toEqual([['5a', '5b'], ['ja', 'jb'], ['ya']]);
  });

  it('puts the latest arrivals first when planning backwards, each line in time order', () => {
    // As the API sends them: latest first.
    const calls = [
      call('jb', 'muni:J', 'Embarcadero', 'metro', '08:15'),
      call('5b', 'muni:5', 'Salesforce', 'market', '08:10'),
      call('ja', 'muni:J', 'Embarcadero', 'metro', '08:03'),
      call('5a', 'muni:5', 'Salesforce', 'market', '08:02'),
    ];
    expect(trips(groupCalls(calls, 'arrivals'))).toEqual([['ja', 'jb'], ['5a', '5b']]);
  });

  it('separates directions (headsigns) and stops of the same route', () => {
    const calls = [
      call('out', 'muni:5', 'Transit Center', 'market-south', '08:02'),
      call('in', 'muni:5', 'Fulton & La Playa', 'market-north', '08:04'),
      call('other-stop', 'muni:5', 'Transit Center', 'mission', '08:06'),
    ];
    expect(groupCalls(calls, 'departures')).toHaveLength(3);
  });
});
