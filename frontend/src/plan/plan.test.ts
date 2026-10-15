import { describe, expect, it } from 'vitest';
import {
  appendLeg,
  appendLegs,
  findIssues,
  isEndLeg,
  maxDurationS,
  planEnd,
  planStart,
  prependLeg,
  prependLegs,
  removeFrom,
  removeLeg,
  removedWith,
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
const commute = appendLegs(emptyPlan, [bike, train, walk]);
// The same trip, planned backwards from the office: walk and bike keep their end fixed. The
// walk starts two minutes after the train arrives, so its start isn't locked to the train.
const commuteBackwards = appendLegs(emptyPlan, [
  { ...bike, fixed: 'end' },
  train,
  { ...walk, fixed: 'end', start: { ...walk.start, time: t('08:47') } },
]);

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

  it('adds several legs in travel order at either end', () => {
    const plan = prependLegs(appendLegs(emptyPlan, [walk]), [bike, train]);
    expect(plan.legs.map((l) => l.id)).toEqual(['bike', 'wait-after-bike', 'train', 'walk']);
  });

  it('only lets the legs at either end be removed', () => {
    expect([bike, train, walk].map((l) => isEndLeg(commute, l.id))).toEqual([true, false, true]);
    expect(isEndLeg(commute, 'wait-after-bike')).toBe(false);
  });

  it('rebuilds waits when a leg is removed', () => {
    const plan = removeLeg(commute, 'bike');
    expect(plan.legs.map((l) => l.id)).toEqual(['train', 'walk']);
  });
});

describe('removing legs', () => {
  // Home -> Station by bike, a coffee at the station, then the train and a walk.
  const coffee: Leg = {
    ...leg('coffee', 'wait', STATION, '07:50', STATION, '07:55'),
    fixed: 'start',
  };
  const withCoffee = appendLegs(emptyPlan, [bike, coffee, train, walk]);
  const ids = (legs: Leg[]) => legs.map((l) => l.id);

  it('removes a leg at either end of the plan alone', () => {
    expect(removedWith(commute, 'walk', 'forward')).toEqual([]);
    expect(removedWith(commute, 'bike', 'forward')).toEqual([]);
    expect(ids(removeFrom(commute, 'walk', 'forward').legs)).toEqual([
      'bike',
      'wait-after-bike',
      'train',
    ]);
    expect(ids(removeFrom(commute, 'bike', 'backward').legs)).toEqual(['train', 'walk']);
  });

  it('removes a wait you added alone, wherever it is, and fills the time it leaves', () => {
    expect(ids(withCoffee.legs)).toEqual(['bike', 'coffee', 'wait-after-coffee', 'train', 'walk']);
    expect(removedWith(withCoffee, 'coffee', 'forward')).toEqual([]);
    expect(removedWith(withCoffee, 'coffee', 'backward')).toEqual([]);
    const plan = removeFrom(withCoffee, 'coffee', 'forward');
    expect(ids(plan.legs)).toEqual(['bike', 'wait-after-bike', 'train', 'walk']);
    expect(plan.legs[1]).toMatchObject({ auto: true, start: bike.end, end: train.start });
    expect(findIssues(plan)).toEqual([]);
  });

  it('takes the legs after a leg in the middle when planning forwards', () => {
    expect(ids(removedWith(withCoffee, 'train', 'forward'))).toEqual(['walk']);
    expect(ids(removeFrom(withCoffee, 'train', 'forward').legs)).toEqual(['bike', 'coffee']);
  });

  it('takes the legs before a leg in the middle when planning backwards', () => {
    // Every row above it goes, the automatic wait included.
    expect(ids(removedWith(withCoffee, 'train', 'backward'))).toEqual([
      'bike',
      'coffee',
      'wait-after-coffee',
    ]);
    expect(ids(removeFrom(withCoffee, 'train', 'backward').legs)).toEqual(['walk']);
  });

  it('never removes automatic waits', () => {
    expect(removedWith(withCoffee, 'wait-after-coffee', 'forward')).toEqual([]);
    expect(isEndLeg(withCoffee, 'wait-after-coffee')).toBe(false);
  });

  it('removes a wait whose ends are apart as any other leg in the middle', () => {
    const moved: Leg = { ...coffee, end: { place: CITY, time: coffee.end.time } };
    const plan = appendLegs(emptyPlan, [bike, moved, train, walk]);
    expect(ids(removedWith(plan, 'coffee', 'forward'))).toEqual([
      'wait-after-coffee',
      'train',
      'walk',
    ]);
  });
});

describe('duration edits (decision 2: never into a neighbour)', () => {
  it('lengthens into the wait, keeping the start fixed by default', () => {
    const plan = edited(setLegDuration(commute, 'bike', 15 * 60));
    expect(plan.legs[0].start.time).toBe(t('07:40'));
    expect(plan.legs[0].end.time).toBe(t('07:55'));
    expect(plan.legs[1]).toMatchObject({ mode: 'wait', end: { time: t('08:00') } });
    expect(findIssues(plan)).toEqual([]);
  });

  it('may lengthen right up to the next leg, removing the wait', () => {
    const plan = edited(setLegDuration(commute, 'bike', 20 * 60));
    expect(plan.legs.map((l) => l.mode)).toEqual(['bike', 'transit', 'walk']);
  });

  it('refuses to lengthen a leg into the next one', () => {
    expect(maxDurationS(commute, 'bike')).toBe(20 * 60);
    expect(setLegDuration(commute, 'bike', 25 * 60)).toEqual({
      ok: false,
      reason: 'At most 20 min. Any longer runs into the next leg.',
    });
  });

  it('moves the start of legs planned backwards, keeping their end', () => {
    const plan = edited(setLegDuration(commuteBackwards, 'bike', 30 * 60));
    expect(plan.legs[0].start.time).toBe(t('07:20'));
    expect(plan.legs[0].end.time).toBe(t('07:50'));
  });

  it('refuses to lengthen a backward leg into the previous one', () => {
    expect(maxDurationS(commuteBackwards, 'walk')).toBe(10 * 60);
    expect(setLegDuration(commuteBackwards, 'walk', 20 * 60)).toEqual({
      ok: false,
      reason: 'At most 10 min. Any longer runs into the previous leg.',
    });
  });

  it('lets legs at the open ends of the plan grow freely', () => {
    expect(maxDurationS(commute, 'walk')).toBeNull();
    expect(maxDurationS(commuteBackwards, 'bike')).toBeNull();
    const plan = edited(setLegDuration(commute, 'walk', 60 * 60));
    expect(planEnd(plan).time).toBe(t('09:45'));
  });

  it('always allows shortening, which opens a wait', () => {
    const plan = edited(setLegDuration(commute, 'bike', 5 * 60));
    expect(plan.legs[1]).toMatchObject({ mode: 'wait', start: { time: t('07:45') } });
  });

  it('never edits transit legs', () => {
    expect(setLegDuration(commute, 'train', 30 * 60).ok).toBe(false);
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
