import { describe, expect, it } from 'vitest';
import {
  addedText,
  legNotes,
  legTitle,
  parsePlanJson,
  planFileName,
  planToCsv,
  planToIcs,
  planToJson,
} from './files';
import { appendLegs } from './plan';
import type { Leg, Place, Plan } from './types';

const HOME: Place = { lat: 37.44528, lon: -122.16167, name: 'Home, sweet "home"' };
const PA: Place = { lat: 37.4432, lon: -122.1649, name: 'Palo Alto Caltrain', stopId: 'caltrain:pa' };
const MB: Place = { lat: 37.6, lon: -122.3866, name: 'Millbrae Caltrain', stopId: 'caltrain:mb' };

// 14:30Z is 07:30 in the Bay Area (PDT).
const t = (hhmm: string) => `2026-10-12T${hhmm}:00.000Z`;

const walk: Leg = {
  id: 'walk-1',
  mode: 'walk',
  fixed: 'start',
  start: { place: HOME, time: t('14:30') },
  end: { place: PA, time: t('14:35') },
  path: { provider: 'estimate', distanceM: 420, routedDurationS: 300, geometry: [[-122.16, 37.44]] },
};
const train: Leg = {
  id: 'train-1',
  mode: 'transit',
  start: { place: PA, time: t('14:43') },
  end: { place: MB, time: t('15:04') },
  transit: {
    tripId: 'caltrain:101',
    serviceDate: '2026-10-12',
    routeName: 'Express',
    headsign: 'San Francisco',
    color: 'E31837',
    textColor: 'FFFFFF',
    bikesAllowed: true,
    agency: 'Caltrain',
    stops: [
      { stopId: 'caltrain:pa', name: 'Palo Alto Caltrain', lat: 37.4432, lon: -122.1649, time: t('14:43') },
      { stopId: 'caltrain:mb', name: 'Millbrae Caltrain', lat: 37.6, lon: -122.3866, time: t('15:04') },
    ],
  },
};
const plan: Plan = appendLegs({ anchor: walk.start, legs: [] }, [walk, train]);

describe('JSON plan files', () => {
  it('round-trips, rebuilding the derived waits', () => {
    const parsed = parsePlanJson(planToJson(plan));
    expect(parsed).toEqual({ ok: true, plan });
    expect(plan.legs.map((l) => l.mode)).toEqual(['walk', 'wait', 'transit']);
  });

  it('ignores waits stored in the file and recomputes them', () => {
    const tampered = { ...plan, legs: plan.legs.filter((l) => !l.auto) };
    const parsed = parsePlanJson(planToJson(tampered));
    expect(parsed.ok && parsed.plan.legs.map((l) => l.mode)).toEqual(['walk', 'wait', 'transit']);
  });

  it('rejects files that are not plans', () => {
    expect(parsePlanJson('not json')).toEqual({ ok: false, reason: 'That file is not JSON.' });
    expect(parsePlanJson('{"hello": 1}').ok).toBe(false);
    const future = JSON.stringify({ format: 'incremental-routing-plan', version: 99, plan });
    expect(parsePlanJson(future)).toEqual({ ok: false, reason: 'Unsupported plan file version: 99.' });
  });

  it('explains what is damaged', () => {
    const damage = (legs: unknown[]) =>
      parsePlanJson(JSON.stringify({ format: 'incremental-routing-plan', version: 1, plan: { ...plan, legs } }));
    expect(damage([{ ...walk, end: { ...walk.end, time: 'soon' } }])).toEqual({
      ok: false,
      reason: 'The plan is damaged: leg 1: a time is not a valid date.',
    });
    expect(damage([{ ...walk, mode: 'teleport' }]).ok).toBe(false);
    expect(damage([{ ...train, transit: { ...train.transit, stops: 'none' } }]).ok).toBe(false);
    expect(damage([walk, walk])).toEqual({
      ok: false,
      reason: 'The plan is damaged: two legs share an id.',
    });
  });
});

describe('saying what was just added', () => {
  it('names the ride, which the walk to its stop comes with', () => {
    expect(addedText([walk, train])).toBe(
      'Express, Palo Alto Caltrain 7:43 AM → Millbrae Caltrain 8:04 AM',
    );
  });

  it('or the walk, bike ride or wait on its own', () => {
    expect(addedText([walk])).toBe('Walk, Home, sweet "home" 7:30 AM → Palo Alto Caltrain 7:35 AM');
    const end = { ...train.end, time: t('15:19') };
    const wait: Leg = { id: 'wait-1', mode: 'wait', start: train.end, end };
    expect(addedText([wait])).toBe('Wait 15 min at Millbrae Caltrain, 8:04 AM → 8:19 AM');
  });
});

