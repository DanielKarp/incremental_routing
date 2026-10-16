import { describe, expect, it } from 'vitest';
import { appendLegs } from './plan/plan';
import type { Leg, Place, Plan } from './plan/types';
import { timesHint } from './timesHint';

// Times are Bay Area local (PDT, UTC-7), as the hints show them.
const t = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(2026, 9, 12, h + 7, m)).toISOString();
};

const HOME: Place = { lat: 37.33, lon: -121.88, name: 'Home' };
const STATION: Place = { lat: 37.34, lon: -121.89, name: 'Station', stopId: 'vta:1' };
const CITY: Place = { lat: 37.41, lon: -121.89, name: 'City', stopId: 'vta:2' };
const CAFE: Place = { lat: 37.42, lon: -121.9, name: 'Cafe' };

function leg(
  id: string,
  mode: Leg['mode'],
  from: Place,
  start: string,
  to: Place,
  end: string,
  fixed: Leg['fixed'] = 'start',
): Leg {
  const l: Leg = {
    id,
    mode,
    start: { place: from, time: t(start) },
    end: { place: to, time: t(end) },
  };
  return mode === 'transit' ? l : { ...l, fixed };
}

const planOf = (...legs: Leg[]): Plan => appendLegs({ anchor: legs[0].start, legs: [] }, legs);
// Hints use a narrow no-break space before AM with newer ICU.
const hintOf = (plan: Plan, id: string) => timesHint(plan, id).replace(/\s/g, ' ');

describe('what the times of a walk, bike or wait leg can do', () => {
  it('says when a walk can leave, between the legs around it', () => {
    const plan = planOf(
      leg('ride1', 'transit', CITY, '08:00', STATION, '08:20'),
      leg('wait', 'wait', STATION, '08:20', STATION, '08:25'),
      leg('walk', 'walk', STATION, '08:30', CAFE, '08:40'),
      leg('ride2', 'transit', CAFE, '08:50', CITY, '09:10'),
    );
    expect(hintOf(plan, 'walk')).toBe(
      'Can leave 8:25 AM–8:40 AM · up to 20 min, keeping the departure',
    );
  });

  it("says when it can't move without changing its length", () => {
    const plan = planOf(
      leg('walk', 'walk', HOME, '09:00', CAFE, '09:06'),
      leg('wait', 'wait', CAFE, '09:06', CAFE, '09:16'),
      leg('bike', 'bike', CAFE, '09:16', HOME, '09:20'),
    );
    expect(hintOf(plan, 'wait')).toBe(
      "Can't move without changing its length · up to 10 min, keeping the start",
    );
  });

  it('a wait starts and ends rather than leaving and arriving', () => {
    const plan = planOf(
      leg('wait', 'wait', HOME, '08:00', HOME, '08:10', 'end'),
      leg('walk', 'walk', HOME, '08:20', CAFE, '08:30'),
    );
    expect(hintOf(plan, 'wait')).toBe('Start by 8:10 AM · any length, keeping the end');
    const beforeRide = planOf(
      leg('wait', 'wait', STATION, '08:00', STATION, '08:10', 'end'),
      leg('ride', 'transit', STATION, '08:10', CITY, '08:30'),
    );
    expect(hintOf(beforeRide, 'wait')).toBe(
      'Ends as the ride leaves · any length, keeping the end',
    );
  });

  it('says which end meets a ride', () => {
    const plan = planOf(
      leg('ride', 'transit', CITY, '08:00', STATION, '08:20'),
      leg('walk', 'walk', STATION, '08:20', CAFE, '08:30'),
      leg('coffee', 'wait', CAFE, '08:45', CAFE, '09:00'),
    );
    expect(hintOf(plan, 'walk')).toBe(
      'Leaves as the ride arrives · up to 25 min, keeping the departure',
    );
  });

  it('a walk at the open end of the plan can leave from the leg before', () => {
    const plan = planOf(
      leg('coffee', 'wait', CAFE, '08:45', CAFE, '09:00'),
      leg('walk', 'walk', CAFE, '09:05', HOME, '09:20'),
    );
    expect(hintOf(plan, 'walk')).toBe(
      'Leave at 9:00 AM or later · any length, keeping the departure',
    );
    expect(hintOf(planOf(leg('alone', 'bike', HOME, '09:00', CAFE, '09:10')), 'alone')).toBe(
      'Any length, keeping the departure',
    );
  });
});
