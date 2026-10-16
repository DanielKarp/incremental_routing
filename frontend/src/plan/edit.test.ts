import { describe, expect, it } from 'vitest';
import {
  appendLegs,
  canMergeWithNext,
  departureWindow,
  durationAnchor,
  legBounds,
  mergeWithNext,
  planPlaces,
  renamePlace,
  setLegDuration,
  setLegEnd,
  setLegPath,
  setLegStart,
  startsAtAnchor,
  switchMoved,
  tidyName,
  withName,
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

  it('says so when the end it keeps had to move', () => {
    const later = ok(setLegPath(screenshot, 'walk', 'walk', route(25)));
    expect(switchMoved(screenshot, later, 'walk')).toBe(
      'Walking takes 25 min, so it now leaves at 8:22 AM.',
    );
    // Keeping the departure, only the arrival moves, as it would for any change of duration.
    const bike = ok(setLegPath(screenshot, 'walk', 'bike', route(6)));
    expect(switchMoved(screenshot, bike, 'walk')).toBeNull();
  });

  it('backwards, says when the arrival it keeps had to move', () => {
    // Planned from its arrival at 08:35, after a wait you added until 08:20 and before the
    // 08:52 ride. Cycling 20 min can't keep that arrival without leaving before 08:20.
    const coffee = leg('coffee', 'wait', HOME, '08:00', HOME, '08:20', { fixed: 'end' });
    const toStop = leg('to', 'walk', HOME, '08:25', VIENNA, '08:35', { fixed: 'end' });
    const plan = appendLegs({ anchor: coffee.start, legs: [] }, [coffee, toStop, ride]);
    expect(durationAnchor(plan, 'to')).toBe('end');
    const bike = ok(setLegPath(plan, 'to', 'bike', route(20)));
    expect(times(bike, 'to')).toEqual([t('08:25'), t('08:45')]);
    expect(switchMoved(plan, bike, 'to')).toBe(
      'Cycling takes 20 min, so it now arrives at 8:45 AM.',
    );
    const quick = ok(setLegPath(plan, 'to', 'bike', route(4)));
    expect(switchMoved(plan, quick, 'to')).toBeNull();
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

  it('marks a name you gave as yours, and an empty one as no name', () => {
    const plan = renamePlace(screenshot, VIENNA, 'Vienna LRT');
    expect(plan.legs[0].end.place).toEqual({ ...VIENNA, name: 'Vienna LRT', named: true });
    const cleared = renamePlace(plan, VIENNA, '');
    expect(cleared.legs[0].end.place).toEqual({ ...VIENNA, name: '' });
    expect(withName(HOME, '  ')).toEqual({ ...HOME, name: '  ' });
  });

  it('takes spaces you cannot see as no change to a name', () => {
    // As typed in a field, and as some stops are named in the 511 feed.
    expect(tidyName(' Home ')).toBe('Home');
    expect(tidyName('Market St & 5th  St')).toBe('Market St & 5th St');
    expect(tidyName('Blue\n\u00a0Bottle')).toBe('Blue Bottle');
    expect(tidyName('   ')).toBe('');
  });
});

describe('where the plan was started from', () => {
  it('is the start of a plan planned forwards from it', () => {
    expect(startsAtAnchor(screenshot)).toBe(true);
    expect(startsAtAnchor({ anchor: walk.start, legs: [] })).toBe(true);
  });

  it('is not once legs come before it, or its first legs have gone', () => {
    const cafe = leg('cafe', 'walk', CAFE, '08:10', HOME, '08:30', { fixed: 'end' });
    expect(startsAtAnchor({ ...screenshot, legs: [cafe, ...screenshot.legs] })).toBe(false);
    expect(startsAtAnchor({ ...screenshot, legs: [ride] })).toBe(false);
  });

  it('is still after the start has been renamed', () => {
    expect(startsAtAnchor(renamePlace(screenshot, HOME, 'My place'))).toBe(true);
  });
});

describe('merging two legs of the same kind', () => {
  const PARK: Place = { lat: 37.335, lon: -121.885, name: 'Park' };
  const path = (geometry: [number, number][], extra: Partial<PathInfo> = {}): PathInfo => ({
    provider: 'valhalla',
    distanceM: 500,
    routedDurationS: 360,
    geometry,
    ...extra,
  });
  // Home to the park, then on to the station, then the train.
  const toPark = leg('toPark', 'walk', HOME, '08:30', PARK, '08:37', {
    fixed: 'start',
    path: path([[-121.88, 37.33], [-121.885, 37.335]]),
  });
  const onward = leg('onward', 'walk', PARK, '08:37', VIENNA, '08:45', {
    fixed: 'start',
    path: path([[-121.885, 37.335], [-121.89, 37.34]], { distanceM: 700, routedDurationS: 480 }),
  });
  const walks = appendLegs({ anchor: toPark.start, legs: [] }, [toPark, onward, ride]);

  it('joins two walks as they are: same times, both routes, and the middle place drops out', () => {
    expect(canMergeWithNext(walks, 'toPark')).toBe(true);
    const plan = ok(mergeWithNext(walks, 'toPark'));
    expect(plan.legs.map((l) => [l.id, l.mode])).toEqual([
      ['toPark', 'walk'],
      ['wait-after-toPark', 'wait'],
      ['ride', 'transit'],
    ]);
    const merged = plan.legs[0];
    expect(merged).toMatchObject({ start: toPark.start, end: onward.end, fixed: 'start' });
    expect(merged.path).toEqual({
      provider: 'valhalla',
      distanceM: 1200,
      routedDurationS: 840,
      geometry: [
        [-121.88, 37.33],
        [-121.885, 37.335],
        [-121.89, 37.34],
      ],
    });
    expect(times(plan, 'ride')).toEqual(times(walks, 'ride'));
    expect(planPlaces(plan).map((p) => p.name)).toEqual([
      'Home',
      'Vienna Station',
      'Milpitas Station',
    ]);
  });

  it('joins hill profiles end to end, and drops one it can only have in part', () => {
    const heights = (heightsM: number[]) => ({ elevation: { intervalM: 30, heightsM } });
    const climb = path([[-121.88, 37.33]], heights([10, 25, 40]));
    const descent = path([[-121.885, 37.335]], heights([40, 20]));
    const ride1 = { ...toPark, mode: 'bike' as const, path: climb };
    const ride2 = { ...onward, mode: 'bike' as const, path: descent };
    const rides = appendLegs({ anchor: ride1.start, legs: [] }, [ride1, ride2]);
    expect(ok(mergeWithNext(rides, 'toPark')).legs[0].path?.elevation).toEqual({
      intervalM: 30,
      heightsM: [10, 25, 40, 20],
    });

    const estimated = {
      ...ride2,
      path: { ...descent, provider: 'estimate', elevation: undefined },
    };
    const mixed = appendLegs({ anchor: ride1.start, legs: [] }, [ride1, estimated]);
    const merged = ok(mergeWithNext(mixed, 'toPark')).legs[0].path;
    expect(merged?.elevation).toBeUndefined();
    expect(merged?.provider).toBe('estimate');
  });

  it('merges a wait you added with the automatic one after it, into one wait you own', () => {
    // Off the train at 9:17, coffee until 9:30, then waiting for a 9:50 departure.
    const coffee = leg('coffee', 'wait', MILPITAS, '09:17', MILPITAS, '09:30', { fixed: 'start' });
    const back = leg('back', 'transit', MILPITAS, '09:50', VIENNA, '10:15');
    const plan = appendLegs({ anchor: ride.start, legs: [] }, [ride, coffee, back]);
    expect(plan.legs.map((l) => l.id)).toEqual(['ride', 'coffee', 'wait-after-coffee', 'back']);
    expect(canMergeWithNext(plan, 'coffee')).toBe(true);
    const merged = ok(mergeWithNext(plan, 'coffee'));
    expect(merged.legs.map((l) => l.id)).toEqual(['ride', 'coffee', 'back']);
    expect(merged.legs[1]).toMatchObject({ mode: 'wait', fixed: 'start' });
    expect(merged.legs[1].auto).toBeUndefined();
    expect(times(merged, 'coffee')).toEqual([t('09:17'), t('09:50')]);
  });

  it('keeps the wait you added, and its place, when the automatic one comes first', () => {
    // Planned backwards: a 20 min wait at the office, 40 m from the station, before a 10:00
    // meeting. The automatic wait sits at the station, where the ride ends.
    const OFFICE: Place = { lat: 37.41036, lon: -121.89, name: 'Office' };
    const meet = leg('meet', 'wait', OFFICE, '09:40', OFFICE, '10:00', { fixed: 'end' });
    const plan = appendLegs({ anchor: ride.start, legs: [] }, [ride, meet]);
    expect(plan.legs.map((l) => l.id)).toEqual(['ride', 'wait-after-ride', 'meet']);
    expect(canMergeWithNext(plan, 'wait-after-ride')).toBe(true);
    const merged = ok(mergeWithNext(plan, 'wait-after-ride'));
    expect(merged.legs.map((l) => l.id)).toEqual(['ride', 'meet']);
    expect(merged.legs[1]).toMatchObject({
      fixed: 'end',
      start: { place: OFFICE, time: ride.end.time },
      end: { place: OFFICE, time: t('10:00') },
    });
  });

  it('merges nothing when the leg after it is no longer the one the button was for', () => {
    // Three walks: a double click on the first button must not swallow the third walk too.
    const third = leg('third', 'walk', VIENNA, '08:45', VIENNA, '08:46', { fixed: 'start' });
    const three = appendLegs({ anchor: toPark.start, legs: [] }, [toPark, onward, third]);
    const once = ok(mergeWithNext(three, 'toPark', 'onward'));
    expect(once.legs.map((l) => l.id)).toEqual(['toPark', 'third']);
    expect(mergeWithNext(once, 'toPark', 'onward')).toEqual({
      ok: false,
      reason: 'Those legs have changed, so nothing was merged.',
    });
    // Asked for on purpose, the next pair still merges.
    expect(ok(mergeWithNext(once, 'toPark', 'third')).legs.map((l) => l.id)).toEqual(['toPark']);
  });

  it('only offers two legs of the same kind that meet', () => {
    const bikeOn = { ...onward, mode: 'bike' as const };
    const mixed = appendLegs({ anchor: toPark.start, legs: [] }, [toPark, bikeOn]);
    expect(canMergeWithNext(mixed, 'toPark')).toBe(false);
    expect(mergeWithNext(mixed, 'toPark')).toEqual({
      ok: false,
      reason: 'Only two walks, two bike rides or two waits that meet can be merged.',
    });

    const rides = appendLegs({ anchor: ride.start, legs: [] }, [
      ride,
      leg('ride2', 'transit', MILPITAS, '09:17', VIENNA, '09:40'),
    ]);
    expect(canMergeWithNext(rides, 'ride')).toBe(false);
    expect(canMergeWithNext(walks, 'ride')).toBe(false); // nothing after the last leg
    expect(canMergeWithNext(walks, 'onward')).toBe(false); // a wait, then the ride

    const apart = { ...onward, start: { ...onward.start, place: CAFE } };
    const gap = appendLegs({ anchor: toPark.start, legs: [] }, [toPark, apart]);
    expect(canMergeWithNext(gap, 'toPark')).toBe(false);
  });
});
