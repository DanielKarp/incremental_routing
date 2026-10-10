import { describe, expect, it } from 'vitest';
import type { TransitCall, TransferRule } from '../api';
import { appendLegs } from './plan';
import { adjacentRide, transferContext, transferNote } from './transfers';
import type { Leg } from './types';

const DELTA = { lat: 37.43, lon: -122.1, name: 'Delta', stopId: 'tr:DELTA_1' };
const ride: Leg = {
  id: 'ride',
  mode: 'transit',
  start: { place: { lat: 37.4, lon: -122.1, name: 'Alpha', stopId: 'tr:ALPHA' }, time: '2026-10-12T15:00:00.000Z' },
  end: { place: DELTA, time: '2026-10-12T15:20:00.000Z' },
  transit: {
    tripId: 'tr:T_MORNING',
    serviceDate: '2026-10-12',
    routeName: 'L1',
    headsign: 'Delta',
    color: null,
    textColor: null,
    bikesAllowed: true,
    stops: [],
  },
};
const plan = appendLegs({ anchor: ride.start, legs: [] }, [ride]);

function call(departure: string, arrival: string, transfer: TransferRule | null): TransitCall {
  return { departure, arrival, transfer } as TransitCall;
}

describe('transfer notes', () => {
  it('finds the ride at the end being extended', () => {
    expect(adjacentRide(plan, 'forward')?.id).toBe('ride');
    expect(transferContext(ride, 'forward')).toEqual({ stopId: 'tr:DELTA_1', tripId: 'tr:T_MORNING' });
    expect(transferContext(ride, 'backward')).toEqual({ stopId: 'tr:ALPHA', tripId: 'tr:T_MORNING' });
    const walked = appendLegs(plan, [{ ...ride, id: 'walk', mode: 'walk', transit: undefined }]);
    expect(adjacentRide(walked, 'forward')).toBeNull();
  });

  it('warns when the connection is shorter than the agency allows', () => {
    const tight = call('2026-10-12T15:23:00.000Z', '', { type: 2, min_transfer_s: 300 });
    expect(transferNote(tight, ride, 'forward')).toEqual({
      level: 'warning',
      text: '3 min to change; the agency allows at least 5 min',
    });
    const roomy = call('2026-10-12T15:30:00.000Z', '', { type: 2, min_transfer_s: 300 });
    expect(transferNote(roomy, ride, 'forward')).toBeNull();
  });

  it('warns about transfers the agency rules out, and notes timed ones', () => {
    expect(transferNote(call('2026-10-12T15:40:00.000Z', '', { type: 3, min_transfer_s: null }), ride, 'forward')?.level).toBe('warning');
    expect(transferNote(call('2026-10-12T15:22:00.000Z', '', { type: 1, min_transfer_s: null }), ride, 'forward')).toEqual({
      level: 'info',
      text: 'Timed transfer: the connection is held',
    });
    expect(transferNote(call('2026-10-12T15:22:00.000Z', '', null), ride, 'forward')).toBeNull();
  });

  it('measures the connection the other way when planning backwards', () => {
    // Arriving 14:58 to board at 15:00: 2 minutes.
    const earlier = call('', '2026-10-12T14:58:00.000Z', { type: 2, min_transfer_s: 180 });
    expect(transferNote(earlier, ride, 'backward')?.text).toBe(
      '2 min to change; the agency allows at least 3 min',
    );
  });
});
