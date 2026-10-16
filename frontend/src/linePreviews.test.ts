import { describe, expect, it } from 'vitest';
import type { TransitCall } from './api';
import { groupCalls } from './callGroups';
import { choicesText, inListOrder, lineCall, linePreviews, previewText } from './linePreviews';

function call(trip: string, time: string): TransitCall {
  const iso = `2026-10-12T${time}:00-07:00`;
  return {
    trip_id: trip,
    route: { route_id: 'muni:N', short_name: 'N', long_name: null, color: '005B95' },
    headsign: 'Ocean Beach',
    stop: { stop_id: 'muni:powell', name: 'Powell', lat: 37.78, lon: -122.41, access_s: 120 },
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
    expect(linePreviews(groups, 'departures', [], 'walk')).toEqual([
      {
        key: groups[0].key,
        color: '005B95',
        label: 'N Ocean Beach',
        line: null,
        stop: { lat: 37.78, lon: -122.41, name: 'Powell' },
        time: '2026-10-12T08:02:00-07:00',
        accessS: 120,
        access: 'walk',
        note: null,
      },
    ]);
    const path: [number, number][] = [
      [-122.41, 37.78],
      [-122.5, 37.76],
    ];
    const [drawn] = linePreviews(
      groups,
      'departures',
      [
        { trip_id: 'n2', stop_sequence: 4, geometry: [[0, 0]] }, // another trip of the line
        { trip_id: 'n1', stop_sequence: 4, geometry: path },
      ],
      'walk',
    );
    expect(drawn.line).toEqual(path);
  });

  it('are named with the time a click takes, the stop and the way there', () => {
    const groups = groupCalls(calls, 'arrivals');
    const warning = { level: 'warning' as const, text: '2 min to change' };
    const [back] = linePreviews(groups, 'arrivals', [], 'bike', (c) =>
      c.trip_id === 'n3' ? warning : null,
    );
    // Planning backwards, the last arrival, and the note about changing to or from it.
    expect(previewText(back)).toBe('8:24 AM · N Ocean Beach · Powell, 2 min by bike');
    expect(back.note).toBe(warning);
  });

  it('are offered in the order of the list', () => {
    const at = (route: string, time: string) => ({
      ...call(route, time),
      route: { ...call(route, time).route, route_id: route },
    });
    const groups = groupCalls([at('a', '08:01'), at('b', '08:03'), at('c', '08:07')], 'departures');
    const previews = linePreviews(groups, 'departures', [], 'walk');
    const [a, b, c] = previews.map((p) => p.key);
    expect(inListOrder([c, 'gone', a], previews).map((p) => p.key)).toEqual([a, c]);
    expect(inListOrder([b], previews).map((p) => p.key)).toEqual([b]);
  });

  it('tell when a menu of some of them is out of date, but not when their paths arrive', () => {
    const at = (route: string, time: string) => ({
      ...call(route, time),
      route: { ...call(route, time).route, route_id: route },
    });
    const groups = groupCalls([at('a', '08:01'), at('b', '08:03')], 'departures');
    const previews = linePreviews(groups, 'departures', [], 'walk');
    const keys = previews.map((p) => p.key);
    const shown = choicesText(keys, previews);
    const path = { trip_id: 'a', stop_sequence: 4, geometry: [[0, 0]] as [number, number][] };
    expect(choicesText(keys, linePreviews(groups, 'departures', [path], 'walk'))).toBe(shown);
    // Filtered out, found again for a later time, or reached by bike.
    expect(choicesText(keys, previews.slice(1))).not.toBe(shown);
    const later = groupCalls([at('a', '08:11'), at('b', '08:03')], 'departures');
    expect(choicesText(keys, linePreviews(later, 'departures', [], 'walk'))).not.toBe(shown);
    expect(choicesText(keys, linePreviews(groups, 'departures', [], 'bike'))).not.toBe(shown);
  });
});
