import { describe, expect, it } from 'vitest';
import {
  appendLegs,
  departureWindow,
  durationAnchor,
  legBounds,
  planPlaces,
  renamePlace,
  setLegDuration,
  setLegEnd,
  setLegPath,
  setLegStart,
} from './plan';
import type { Leg, PathInfo, Place, Plan } from './types';

// Times are Bay Area local (PDT, UTC-7) to match the messages, which show local times.
const t = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(2026, 9, 12, h + 7, m)).toISOString();
};

const HOME: Place = { lat: 37.33, lon: -121.88, name: 'Home' };
const VIENNA: Place = { lat: 37.34, lon: -121.89, name: 'Vienna Station', stopId: 'vta:vienna' };
const MILPITAS: Place = { lat: 37.41, lon: -121.89, name: 'Milpitas Station', stopId: 'vta:mil' };
const CAFE: Place = { lat: 37.42, lon: -121.9, name: 'Cafe' };

function leg(id: string, mode: Leg['mode'], from: Place, start: string, to: Place, end: string, extra: Partial<Leg> = {}): Leg {
  return { id, mode, start: { place: from, time: t(start) }, end: { place: to, time: t(end) }, ...extra };
}

function ok(result: ReturnType<typeof setLegStart>): Plan {
  if (!result.ok) throw new Error(result.reason);
  return result.plan;
}

const times = (plan: Plan, id: string) => {
  const l = plan.legs.find((x) => x.id === id)!;
  return [l.start.time, l.end.time];
};

// The screenshot: walk 8:30-8:47 from home, a 6 min wait, then the Orange Line 8:52-9:17.
const walk = leg('walk', 'walk', HOME, '08:30', VIENNA, '08:47', { fixed: 'start' });
const ride = leg('ride', 'transit', VIENNA, '08:52', MILPITAS, '09:17');
const screenshot = appendLegs({ anchor: walk.start, legs: [] }, [walk, ride]);

describe('editing both ends of a walk or bike leg', () => {
  it('frees an end next to a wait or the open end of the plan', () => {
    expect(legBounds(screenshot, 'walk')).toEqual({
      startFree: true,
      endFree: true,
      earliestStart: null,
      latestEnd: t('08:52'),
    });
    expect(departureWindow(screenshot, 'walk')).toEqual({ earliest: null, latest: t('08:35') });
  });

  it('leaving later shifts the whole leg into the wait', () => {
    const plan = ok(setLegStart(screenshot, 'walk', t('08:35')));
    expect(times(plan, 'walk')).toEqual([t('08:35'), t('08:52')]);
    expect(plan.legs.map((l) => l.mode)).toEqual(['walk', 'transit']);
  });

  it('refuses to leave too late for the train', () => {
    expect(setLegStart(screenshot, 'walk', t('08:36'))).toEqual({
      ok: false,
      reason: expect.stringMatching(/^Leave by 8:35\sAM to make the next leg\.$/),
    });
  });

  it('changing the arrival also shifts the leg', () => {
    const plan = ok(setLegEnd(screenshot, 'walk', t('08:50')));
    expect(times(plan, 'walk')).toEqual([t('08:33'), t('08:50')]);
  });

  it('a duration edit keeps the departure, as planned', () => {
    expect(durationAnchor(screenshot, 'walk')).toBe('start');
    const plan = ok(setLegDuration(screenshot, 'walk', 20 * 60));
    expect(times(plan, 'walk')).toEqual([t('08:30'), t('08:50')]);
  });
});

describe('ends that meet a ride stay put', () => {
  // Off the train at 9:17 and walking straight to the cafe; a wait there from 9:40.
  const fromStation = leg('from', 'walk', MILPITAS, '09:17', CAFE, '09:25', { fixed: 'start' });
  const later = leg('later', 'wait', CAFE, '09:40', CAFE, '10:00', { fixed: 'start' });
  const plan = appendLegs({ anchor: ride.start, legs: [] }, [ride, fromStation, later]);

  it('locks the departure of a walk that starts as the ride arrives', () => {
    expect(legBounds(plan, 'from')).toMatchObject({ startFree: false, endFree: true });
    expect(setLegStart(plan, 'from', t('09:20'))).toEqual({
      ok: false,
      reason: 'It leaves as soon as the ride before it arrives.',
    });
  });

  it('then changes the duration when the free end moves', () => {
    const edited = ok(setLegEnd(plan, 'from', t('09:30')));
    expect(times(edited, 'from')).toEqual([t('09:17'), t('09:30')]);
    expect(setLegEnd(plan, 'from', t('09:45'))).toEqual({
      ok: false,
      reason: expect.stringMatching(/^Arrive by 9:40\sAM: the next leg starts then\.$/),
    });
  });

  it('keeps the arrival of a walk that ends just as a ride leaves', () => {
    const toStation = leg('to', 'walk', HOME, '08:40', VIENNA, '08:52', { fixed: 'start' });
    const tight = appendLegs({ anchor: toStation.start, legs: [] }, [toStation, ride]);
    expect(durationAnchor(tight, 'to')).toBe('end');
    // Leaving later can't move the train: the walk gets shorter instead.
    expect(times(ok(setLegStart(tight, 'to', t('08:45'))), 'to')).toEqual([t('08:45'), t('08:52')]);
    expect(times(ok(setLegDuration(tight, 'to', 20 * 60)), 'to')).toEqual([t('08:32'), t('08:52')]);
  });
});

describe('switching between walking and cycling', () => {
  const route = (minutes: number): PathInfo => ({
    provider: 'test',
    distanceM: 1400,
    routedDurationS: minutes * 60,
    geometry: [],
  });

  it('keeps the departure when the new duration fits', () => {
    const plan = ok(setLegPath(screenshot, 'walk', 'bike', route(6)));
    const bike = plan.legs[0];
    expect(bike.mode).toBe('bike');
    expect([bike.start.time, bike.end.time]).toEqual([t('08:30'), t('08:36')]);
  });

  it('leaves earlier when keeping the departure would miss the next leg', () => {
    const plan = ok(setLegPath(screenshot, 'walk', 'walk', route(25)));
    expect(times(plan, 'walk')).toEqual([t('08:22'), t('08:47')]);
  });

  it('refuses when it fits neither way', () => {
    const between = leg('between', 'walk', MILPITAS, '09:17', CAFE, '09:23', { fixed: 'start' });
    const next = leg('next', 'transit', CAFE, '09:30', HOME, '09:50');
    const plan = appendLegs({ anchor: ride.start, legs: [] }, [ride, between, next]);
    expect(setLegPath(plan, 'between', 'walk', route(15))).toEqual({
      ok: false,
      reason: "Walking takes 15 min, which doesn't fit between the legs around it.",
    });
  });
});

describe('renaming places', () => {
  it('lists each place once, in travel order', () => {
    expect(planPlaces(screenshot).map((p) => p.name)).toEqual([
      'Home',
      'Vienna Station',
      'Milpitas Station',
    ]);
  });

  it('renames a place everywhere it appears, waits included', () => {
    const plan = renamePlace(screenshot, VIENNA, 'Vienna LRT');
    expect(plan.legs.map((l) => [l.start.place.name, l.end.place.name])).toEqual([
      ['Home', 'Vienna LRT'],
      ['Vienna LRT', 'Vienna LRT'],
      ['Vienna LRT', 'Milpitas Station'],
    ]);
    expect(renamePlace(screenshot, HOME, 'My place').anchor.place.name).toBe('My place');
  });
});
