import { describe, expect, it } from 'vitest';
import {
  appendLeg,
  findIssues,
  maxDurationS,
  planEnd,
  planStart,
  prependLeg,
  removeLeg,
  setLegDuration,
} from './plan';
import type { Leg, Place, Plan } from './types';

const HOME: Place = { lat: 37.4, lon: -122.1, name: 'Home' };
const STATION: Place = { lat: 37.41, lon: -122.1, name: 'Station', stopId: 'caltrain:1' };
const CITY: Place = { lat: 37.77, lon: -122.39, name: 'City', stopId: 'caltrain:2' };
const OFFICE: Place = { lat: 37.78, lon: -122.4, name: 'Office' };

const t = (hhmm: string) => `2026-10-12T${hhmm}:00.000Z`;

function leg(id: string, mode: Leg['mode'], from: Place, start: string, to: Place, end: string): Leg {
  return { id, mode, start: { place: from, time: t(start) }, end: { place: to, time: t(end) } };
}

const emptyPlan: Plan = { anchor: { place: HOME, time: t('07:40') }, legs: [] };
const bike = leg('bike', 'bike', HOME, '07:40', STATION, '07:50');
const train = leg('train', 'transit', STATION, '08:00', CITY, '08:45');
const walk = leg('walk', 'walk', CITY, '08:45', OFFICE, '08:55');
const commute = [bike, train, walk].reduce(appendLeg, emptyPlan);

function edited(result: ReturnType<typeof setLegDuration>): Plan {
  if (!result.ok) throw new Error(result.reason);
  return result.plan;
}

describe('building a plan', () => {
  it('starts at the anchor', () => {
    expect(planStart(emptyPlan)).toEqual(emptyPlan.anchor);
    expect(planEnd(emptyPlan)).toEqual(emptyPlan.anchor);
  });

  it('inserts a wait between legs that do not meet in time', () => {
    const plan = appendLeg(appendLeg(emptyPlan, bike), train);
    expect(plan.legs.map((l) => l.mode)).toEqual(['bike', 'wait', 'transit']);
    const wait = plan.legs[1];
    expect(wait.auto).toBe(true);
    expect(wait.start).toEqual(bike.end);
    expect(wait.end).toEqual({ place: STATION, time: t('08:00') });
  });

  it('adds no wait when legs meet exactly', () => {
    const plan = appendLeg(appendLeg(emptyPlan, train), walk);
    expect(plan.legs.map((l) => l.id)).toEqual(['train', 'walk']);
  });

  it('extends backwards as well as forwards', () => {
    const plan = prependLeg(appendLeg(emptyPlan, train), bike);
    expect(plan.legs.map((l) => l.mode)).toEqual(['bike', 'wait', 'transit']);
    expect(planStart(plan).time).toBe(t('07:40'));
    expect(planEnd(plan).time).toBe(t('08:45'));
  });

  it('rebuilds waits when a leg is removed', () => {
    const plan = removeLeg(appendLeg(appendLeg(emptyPlan, bike), train), 'bike');
    expect(plan.legs.map((l) => l.id)).toEqual(['train']);
  });
});

describe('duration edits (decision 2: never into a neighbour)', () => {
  it('lengthens into the wait, keeping the start fixed', () => {
    const plan = edited(setLegDuration(commute, 'bike', 15 * 60, 'start'));
    expect(plan.legs[0].end.time).toBe(t('07:55'));
    expect(plan.legs[1]).toMatchObject({ mode: 'wait', end: { time: t('08:00') } });
    expect(findIssues(plan)).toEqual([]);
  });

  it('may lengthen right up to the next leg, removing the wait', () => {
    const plan = edited(setLegDuration(commute, 'bike', 20 * 60, 'start'));
    expect(plan.legs.map((l) => l.mode)).toEqual(['bike', 'transit', 'walk']);
  });

  it('refuses to lengthen a leg into the next one', () => {
    expect(maxDurationS(commute, 'bike', 'start')).toBe(20 * 60);
    expect(setLegDuration(commute, 'bike', 25 * 60, 'start')).toEqual({
      ok: false,
      reason: 'At most 20 min. Any longer runs into the next leg.',
    });
  });

  it('refuses to lengthen backwards into the previous leg', () => {
    expect(maxDurationS(commute, 'walk', 'end')).toBe(10 * 60);
    const result = setLegDuration(commute, 'walk', 20 * 60, 'end');
    expect(result.ok).toBe(false);
  });

  it('lets legs at the open ends of the plan grow freely', () => {
    expect(maxDurationS(commute, 'walk', 'start')).toBeNull();
    expect(maxDurationS(commute, 'bike', 'end')).toBeNull();
    const plan = edited(setLegDuration(commute, 'walk', 60 * 60, 'start'));
    expect(planEnd(plan).time).toBe(t('09:45'));
  });

  it('always allows shortening, which opens a wait', () => {
    const plan = edited(setLegDuration(commute, 'bike', 5 * 60, 'start'));
    expect(plan.legs[1]).toMatchObject({ mode: 'wait', start: { time: t('07:45') } });
  });

  it('never edits transit legs', () => {
    expect(setLegDuration(commute, 'train', 30 * 60, 'start').ok).toBe(false);
  });
});

describe('findIssues', () => {
  it('flags legs that do not connect in space', () => {
    const plan = appendLeg(appendLeg(emptyPlan, bike), walk);
    expect(findIssues(plan).map((i) => i.kind)).toEqual(['location-gap']);
  });

  it('warns, without erroring, when a trip does not allow bikes', () => {
    const noBikes: Leg = {
      ...train,
      transit: {
        tripId: 'vta:1',
        serviceDate: '2026-10-12',
        routeName: '22',
        headsign: null,
        color: null,
        textColor: null,
        bikesAllowed: false,
        stops: [],
      },
    };
    const plan = appendLeg(appendLeg(emptyPlan, bike), noBikes);
    expect(findIssues(plan)).toEqual([
      expect.objectContaining({ kind: 'bikes-not-allowed', severity: 'warning', legId: 'train' }),
    ]);
  });
});
