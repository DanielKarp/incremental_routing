import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, type TransitCall } from './api';
import { findCalls, findPaths } from './transitList';

function call(trip: string, time: string, serviceDate = '2026-10-12'): TransitCall {
  const iso = `2026-10-12T${time}:00-07:00`;
  return {
    trip_id: trip,
    service_date: serviceDate,
    route: { route_id: 'muni:N' },
    headsign: 'Ocean Beach',
    stop: { stop_id: 'muni:powell' },
    stop_sequence: 4,
    departure: iso,
    arrival: iso,
  } as TransitCall;
}

const query = { point: { lat: 37.78, lon: -122.41 }, time: '2026-10-12T15:00:00.000Z' };

afterEach(() => {
  vi.restoreAllMocks();
});

describe('finding the transit list', () => {
  it('lists departures forwards and arrivals backwards, without the trip you are on', async () => {
    const departures = vi
      .spyOn(api, 'departures')
      .mockResolvedValue([
        call('n1', '08:02'),
        call('on', '08:05'),
        call('on', '08:05', '2026-10-13'),
      ]);
    const arrivals = vi.spyOn(api, 'arrivals').mockResolvedValue([call('n0', '07:40')]);

    const skip = { tripId: 'on', serviceDate: '2026-10-12' };
    const found = await findCalls({ direction: 'forward', query, skip });
    expect(found.map((c) => `${c.trip_id} ${c.service_date}`)).toEqual([
      'n1 2026-10-12',
      'on 2026-10-13', // The same trip on another day is a different ride.
    ]);
    expect(departures).toHaveBeenCalledWith(query);

    expect((await findCalls({ direction: 'backward', query })).map((c) => c.trip_id)).toEqual([
      'n0',
    ]);
    expect(arrivals).toHaveBeenCalledOnce();
  });

  it('asks where each line goes from the trip it stands for, and not for no lines', async () => {
    const lines = vi.spyOn(api, 'lines').mockResolvedValue([]);
    // Planning backwards, a line stands for its last arrival.
    await findPaths('backward', [call('early', '08:00'), call('late', '08:30')]);
    expect(lines).toHaveBeenCalledWith('backward', [{ trip_id: 'late', stop_sequence: 4 }]);

    expect(await findPaths('forward', [])).toEqual([]);
    expect(lines).toHaveBeenCalledOnce();
  });
});
