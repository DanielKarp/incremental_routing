import { describe, expect, it } from 'vitest';
import type { TransitCall } from './api';
import { groupCalls } from './callGroups';
import { filterLines, isFiltering, startsWord } from './lineFilter';

function line(
  short: string,
  headsign: string,
  stop: string,
  agency: string,
  routeType = 3,
  long: string | null = null,
) {
  return {
    trip_id: `${short}-${headsign}`,
    route: { route_id: short, short_name: short, long_name: long, route_type: routeType, agency },
    headsign,
    stop: { stop_id: stop, name: stop },
    departure: '2026-10-20T09:00:00-07:00',
    arrival: '2026-10-20T09:00:00-07:00',
  } as TransitCall;
}

const MUNI = 'San Francisco Municipal Transportation Agency';
// Some of the lines at Embarcadero.
const lines = groupCalls(
  [
    line('Red-S', 'Millbrae', 'Embarcadero', 'Bay Area Rapid Transit', 1),
    line('38R', '48th Avenue', 'Beale St & Mission St', MUNI),
    line('N', 'Ocean Beach', 'Embarcadero Station Outbound', MUNI, 0),
    line('1', 'Geary Blvd & 33rd Ave', 'Sacramento St & Davis St', MUNI),
    line('10', 'Townsend', 'Bartlett St & 22nd St', MUNI),
    line('NL', 'Richmond', 'Salesforce Transit Center', 'AC TRANSIT'),
    line('101', 'Santa Rosa', 'Salesforce Transit Center', 'Golden Gate Transit'),
    line('LSSF', 'Larkspur', 'San Francisco Ferry Building', 'Golden Gate Ferry', 4),
    line('PM', 'Bay & Taylor', 'Powell St & Market St', MUNI, 5, 'Powell/Mason'),
    line('Local Weekday', 'San Jose Diridon', 'San Francisco Caltrain', 'Caltrain', 2),
    line('292', 'San Mateo', 'San Francisco Caltrain', 'SamTrans'),
  ],
  'departures',
);

const shown = (query: string) => filterLines(lines, query).map((g) => g.calls[0].route.short_name);

describe('filtering the list of lines', () => {
  it('keeps every line, as they were, while nothing is typed', () => {
    expect(filterLines(lines, '')).toBe(lines);
    expect(filterLines(lines, '  , ')).toBe(lines);
    expect(isFiltering(' ')).toBe(false);
    expect(isFiltering('bart')).toBe(true);
  });

  it('finds lines by route name, headsign or stop, ignoring case', () => {
    expect(shown('38r')).toEqual(['38R']);
    expect(shown('OCEAN')).toEqual(['N']);
    expect(shown('mission')).toEqual(['38R']);
    expect(shown('powell/mason')).toEqual(['PM']);
  });

  it('matches the start of words only', () => {
    expect(shown('embarc')).toEqual(['Red-S', 'N']);
    expect(shown('arcadero')).toEqual([]);
  });

  it('takes numbers whole', () => {
    expect(shown('1')).toEqual(['1']);
    expect(shown('10')).toEqual(['10']);
    expect(shown('22')).toEqual(['10']); // At Bartlett St & 22nd St.
  });

  it('finds operators by name, initials or a name people use', () => {
    expect(shown('bart')).toEqual(['Red-S']); // Not Bartlett St.
    expect(shown('muni')).toEqual(['38R', 'N', '1', '10', 'PM']);
    expect(shown('sfmta')).toEqual(['38R', 'N', '1', '10', 'PM']);
    expect(shown('ac')).toEqual(['NL']);
    expect(shown('gg')).toEqual(['101', 'LSSF']);
    expect(shown('golden gate')).toEqual(['101', 'LSSF']);
    expect(shown('samtrans')).toEqual(['292']);
  });

  it('picks only an operator named by a word people use for it', () => {
    // Not SamTrans, though it stops at the Caltrain station.
    expect(shown('caltrain')).toEqual(['Local Weekday']);
    // Typed in part, it's just words: the station counts.
    expect(shown('caltr')).toEqual(['Local Weekday', '292']);
  });

  it('finds kinds of vehicle', () => {
    expect(shown('ferry')).toEqual(['LSSF']);
    expect(shown('train')).toEqual(['Red-S', 'Local Weekday']);
    expect(shown('cable car')).toEqual(['PM']);
    expect(shown('tram')).toEqual(['N']);
  });

  it('needs every word, and any of the parts between commas', () => {
    expect(shown('muni ocean')).toEqual(['N']);
    expect(shown('bart, caltrain')).toEqual(['Red-S', 'Local Weekday']);
    expect(shown('bart,')).toEqual(['Red-S']);
    expect(shown('bart ferry')).toEqual([]);
  });
});

describe('the start of a word', () => {
  it('is any start, but a number is taken whole', () => {
    expect(startsWord('embarcadero', 'emb')).toBe(true);
    expect(startsWord('38r', '38')).toBe(true);
    expect(startsWord('22nd', '22')).toBe(true);
    expect(startsWord('101', '10')).toBe(false);
    expect(startsWord('1x', '1')).toBe(true);
  });
});
