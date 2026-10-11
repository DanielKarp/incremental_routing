import { describe, expect, it } from 'vitest';
import type { TransitCall } from './api';
import { groupCalls } from './callGroups';
import { lineCall, linePreviews } from './linePreviews';

function call(trip: string, time: string): TransitCall {
  const iso = `2026-10-12T${time}:00-07:00`;
  return {
    trip_id: trip,
    route: { route_id: 'muni:N', short_name: 'N', long_name: null, color: '005B95' },
    headsign: 'Ocean Beach',
    stop: { stop_id: 'muni:powell', name: 'Powell', lat: 37.78, lon: -122.41 },
    stop_sequence: 4,
    departure: iso,
    arrival: iso,
  } as TransitCall;
}

describe('line previews', () => {
  const calls = [call('n1', '08:02'), call('n2', '08:12'), call('n3', '08:24')];

  it('stand for the next departure, or the last arrival when planning back', () => {
    expect(lineCall(groupCalls(calls, 'departures')[0], 'departures').trip_id).toBe('n1');
    expect(lineCall(groupCalls(calls, 'arrivals')[0], 'arrivals').trip_id).toBe('n3');
  });

  it('show each line at its stop at once, and its path once it arrives', () => {
    const groups = groupCalls(calls, 'departures');
    expect(linePreviews(groups, 'departures', [])).toEqual([
      {
        key: groups[0].key,
        color: '005B95',
        label: 'N Ocean Beach',
        line: null,
        stop: { lat: 37.78, lon: -122.41, name: 'Powell' },
      },
    ]);
    const path: [number, number][] = [
      [-122.41, 37.78],
      [-122.5, 37.76],
    ];
    const [drawn] = linePreviews(groups, 'departures', [
      { trip_id: 'n2', stop_sequence: 4, geometry: [[0, 0]] }, // another trip of the line
      { trip_id: 'n1', stop_sequence: 4, geometry: path },
    ]);
    expect(drawn.line).toEqual(path);
  });
});
