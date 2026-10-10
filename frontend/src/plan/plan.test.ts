import { describe, expect, it } from 'vitest';
import {
  appendLeg,
  findIssues,
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

describe('manual duration overrides', () => {
  it('keeps the start fixed for forward-planned legs and regrows the wait', () => {
    let plan = appendLeg(appendLeg(emptyPlan, bike), train);
    plan = setLegDuration(plan, 'bike', 15 * 60, 'start');
    expect(plan.legs[0].end.time).toBe(t('07:55'));
    expect(plan.legs[1].end.time).toBe(t('08:00'));
    expect(findIssues(plan)).toEqual([]);
  });

  it('flags a missed connection instead of moving the train', () => {
    let plan = appendLeg(appendLeg(emptyPlan, bike), train);
    plan = setLegDuration(plan, 'bike', 25 * 60, 'start');
    expect(plan.legs.map((l) => l.mode)).toEqual(['bike', 'transit']);
    expect(findIssues(plan)).toEqual([
      { kind: 'overlap', legId: 'train', message: 'Starts 5 min before the previous leg ends' },
    ]);
  });

  it('keeps the end fixed for backward-planned legs', () => {
    const plan = setLegDuration(appendLeg(emptyPlan, walk), 'walk', 20 * 60, 'end');
    expect(plan.legs[0].start.time).toBe(t('08:35'));
    expect(plan.legs[0].end.time).toBe(t('08:55'));
  });
});

describe('findIssues', () => {
  it('flags legs that do not connect in space', () => {
    const plan = appendLeg(appendLeg(emptyPlan, bike), walk);
    expect(findIssues(plan).map((i) => i.kind)).toEqual(['location-gap']);
  });
});