describe('hilly bike rides', () => {
  const bike: Leg = {
    ...walk,
    id: 'bike-1',
    mode: 'bike',
    path: { ...walk.path!, provider: 'valhalla', elevation: { intervalM: 30, heightsM: [4, 30, 60, 106] } },
  };
  const file = (legs: unknown[]) =>
    JSON.stringify({ format: 'incremental-routing-plan', version: 1, plan: { anchor: bike.start, legs } });

  it('mention the climb in their notes; walks do not', () => {
    expect(legNotes(bike)).toContain('climbs 102 m');
    expect(legNotes({ ...bike, mode: 'walk' })).not.toContain('climbs 102 m');
  });

  it('keep their heights in a saved plan, and damaged heights are refused', () => {
    const hilly = appendLegs({ anchor: bike.start, legs: [] }, [bike]);
    expect(parsePlanJson(planToJson(hilly))).toEqual({ ok: true, plan: hilly });
    const damaged = (elevation: unknown) => ({ ...bike, path: { ...bike.path, elevation } });
    expect(parsePlanJson(file([damaged({ intervalM: 0, heightsM: [1, 2] })])).ok).toBe(false);
    expect(parsePlanJson(file([damaged({ intervalM: 30, heightsM: ['high', 2] })])).ok).toBe(false);
  });
});

describe('CSV export', () => {
  const csv = planToCsv(plan);
  const lines = csv.replace('﻿', '').trimEnd().split('\r\n');

  it('starts with a byte-order mark for Excel and uses CRLF rows', () => {
    expect(csv.startsWith('﻿')).toBe(true);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe(
      'leg,mode,from,depart,to,arrive,duration_min,agency,route,headsign,notes,from_lat,from_lon,to_lat,to_lon',
    );
  });

  it('lists every leg in local time, quoting text that needs it', () => {
    expect(lines[1]).toBe(
      '1,Walk,"Home, sweet ""home""",2026-10-12 07:30,Palo Alto Caltrain,2026-10-12 07:35,5.0,,,,' +
        '0.4 km; estimated,37.445280,-122.161670,37.443200,-122.164900',
    );
    expect(lines[2]).toMatch(/^2,Wait,Palo Alto Caltrain,2026-10-12 07:35,Palo Alto Caltrain,2026-10-12 07:43,8\.0,/);
    expect(lines[3]).toMatch(/^3,Transit,.*,Caltrain,Express,San Francisco,1 stop,/);
  });

  it('defuses names that a spreadsheet would run as formulas', () => {
    const evil = appendLegs({ anchor: walk.start, legs: [] }, [
      { ...walk, end: { ...walk.end, place: { ...PA, name: '=HYPERLINK("x")' } } },
    ]);
    expect(planToCsv(evil)).toContain(`"'=HYPERLINK(""x"")"`);
  });
});

describe('iCalendar export', () => {
  const ics = planToIcs(plan, new Date('2026-10-10T12:00:00Z'));
  const lines = ics.trimEnd().split('\r\n');

  it('has one event per leg you chose, in UTC', () => {
    expect(lines[0]).toBe('BEGIN:VCALENDAR');
    expect(lines.at(-1)).toBe('END:VCALENDAR');
    expect(lines.filter((l) => l === 'BEGIN:VEVENT')).toHaveLength(2);
    expect(lines).toContain('DTSTART:20261012T144300Z');
    expect(lines).toContain('DTEND:20261012T150400Z');
    expect(lines).toContain('UID:train-1@incremental-routing');
    expect(lines).toContain('DTSTAMP:20261010T120000Z');
    expect(lines).toContain('SUMMARY:Express to San Francisco');
  });

  it('escapes commas and quotes text per RFC 5545', () => {
    expect(lines).toContain('LOCATION:Home\\, sweet "home"');
  });

  it('folds long lines at 75 octets, even with multi-byte characters', () => {
    const long: Leg = { ...walk, end: { ...walk.end, place: { ...PA, name: 'Café '.repeat(30) } } };
    const folded = planToIcs(appendLegs({ anchor: walk.start, legs: [] }, [long])).split('\r\n');
    const encoder = new TextEncoder();
    expect(folded.every((l) => encoder.encode(l).length <= 75)).toBe(true);
    expect(folded.some((l) => l.startsWith(' '))).toBe(true);
    // Unfolding (drop each CRLF + space) gives back the original line.
    const start = folded.findIndex((l) => l.startsWith('SUMMARY:'));
    let summary = folded[start];
    for (const line of folded.slice(start + 1)) {
      if (!line.startsWith(' ')) break;
      summary += line.slice(1);
    }
    expect(summary).toBe(`SUMMARY:${legTitle(long)}`);
  });
});

it('names files after the trip date', () => {
  expect(planFileName(plan, 'csv')).toBe('trip-2026-10-12.csv');
});
